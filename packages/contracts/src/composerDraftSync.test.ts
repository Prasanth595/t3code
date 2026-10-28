import { describe, expect, it } from "vite-plus/test";

import {
  decideComposerDraftSync,
  type ComposerDraftSyncKey,
  type SyncedComposerDraft,
} from "./composerDraftSync.ts";

const key = "thread:thread-1" as ComposerDraftSyncKey;
const now = "2026-10-28T03:00:00.000Z";

function remote(patch: Partial<SyncedComposerDraft> = {}): SyncedComposerDraft {
  return {
    key,
    prompt: "remote",
    updatedAt: "2026-10-28T02:00:00.000Z",
    deleted: false,
    ...patch,
  };
}

describe("decideComposerDraftSync", () => {
  it("applies a draft that exists only on another device", () => {
    expect(decideComposerDraftSync({ key, local: null, remote: remote(), now })).toMatchObject({
      action: "apply",
      draft: { prompt: "remote" },
    });
  });

  it("keeps unsent text the user can see when this device has not synced it yet", () => {
    expect(
      decideComposerDraftSync({
        key,
        local: { prompt: "local", updatedAt: null, deleted: false },
        remote: remote(),
        now,
      }),
    ).toMatchObject({ action: "push", draft: { prompt: "local", updatedAt: now } });
  });

  it("adopts the remote draft when the local composer is empty", () => {
    expect(
      decideComposerDraftSync({
        key,
        local: { prompt: "  ", updatedAt: null, deleted: false },
        remote: remote(),
        now,
      }),
    ).toMatchObject({ action: "apply" });
  });

  it("lets the newer stamp win after both devices have synced", () => {
    expect(
      decideComposerDraftSync({
        key,
        local: { prompt: "local", updatedAt: "2026-10-28T01:00:00.000Z", deleted: false },
        remote: remote(),
        now,
      }),
    ).toMatchObject({ action: "apply", draft: { prompt: "remote" } });

    expect(
      decideComposerDraftSync({
        key,
        local: { prompt: "local", updatedAt: "2026-10-28T04:00:00.000Z", deleted: false },
        remote: remote(),
        now,
      }),
    ).toMatchObject({ action: "push", draft: { prompt: "local" } });
  });

  it("remembers one stamp when both sides already match", () => {
    expect(
      decideComposerDraftSync({
        key,
        local: {
          prompt: "remote",
          updatedAt: null,
          deleted: false,
        },
        remote: remote(),
        now,
      }),
    ).toEqual({ action: "remember", updatedAt: "2026-10-28T02:00:00.000Z" });
  });
});
