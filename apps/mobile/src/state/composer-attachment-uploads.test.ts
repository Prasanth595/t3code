import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type UploadOptions = {
  signal: AbortSignal;
  onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
};
type DraftFault = "decode" | "read" | "write" | null;

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  server: new Map<string, Uint8Array | null>(),
  deleted: [] as string[],
  fault: null as DraftFault,
  outboxWriteFails: false,
  canOperate: true,
  nextId: 0,
  nextUuid: 0,
  mint: Symbol("mint"),
  remove: Symbol("remove"),
  transfer:
    vi.fn<(uri: string, url: string, options: UploadOptions) => Promise<{ status: number }>>(),
  effects: [] as Array<() => void | (() => void)>,
  queueRef: {
    current: null as ReturnType<
      typeof import("../lib/composerAttachmentUploadQueue").createComposerAttachmentUploadQueue
    > | null,
  },
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => native.effects.push(effect),
  useRef: () => native.queueRef,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Parameters<typeof appAtomRegistry.get>[0]) => appAtomRegistry.get(atom),
}));
vi.mock("expo-file-system", () => {
  const uriOf = (parent: string | { uri: string }) =>
    typeof parent === "string" ? parent : parent.uri;
  class Directory {
    readonly uri: string;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = [uriOf(parent), name].filter(Boolean).join("/");
    }
    create() {}
    list() {
      return [...native.files.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => new File(uri));
    }
  }
  class File {
    readonly uri: string;
    readonly name: string;
    readonly parentDirectory: Directory;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = [uriOf(parent), name].filter(Boolean).join("/");
      this.name = this.uri.split("/").at(-1)!;
      this.parentDirectory = new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get exists() {
      return native.files.has(this.uri);
    }
    create() {
      native.files.set(this.uri, new Uint8Array());
    }
    async text() {
      if (native.fault === "read" && this.uri.endsWith("/composer-drafts/drafts.json")) {
        throw new Error("EACCES: drafts.json");
      }
      return Buffer.from(native.files.get(this.uri)!).toString("utf8");
    }
    write(value: string, options?: { encoding?: string }) {
      if (
        (native.fault === "write" && this.uri.includes("/composer-drafts/")) ||
        (native.outboxWriteFails && this.uri.includes("/thread-outbox/"))
      ) {
        throw new Error("ENOSPC");
      }
      native.files.set(
        this.uri,
        Buffer.from(value, options?.encoding === "base64" ? "base64" : "utf8"),
      );
    }
    moveSync(destination: File) {
      native.files.set(destination.uri, native.files.get(this.uri)!);
      native.files.delete(this.uri);
    }
    delete() {
      native.files.delete(this.uri);
    }
    upload(url: string, options: UploadOptions) {
      return native.transfer(this.uri, url, options);
    }
  }
  return {
    Directory,
    File,
    Paths: { document: new Directory("file:///documents"), cache: new Directory("file:///cache") },
    UploadType: { BINARY_CONTENT: 0 },
  };
});
vi.mock("../lib/uuid", () => ({
  uuidv4: () => `upload-${++native.nextUuid}`,
  randomHex: () => "abcd",
}));
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map([["environment-1", config]]),
  useThreadShells: () => [],
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null)) } };
});
vi.mock("./git", () => ({ gitEnvironment: {} }));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    readEnvironmentScope: () => native.canOperate,
    useEnvironmentsWithScope: () => new Set(["environment-1"]),
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() =>
        Atom.make(Option.some({ httpBaseUrl: "https://environment.example/" })),
      ),
    },
  };
});
vi.mock("./attachments", () => ({
  attachmentEnvironment: { createUploadUrl: native.mint, remove: native.remove },
}));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: async (
    _registry: unknown,
    query: { input: { resource: { attachmentId: string } } },
  ) =>
    native.server.get(query.input.resource.attachmentId)
      ? { _tag: "Success", value: {} }
      : { _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } },
  runAtomCommand: async (
    _registry: unknown,
    command: unknown,
    target: { input: { attachmentId?: string } },
  ) => {
    if (command === native.mint) {
      const id = `pending-${++native.nextId}`;
      native.server.set(id, null);
      return {
        _tag: "Success",
        value: { attachmentId: id, relativeUrl: `/upload/${id}`, expiresAt: 1 },
      };
    }
    if (command === native.remove && target.input.attachmentId) {
      native.deleted.push(target.input.attachmentId);
      native.server.delete(target.input.attachmentId);
      return { _tag: "Success", value: undefined };
    }
    throw new Error("Unexpected RPC command");
  },
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<Record<string, string>>({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () =>
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map(),
  };
});
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "environment-1", connectionState: "connected" }],
  }),
}));

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadKey,
} from "../lib/composerAttachmentUploadQueue";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import {
  composerAttachmentUploadsAtom,
  useComposerAttachmentUploadWorker,
} from "./composer-attachment-uploads";
import {
  enqueueThreadOutboxMessage,
  flushThreadOutbox,
  threadOutboxManager,
} from "./thread-outbox";
import { decodeQueuedThreadMessage, type QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";
import { ThreadOutboxManagerError } from "./thread-outbox-manager";
import * as drafts from "./use-composer-drafts";
import { prepareQueuedMessageAttachments } from "./use-thread-outbox-drain";

const environmentId = EnvironmentId.make("environment-1");
const draftKey = "environment-1:thread-1";
const draftsUri = "file:///documents/composer-drafts/drafts.json";
const config = { environment: { capabilities: { attachmentUploads: true } } };
const image: DraftComposerAttachment = {
  id: "image-1",
  type: "image",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "data:image/png;base64,YWJj",
};
let disposeWorker: (() => void) | undefined;

function worker() {
  native.effects = [];
  useComposerAttachmentUploadWorker();
  disposeWorker = native.effects[0]!() ?? undefined;
  const queue = native.queueRef.current!;
  native.effects[1]!();
  return queue;
}

function sendInput() {
  return {
    environmentId,
    attachments: drafts.getComposerDraftSnapshot(draftKey).attachments,
    connected: true,
    serverConfig: config,
    states: appAtomRegistry.get(composerAttachmentUploadsAtom),
  };
}

function queuedMessage(): QueuedThreadMessage {
  return {
    environmentId,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "Look at this",
    attachments: drafts.getComposerDraftSnapshot(draftKey).attachments,
    createdAt: "2026-10-17T00:00:00.000Z",
  };
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  native.files.clear();
  native.server.clear();
  native.deleted.length = 0;
  native.fault = null;
  native.outboxWriteFails = false;
  native.canOperate = true;
  native.nextId = 0;
  native.nextUuid = 0;
  native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":{}}'));
  drafts.resetComposerDraftsLoadState();
  appAtomRegistry.set(drafts.composerDraftsAtom, {
    [draftKey]: { text: "Look at this", attachments: [image] },
  });
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  await drafts.flushComposerDrafts();
  await threadOutboxManager.load();
  native.transfer.mockReset();
  native.transfer.mockImplementation(async (uri, url, options) => {
    const bytes = native.files.get(uri)!;
    options.onProgress?.({ bytesSent: bytes.length, totalBytes: bytes.length });
    native.server.set(url.split("/").at(-1)!, bytes);
    return { status: 204 };
  });
});

afterEach(async () => {
  disposeWorker?.();
  disposeWorker = undefined;
  native.fault = null;
  native.outboxWriteFails = false;
  native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":{}}'));
  drafts.resetComposerDraftsLoadState();
  await drafts.flushComposerDrafts();
  await flushThreadOutbox();
  vi.restoreAllMocks();
});

it.each(["decode", "read", "write"] as const)(
  "queues Send after a background draft %s failure and durably prepares surviving bytes",
  async (fault) => {
    native.fault = fault;
    if (fault === "decode")
      native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":'));
    drafts.resetComposerDraftsLoadState();
    const queue = worker();
    await queue.settled();
    expect(
      appAtomRegistry.get(composerAttachmentUploadsAtom)[
        composerAttachmentUploadKey(environmentId, image.id)
      ],
    ).toMatchObject({ status: "failed", reason: expect.stringContaining(`operation ${fault}`) });
    expect(native.deleted).toEqual(["pending-1"]);
    expect(composerAttachmentUploadBlockReason(sendInput())).toBeNull();
    expect(composerAttachmentsStillUploading(sendInput())).toBe(true);

    const message = queuedMessage();
    expect(message.attachments[0]?.uploadedAttachmentId).toBe("pending-1");
    const saved = enqueueThreadOutboxMessage(message);
    drafts.clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
    queue.sync([]);
    await saved;
    const prepared = await prepareQueuedMessageAttachments(message, true);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Outbox preparation abandoned");
    expect(prepared.prepared.pendingAttachmentIds).toEqual(["pending-2"]);
    const disk = native.files.get("file:///documents/thread-outbox/message-1.json")!;
    const persisted = decodeQueuedThreadMessage(JSON.parse(Buffer.from(disk).toString("utf8")));
    expect(persisted).toEqual(prepared.persistedMessage);
    expect(persisted.attachments[0]).toMatchObject({
      uploadedAttachmentId: "pending-2",
      uploadEnvironmentId: environmentId,
    });

    await expect(
      drafts.releaseUnusedComposerAttachmentFiles(message.attachments),
    ).rejects.toBeInstanceOf(drafts.ComposerDraftPersistenceError);
    native.fault = null;
    native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":{}}'));
    drafts.resetComposerDraftsLoadState();
    await drafts.releaseUnusedComposerAttachmentFiles(message.attachments);
    await queue.settled();
    expect(new Set(native.deleted)).toEqual(new Set(["pending-1"]));
    expect(native.transfer).toHaveBeenCalledTimes(2);
    expect(Buffer.from(native.server.get("pending-2")!)).toEqual(Buffer.from("abc"));
    expect((await expoThreadOutboxStorage.load()).messages[0]).toEqual(persisted);
  },
);

it.each(["http", "network", "permission"] as const)(
  "keeps a real %s upload failure blocking Send",
  async (failure) => {
    if (failure === "http") native.transfer.mockResolvedValueOnce({ status: 503 });
    if (failure === "network")
      native.transfer.mockRejectedValueOnce(new Error("Network unavailable"));
    if (failure === "permission") native.canOperate = false;
    const queue = worker();
    await queue.settled();
    expect(composerAttachmentUploadBlockReason(sendInput())).toBe(
      "Retry or remove the failed attachment",
    );
    expect(composerAttachmentsStillUploading(sendInput())).toBe(false);
    expect([...native.server.values()]).toEqual([]);
  },
);

it("keeps unexpected draft flush exceptions blocking Send", async () => {
  vi.spyOn(drafts, "flushComposerDrafts").mockRejectedValueOnce(
    new Error("Unexpected flush defect"),
  );
  const queue = worker();
  await queue.settled();
  expect(composerAttachmentUploadBlockReason(sendInput())).toBe(
    "Retry or remove the failed attachment",
  );
  expect(composerAttachmentsStillUploading(sendInput())).toBe(false);
  expect(native.deleted).toEqual(["pending-1"]);
});

it("does not prepare a recovered Send when the outbox cannot durably save it", async () => {
  native.fault = "write";
  const queue = worker();
  await queue.settled();
  const message = queuedMessage();
  native.outboxWriteFails = true;
  await expect(enqueueThreadOutboxMessage(message)).rejects.toBeInstanceOf(
    ThreadOutboxManagerError,
  );
  await expect(prepareQueuedMessageAttachments(message, true)).resolves.toEqual({
    status: "abandoned",
  });
  expect(native.nextId).toBe(1);
  expect(native.server.size).toBe(0);
  expect((await expoThreadOutboxStorage.load()).messages).toEqual([]);
});

it("does not deliver fresh bytes when persisting the outbox upload reference fails", async () => {
  native.fault = "write";
  const queue = worker();
  await queue.settled();
  const message = queuedMessage();
  await enqueueThreadOutboxMessage(message);
  native.outboxWriteFails = true;
  await expect(prepareQueuedMessageAttachments(message, true)).rejects.toBeInstanceOf(
    ThreadOutboxManagerError,
  );
  expect(native.nextId).toBe(2);
  expect(native.server.size).toBe(0);
  expect(
    (await expoThreadOutboxStorage.load()).messages[0]?.attachments[0]?.uploadedAttachmentId,
  ).toBe("pending-1");
});

it.each(["removed", "cancelled"] as const)(
  "cleans an upload whose owner is %s before the response",
  async (action) => {
    const reached = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ status: number }>();
    native.transfer.mockImplementationOnce(async (uri, url) => {
      native.server.set(url.split("/").at(-1)!, native.files.get(uri)!);
      reached.resolve();
      return response.promise;
    });
    const queue = worker();
    await reached.promise;
    if (action === "removed") {
      drafts.clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
      queue.sync([]);
    } else {
      disposeWorker?.();
      disposeWorker = undefined;
    }
    response.resolve({ status: 204 });
    await queue.settled();
    expect(native.deleted).toEqual(["pending-1"]);
    expect(native.server.size).toBe(0);
    expect(appAtomRegistry.get(composerAttachmentUploadsAtom)).toEqual({});
  },
);
