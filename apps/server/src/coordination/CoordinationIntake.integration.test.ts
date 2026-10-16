import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ProjectId,
  ThreadId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as Preview from "../preview/Manager.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Board from "./CoordinationService.ts";
import * as Intake from "./CoordinationIntake.ts";

const projectId = ProjectId.make("project:attachments");
const sender = ThreadId.make("thread:sender");
const recipient = ThreadId.make("thread:recipient");
const foreignProject = ProjectId.make("project:foreign");
const foreignThread = ThreadId.make("thread:foreign");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = Layer.merge(
  Intake.layer,
  Cleanup.layer.pipe(
    Layer.provide(
      Layer.merge(Layer.mock(Preview.PreviewManager)({}), Layer.mock(Terminal.TerminalManager)({})),
    ),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Board.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-coordination-intake-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, foreignProject]) {
    yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${id},${id},${`/tmp/${id}`},'[]','2026-01-01','2026-01-01')`;
  }
  for (const [id, project] of [
    [sender, projectId],
    [recipient, projectId],
    [foreignThread, foreignProject],
  ] as const) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES (${id},${project},${id},'codex','full-access','default','2026-01-01','2026-01-01','{"settledAt":null}')`;
  }
});

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const stage = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const id = ChatAttachmentId.make(createPendingAttachmentId(".png"));
  const pendingPath = path.join(config.attachmentsDir, `${id}.png`);
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  yield* fs.writeFile(pendingPath, bytes);
  const attachment: ChatAttachment = {
    id,
    type: "image",
    name: "output.png",
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
  };
  return { attachment, pendingPath };
});

const post = (key: string) => ({
  commandId: CommandId.make(key),
  projectId,
  senderThreadId: sender,
  targetThreadId: recipient,
  topic: "Review output",
  kind: "request" as const,
  text: "Please inspect the attached output.",
  createdBy: "agent" as const,
});

it.effect(
  "thread cleanup preserves shared and migrated board files, including coalesced history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const intake = yield* Intake.CoordinationIntake;
      const board = yield* Board.CoordinationService;
      const cleanup = yield* Cleanup.ResourceCleanupService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const pending = yield* Effect.all([stage, stage, stage]);
      const claimed = yield* Claims.claimPendingAttachments({
        threadId: sender,
        attachments: pending.map(({ attachment }) => attachment),
      });
      const [shared, migrated, unreferenced] = claimed.attachments;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('source',${sender},NULL,NULL,'user',0,'2026-01-01','2026-01-01',${encodeJson({ attachments: claimed.attachments })})`;
      const forwarded = yield* intake.post({
        ...post("shared"),
        kind: "update",
        attachments: [shared!],
      });
      // Retirement uses trusted historical metadata without claiming another copy.
      yield* board.post({
        ...post("migrated"),
        topic: "Migrated",
        kind: "update",
        attachments: [migrated!],
      });
      // Old receipts still reference this upload after the current update changes.
      yield* intake.post({ ...post("new-status"), kind: "update", attachments: [] });
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-01-02' WHERE thread_id=${sender}`;
      yield* cleanup.cleanupAttachments(claimed.attachments.map((attachment) => attachment.id));
      assert.deepEqual(Array.from(yield* fs.readFile(claimed.claimedPaths[0]!)), Array.from(bytes));
      assert.deepEqual(Array.from(yield* fs.readFile(claimed.claimedPaths[1]!)), Array.from(bytes));
      assert.isFalse(
        yield* fs.exists(
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: unreferenced!,
          })!,
        ),
      );
      assert.deepEqual(forwarded.attachments, [shared!]);
      yield* board.preferences({ projectId, threadId: recipient, paused: true });
      // Project deletion ends board ownership, including uploads retained only
      // by coalesced history. Replaying cleanup is harmless.
      yield* sql`UPDATE projection_projects SET deleted_at='2026-01-02' WHERE project_id=${projectId}`;
      yield* cleanup.cleanupProjectCoordination(projectId);
      yield* cleanup.cleanupProjectCoordination(projectId);
      for (const claimedPath of claimed.claimedPaths) assert.isFalse(yield* fs.exists(claimedPath));
      assert.deepEqual(yield* sql`SELECT entry_id FROM coordination_entries`, []);
      assert.deepEqual(yield* sql`SELECT revision FROM coordination_changes`, []);
      assert.deepEqual(yield* sql`SELECT command_id FROM coordination_receipts`, []);
      assert.deepEqual(yield* sql`SELECT thread_id FROM coordination_preferences`, []);
      assert.deepEqual(yield* sql`SELECT attachment_id FROM coordination_attachments`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains uploaded bytes across retries, cleans failed claims, and restores stored metadata",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const intake = yield* Intake.CoordinationIntake;
      const board = yield* Board.CoordinationService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const pending = yield* stage;
      const input = { ...post("upload"), attachments: [pending.attachment] };
      const accepted = yield* intake.post(input);
      const stored = accepted.attachments[0]!;
      assert.isFalse(Claims.attachmentIsPendingUpload(stored));
      assert.notEqual(stored.id, pending.attachment.id);
      const storedPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: stored,
      });
      assert.isNotNull(storedPath);
      assert.deepEqual(Array.from(yield* fs.readFile(storedPath!)), Array.from(bytes));

      // Receipt lookup must precede upload validation; the retry source is gone.
      yield* fs.remove(pending.pendingPath);
      const files = (yield* fs.readDirectory(config.attachmentsDir)).toSorted();
      assert.deepEqual(yield* intake.post(input), accepted);
      assert.deepEqual((yield* fs.readDirectory(config.attachmentsDir)).toSorted(), files);
      assert.equal((yield* board.read({ projectId })).entries.length, 1);

      yield* board.resolve({
        projectId,
        entryId: accepted.id,
        status: "resolved",
        actorThreadId: sender,
      });
      const rejectedUpload = yield* stage;
      const beforeRejection = (yield* fs.readDirectory(config.attachmentsDir)).toSorted();
      const rejectedInput = {
        ...post("closed-reply"),
        replyToId: accepted.id,
        attachments: [rejectedUpload.attachment],
      };
      // The file claim succeeds, then admission refuses the closed discussion.
      const error = yield* intake.post(rejectedInput).pipe(Effect.flip);
      assert.equal(error.reason, "conflict");
      assert.deepEqual(
        (yield* fs.readDirectory(config.attachmentsDir)).toSorted(),
        beforeRejection,
      );
      assert.deepEqual(
        Array.from(yield* fs.readFile(rejectedUpload.pendingPath)),
        Array.from(bytes),
      );
      assert.isUndefined(yield* board.replay(rejectedInput));

      const reused = yield* intake.post({
        ...post("reuse"),
        topic: "Forward output",
        kind: "update",
        attachments: [{ ...stored, name: "forged.jpg", mimeType: "image/jpeg", sizeBytes: 999 }],
      });
      assert.deepEqual(reused.attachments, [stored]);
      assert.equal(
        resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: reused.attachments[0]!,
        }),
        storedPath,
      );
      assert.deepEqual(
        (yield* fs.readDirectory(config.attachmentsDir)).toSorted(),
        beforeRejection,
      );
      assert.deepEqual(yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`, []);
      assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, []);
      assert.deepEqual(
        yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses an attachment retained by another project's thread and board without new work",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const intake = yield* Intake.CoordinationIntake;
      const board = yield* Board.CoordinationService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const pending = yield* stage;
      const claimed = yield* Claims.claimPendingAttachments({
        threadId: foreignThread,
        attachments: [pending.attachment],
      });
      const foreignAttachment = claimed.attachments[0]!;
      // Seed the original message reference, then admit it to its own board via
      // intake. The attempted cross-project reuse must fail both ownership paths.
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('foreign-source',${foreignThread},NULL,NULL,'user',0,'2026-01-01','2026-01-01',${encodeJson({ attachments: [foreignAttachment] })})`;
      const foreignEntry = yield* intake.post({
        ...post("foreign-board"),
        projectId: foreignProject,
        senderThreadId: foreignThread,
        targetThreadId: foreignThread,
        attachments: [foreignAttachment],
      });
      assert.deepEqual(foreignEntry.attachments, [foreignAttachment]);
      const beforeFiles = (yield* fs.readDirectory(config.attachmentsDir)).toSorted();
      const input = { ...post("forbidden-reuse"), attachments: [foreignAttachment] };
      const error = yield* intake.post(input).pipe(Effect.flip);
      assert.equal(error.reason, "forbidden");
      assert.equal((yield* board.read({ projectId })).entries.length, 0);
      assert.isUndefined(yield* board.replay(input));
      assert.deepEqual((yield* fs.readDirectory(config.attachmentsDir)).toSorted(), beforeFiles);
      assert.deepEqual(Array.from(yield* fs.readFile(claimed.claimedPaths[0]!)), Array.from(bytes));
      assert.deepEqual(yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`, [
        { message_id: "foreign-source" },
      ]);
      assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, []);
      assert.deepEqual(
        yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`,
        [],
      );
      assert.equal((yield* board.read({ projectId: foreignProject })).entries.length, 1);
    }).pipe(Effect.provide(layer)),
);
