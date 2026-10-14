// @effect-diagnostics nodeBuiltinImport:off -- test hashes and modes bind real filesystem artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath), readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { Mission } from "../../../../packages/contracts/src/mission.ts";
import type { PreparedRotationIntent } from "./MissionManagerRotation.ts";
import * as Artifacts from "./MissionManagerHandoffArtifacts.ts";
import { MissionManagerTransferStoreError } from "./MissionManagerTransferStore.ts";
import {
  buildManagerHandoffSnapshot,
  type BuildManagerHandoffInput,
  type BuildManagerHandoffResult,
} from "./MissionManagerHandoff.ts";

const sha = (bytes: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const OCCURRED_AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (overrides: Record<string, unknown> = {}) =>
  decodeMission({
    schemaVersion: 1,
    id: "mission-1",
    revision: 4,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d",
        ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      },
    ],
    intent: {
      outcome: "Ship the opt-in mission aggregate.",
      scope: ["contracts"],
      exclusions: ["persistence"],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }],
      decisions: [{ id: "dec-1", text: "Council secret wording.", authority: { ...AUTHORITY } }],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: {
      delivery: { threadId: "thread-delivery", epoch: 3 },
      retro: { threadId: "thread-retro", epoch: 1 },
    },
    status: "active",
    tasks: [
      {
        id: "task-a",
        projectId: "project-1",
        title: "First task",
        specHash: "hash-a",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: OCCURRED_AT,
      },
    ],
    updatedAt: OCCURRED_AT,
    ...overrides,
  });

const intentFixture = (overrides: Partial<PreparedRotationIntent> = {}): PreparedRotationIntent => ({
  missionId: "mission-1",
  observedRevision: 4,
  role: "delivery",
  currentThreadId: "thread-delivery",
  currentEpoch: 3,
  timezone: "America/Denver",
  localDate: "2026-10-14",
  ordinal: 0,
  reason: "first_slot",
  ...overrides,
});

const inputFixture = (overrides: Partial<BuildManagerHandoffInput> = {}): BuildManagerHandoffInput => ({
  mission: missionFixture(),
  intent: intentFixture(),
  ...overrides,
});

const mustOk = (result: BuildManagerHandoffResult) => {
  assert(result.ok === true, `expected ok, got ${JSON.stringify(result)}`);
  return result;
};

const failCategory = (error: unknown): string => {
  assert.instanceOf(error, MissionManagerTransferStoreError);
  return error.category;
};

const failWith = <A>(effect: Effect.Effect<A, MissionManagerTransferStoreError>) =>
  Effect.flip(effect);

it.effect("stage persists exact builder bytes and reads back complete bytes with recomputed SHA", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-roundtrip-" });
      const expected = mustOk(buildManagerHandoffSnapshot(inputFixture()));
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      assert.strictEqual(staged.artifactRef, `manager-handoff:${expected.sha256Hex}`);
      assert.strictEqual(staged.artifactSha, expected.sha256Hex);
      assert.strictEqual(staged.byteCount, expected.bytes.length);
      assert.isFalse(staged.reused);
      assert.strictEqual(staged.prepared.namespace, "manager-handoff");
      assert.strictEqual(staged.prepared.schemaVersion, 1);
      assert.strictEqual(staged.prepared.missionRef, "mission-1");
      const path = NodePath.join(dir, "manager-handoff", `${expected.sha256Hex}.json`);
      const stored = yield* Effect.promise(() => NodeFSP.readFile(path));
      assert.strictEqual(Buffer.compare(stored, Buffer.from(expected.bytes)), 0);
      assert.strictEqual(sha(stored), expected.sha256Hex);
      const read = yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: staged.artifactRef,
      });
      assert.strictEqual(read.sha256Hex, expected.sha256Hex);
      assert.strictEqual(Buffer.compare(Buffer.from(read.bytes), Buffer.from(expected.bytes)), 0);
      // Content is pointer metadata only; no raw source wording is stored.
      assert.notInclude(read.text, "Council secret wording.");
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o777, 0o600);
    }),
  ),
);

it.effect("read returns fresh owned buffers and mutation does not corrupt the stored file", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-owned-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const first = yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: staged.artifactRef,
      });
      assert.notStrictEqual(first.bytes.buffer, (yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: staged.artifactRef,
      })).bytes.buffer);
      first.bytes.fill(0);
      const second = yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: staged.artifactRef,
      });
      assert.strictEqual(sha(Buffer.from(second.bytes)), staged.artifactSha);
    }),
  ),
);

it.effect("staging the same canonical input twice reuses the file without overwriting", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-idem-" });
      const first = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${first.artifactSha}.json`);
      const before = yield* Effect.promise(() => NodeFSP.stat(path));
      const second = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      assert.isTrue(second.reused);
      assert.strictEqual(second.artifactRef, first.artifactRef);
      const after = yield* Effect.promise(() => NodeFSP.stat(path));
      assert.strictEqual(after.ino, before.ino);
      const parallel = yield* Effect.all(
        Array.from(
          { length: 8 },
          () => Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() }),
        ),
        { concurrency: 8 },
      );
      for (const staged of parallel) {
        assert.strictEqual(staged.artifactRef, first.artifactRef);
        assert.isTrue(staged.reused);
      }
      const read = yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: first.artifactRef,
      });
      assert.strictEqual(read.sha256Hex, first.artifactSha);
    }),
  ),
);

it.effect("changed canonical input stages under a different ref", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-distinct-" });
      const first = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const second = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture({ intent: intentFixture({ ordinal: 1, reason: "context_pressure" }) }),
      });
      assert.notStrictEqual(second.artifactRef, first.artifactRef);
      assert.isFalse(second.reused);
      assert.strictEqual(
        (yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: first.artifactRef }))
          .sha256Hex,
        first.artifactSha,
      );
      assert.strictEqual(
        (yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: second.artifactRef }))
          .sha256Hex,
        second.artifactSha,
      );
    }),
  ),
);

it.effect("builder rejections deny staging and leave no partial files", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-reject-" });
      const stale = yield* failWith(
        Artifacts.stageManagerHandoffArtifact({
          artifactDirectory: dir,
          input: inputFixture({ intent: intentFixture({ ordinal: 9 }) }),
        }),
      );
      assert.strictEqual(failCategory(stale), "request_conflict");
      const inactive = yield* failWith(
        Artifacts.stageManagerHandoffArtifact({
          artifactDirectory: dir,
          input: inputFixture({ mission: missionFixture({ status: "paused" }) }),
        }),
      );
      assert.strictEqual(failCategory(inactive), "request_conflict");
      const overflow = yield* failWith(
        Artifacts.stageManagerHandoffArtifact({
          artifactDirectory: dir,
          input: inputFixture({
            blockers: Array.from({ length: 17 }, (_, index) => ({ id: `blocker-${index}` })),
          }),
        }),
      );
      assert.strictEqual(failCategory(overflow), "request_conflict");
      assert.isFalse(yield* fs.exists(NodePath.join(dir, "manager-handoff")));
    }),
  ),
);

it.effect("malformed refs and missing config are denied without touching the filesystem", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-malformed-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const badRefs = [
        "retro-original:" + staged.artifactSha,
        `manager-handoff:${staged.artifactSha.toUpperCase()}`,
        "manager-handoff:abc",
        `manager-handoff:${staged.artifactSha}/../escape`,
        `manager-handoff:${staged.artifactSha} `,
        "",
        "manager-handoff:",
      ];
      for (const ref of badRefs) {
        const failure = yield* failWith(
          Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref }),
        );
        assert.strictEqual(failCategory(failure), "request_conflict");
      }
      const relative = yield* failWith(
        Artifacts.stageManagerHandoffArtifact({ artifactDirectory: "relative/path", input: inputFixture() }),
      );
      assert.strictEqual(failCategory(relative), "scope_denied");
      const empty = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: "", ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(empty), "scope_denied");
    }),
  ),
);

it.effect("a corrupted committed file denies reads and is preserved", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-corrupt-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
      const corrupted = Buffer.from("tampered-by-another-writer", "utf8");
      yield* Effect.promise(() => NodeFSP.writeFile(path, corrupted, { mode: 0o600 }));
      const failure = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(failure), "persistence");
      assert.strictEqual(
        Buffer.compare(yield* Effect.promise(() => NodeFSP.readFile(path)), corrupted),
        0,
      );
      const nonUtf8 = Buffer.from([0xc3, 0x28]);
      yield* Effect.promise(() => NodeFSP.writeFile(path, nonUtf8, { mode: 0o600 }));
      const utf8Failure = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(utf8Failure), "persistence");
      assert.strictEqual(
        Buffer.compare(yield* Effect.promise(() => NodeFSP.readFile(path)), nonUtf8),
        0,
      );
    }),
  ),
);

it.effect("a wrongly-permissioned file denies reads without chmod and is preserved", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-mode-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
      const original = yield* Effect.promise(() => NodeFSP.readFile(path));
      yield* Effect.promise(() => NodeFSP.chmod(path, 0o644));
      const failure = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(failure), "persistence");
      // The layer never repairs insecurity by chmod; the file is untouched.
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o777, 0o644);
      assert.strictEqual(
        Buffer.compare(yield* Effect.promise(() => NodeFSP.readFile(path)), original),
        0,
      );
    }),
  ),
);

it.effect("a symlink destination denies reads and preserves the link", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-symlink-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
      const elsewhere = NodePath.join(dir, "elsewhere.json");
      yield* Effect.promise(() => NodeFSP.writeFile(elsewhere, "foreign", { mode: 0o600 }));
      yield* Effect.promise(() => NodeFSP.rename(path, `${path}.bak`));
      yield* Effect.promise(() => NodeFSP.symlink(elsewhere, path));
      const failure = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(failure), "persistence");
      assert.isTrue((yield* Effect.promise(() => NodeFSP.lstat(path))).isSymbolicLink());
    }),
  ),
);

it.effect("a non-regular directory at the destination denies reads", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-ns-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
      yield* Effect.promise(() => NodeFSP.rename(path, `${path}.bak`));
      yield* Effect.promise(() => NodeFSP.mkdir(path, { mode: 0o700 }));
      const failure = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(failure), "persistence");
      assert.isTrue((yield* Effect.promise(() => NodeFSP.stat(path))).isDirectory());
    }),
  ),
);

it.effect("a permissive existing root denies staging without chmod", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-permissive-" });
      yield* Effect.promise(() => NodeFSP.chmod(dir, 0o755));
      const failure = yield* failWith(
        Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() }),
      );
      assert.strictEqual(failCategory(failure), "persistence");
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(dir))).mode & 0o777, 0o755);
      assert.isFalse(yield* fs.exists(NodePath.join(dir, "manager-handoff")));
    }),
  ),
);

it.effect("a symlinked root denies staging and reading", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-rootlink-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const alias = `${dir}-alias`;
      yield* Effect.promise(() => NodeFSP.symlink(dir, alias));
      try {
        const stageFailure = yield* failWith(
          Artifacts.stageManagerHandoffArtifact({ artifactDirectory: alias, input: inputFixture() }),
        );
        assert.strictEqual(failCategory(stageFailure), "persistence");
        const readFailure = yield* failWith(
          Artifacts.readManagerHandoffArtifact({ artifactDirectory: alias, ref: staged.artifactRef }),
        );
        assert.strictEqual(failCategory(readFailure), "persistence");
      } finally {
        yield* Effect.promise(() => NodeFSP.unlink(alias)).pipe(Effect.ignore);
      }
    }),
  ),
);

it.effect("a failed stage never deletes a valid artifact and leaves no owned temps", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-failclosed-" });
      const valid = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const namespace = NodePath.join(dir, "manager-handoff");
      const backup = `${namespace}.bak`;
      yield* Effect.promise(() => NodeFSP.rename(namespace, backup));
      // A stray file where the namespace directory belongs breaks staging.
      yield* Effect.promise(() => NodeFSP.writeFile(namespace, "stray", { mode: 0o600 }));
      try {
        const failure = yield* failWith(
          Artifacts.stageManagerHandoffArtifact({
            artifactDirectory: dir,
            input: inputFixture({ intent: intentFixture({ ordinal: 2, reason: "context_pressure" }) }),
          }),
        );
        assert.strictEqual(failCategory(failure), "persistence");
        const leftovers = (yield* Effect.promise(() => NodeFSP.readdir(dir))).filter((entry) =>
          entry.startsWith(".tmp-"),
        );
        assert.deepStrictEqual(leftovers, []);
      } finally {
        yield* Effect.promise(() => NodeFSP.unlink(namespace)).pipe(Effect.ignore);
        yield* Effect.promise(() => NodeFSP.rename(backup, namespace)).pipe(Effect.ignore);
      }
      const reread = yield* Artifacts.readManagerHandoffArtifact({
        artifactDirectory: dir,
        ref: valid.artifactRef,
      });
      assert.strictEqual(reread.sha256Hex, valid.artifactSha);
    }),
  ),
);

it.effect("renamed files and swapped roots deny reads instead of serving stale bytes", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-drift-" });
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
      yield* Effect.promise(() => NodeFSP.rename(path, `${path}.moved`));
      const moved = yield* failWith(
        Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
      );
      assert.strictEqual(failCategory(moved), "persistence");
      yield* Effect.promise(() => NodeFSP.rename(`${path}.moved`, path));
      // Swap the whole root for a fresh empty directory at the same path.
      const kept = `${dir}.kept`;
      yield* Effect.promise(() => NodeFSP.rename(dir, kept));
      yield* Effect.promise(() => NodeFSP.mkdir(dir, { mode: 0o700 }));
      try {
        const swapped = yield* failWith(
          Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }),
        );
        assert.strictEqual(failCategory(swapped), "persistence");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })).pipe(
          Effect.ignore,
        );
        yield* Effect.promise(() => NodeFSP.rename(kept, dir)).pipe(Effect.ignore);
      }
      assert.strictEqual(
        (yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }))
          .sha256Hex,
        staged.artifactSha,
      );
    }),
  ),
);

it.effect("the filesystem port layer reads exact bytes through the accepted port", () =>
  scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-artifacts-port-" });
      const expected = mustOk(buildManagerHandoffSnapshot(inputFixture()));
      const staged = yield* Artifacts.stageManagerHandoffArtifact({
        artifactDirectory: dir,
        input: inputFixture(),
      });
      const port = yield* Artifacts.makeManagerHandoffArtifactPort(dir);
      const bytes = yield* port.readArtifact(staged.artifactRef);
      assert.strictEqual(sha(Buffer.from(bytes)), expected.sha256Hex);
      assert.strictEqual(Buffer.compare(Buffer.from(bytes), Buffer.from(expected.bytes)), 0);
      const service = yield* Artifacts.MissionManagerHandoffArtifactPort.pipe(
        Effect.provide(Artifacts.layerFilesystemManagerHandoffArtifactPort(dir)),
      );
      const throughLayer = yield* service.readArtifact(staged.artifactRef);
      assert.strictEqual(sha(Buffer.from(throughLayer)), expected.sha256Hex);
      const missing = yield* Layer.build(Artifacts.layerMissingHandoffAdapter).pipe(Effect.flip);
      assert.strictEqual(failCategory(missing), "scope_denied");
    }),
  ),
);

it.effect("read denies a leaf inode replaced after the opened bytes were read", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-root-leaf-race-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const actual = yield* Effect.promise(() => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"));
    const root = yield* Effect.promise(() => actual.realpath(dir));
    const path = NodePath.join(root, "manager-handoff", `${staged.artifactSha}.json`);
    let swapped = false;
    vi.mocked(NodeFSP.realpath).mockImplementation((async (target: string) => {
      if (target === path && !swapped) {
        swapped = true;
        await actual.rename(path, `${path}.old`);
        await actual.writeFile(path, "replacement", { mode: 0o600 });
      }
      return actual.realpath(target);
    }) as typeof NodeFSP.realpath);
    try {
      const failure = yield* Effect.flip(Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }));
      assert.strictEqual(failCategory(failure), "persistence");
    } finally { vi.mocked(NodeFSP.realpath).mockImplementation(actual.realpath); }
  })),
);

it.effect("oversize existing file denies stage reuse before bytes are consumed and is preserved", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-oversize-reuse-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const path = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
    const oversized = Buffer.alloc(Artifacts.MAX_MANAGER_HANDOFF_ARTIFACT_BYTES + 1, 0x61);
    yield* Effect.promise(() => NodeFSP.writeFile(path, oversized, { mode: 0o600 }));
    vi.mocked(NodeFSP.readFile).mockClear();
    const failure = yield* Effect.flip(Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() }));
    assert.strictEqual(failCategory(failure), "persistence");
    assert.strictEqual(vi.mocked(NodeFSP.readFile).mock.calls.length, 0);
    assert.strictEqual(Buffer.compare(yield* Effect.promise(() => NodeFSP.readFile(path)), oversized), 0);
  })),
);

it.effect("read denies namespace permissions revoked while consuming bytes", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-ns-mode-race-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const actual = yield* Effect.promise(() => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"));
    const root = yield* Effect.promise(() => actual.realpath(dir));
    const namespace = NodePath.join(root, "manager-handoff");
    const path = NodePath.join(namespace, `${staged.artifactSha}.json`);
    vi.mocked(NodeFSP.realpath).mockImplementation((async (target: string) => {
      if (target === path) await actual.chmod(namespace, 0o755);
      return actual.realpath(target);
    }) as typeof NodeFSP.realpath);
    try {
      const failure = yield* Effect.flip(Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }));
      assert.strictEqual(failCategory(failure), "persistence");
    } finally { vi.mocked(NodeFSP.realpath).mockImplementation(actual.realpath); }
  })),
);

it.effect("read denies namespace replacement while consuming bytes", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-ns-swap-race-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const actual = yield* Effect.promise(() => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"));
    const root = yield* Effect.promise(() => actual.realpath(dir));
    const namespace = NodePath.join(root, "manager-handoff");
    const path = NodePath.join(namespace, `${staged.artifactSha}.json`);
    let swapped = false;
    vi.mocked(NodeFSP.realpath).mockImplementation((async (target: string) => {
      if (target === path && !swapped) {
        swapped = true;
        await actual.rename(namespace, `${namespace}.old`);
        await actual.mkdir(namespace, { mode: 0o700 });
      }
      return actual.realpath(target);
    }) as typeof NodeFSP.realpath);
    try {
      const failure = yield* Effect.flip(Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }));
      assert.strictEqual(failCategory(failure), "persistence");
    } finally { vi.mocked(NodeFSP.realpath).mockImplementation(actual.realpath); }
  })),
);

it.effect("read denies root permissions revoked while consuming bytes", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-root-mode-race-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const actual = yield* Effect.promise(() => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"));
    const root = yield* Effect.promise(() => actual.realpath(dir));
    const path = NodePath.join(root, "manager-handoff", `${staged.artifactSha}.json`);
    vi.mocked(NodeFSP.realpath).mockImplementation((async (target: string) => {
      if (target === path) await actual.chmod(root, 0o755);
      return actual.realpath(target);
    }) as typeof NodeFSP.realpath);
    try {
      const failure = yield* Effect.flip(Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }));
      assert.strictEqual(failCategory(failure), "persistence");
    } finally { vi.mocked(NodeFSP.realpath).mockImplementation(actual.realpath); }
  })),
);


it.effect("a file growing after fstat never consumes more than the bounded byte window", () =>
  scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-grow-bounded-" });
    const staged = yield* Artifacts.stageManagerHandoffArtifact({ artifactDirectory: dir, input: inputFixture() });
    const actual = yield* Effect.promise(() => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"));
    const root = yield* Effect.promise(() => actual.realpath(dir));
    const path = NodePath.join(root, "manager-handoff", `${staged.artifactSha}.json`);
    let consumed = 0;
    let grown = false;
    const grow = async () => {
      if (!grown) { grown = true; await actual.writeFile(path, Buffer.alloc(128 * 1024), { mode: 0o600 }); }
    };
    vi.mocked(NodeFSP.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === path) {
        const originalRead = handle.read.bind(handle);
        const originalReadFile = handle.readFile.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          await grow();
          const result = await originalRead(...readArgs);
          consumed += result.bytesRead;
          return result;
        }) as typeof handle.read;
        handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
          await grow();
          const result = await originalReadFile(...readArgs);
          consumed += Buffer.byteLength(result);
          return result;
        }) as typeof handle.readFile;
      }
      return handle;
    });
    try {
      const failure = yield* Effect.flip(Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef }));
      assert.strictEqual(failCategory(failure), "persistence");
      assert.isTrue(grown);
      assert.isAtMost(consumed, Artifacts.MAX_MANAGER_HANDOFF_ARTIFACT_BYTES + 1);
    } finally { vi.mocked(NodeFSP.open).mockImplementation(actual.open); }
  })),
);
