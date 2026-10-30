import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import { EnvironmentId, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadFolderMenuId, moveToFolderMenuItem } from "./threadFolderMenu";

const environmentId = EnvironmentId.make("env-1");
const folder = (id: string, threadIds: string[]): EnvironmentThreadFolder => ({
  environmentId,
  id: ThreadFolderId.make(id),
  name: id,
  icon: null,
  rule: null,
  autoFile: false,
  ruleSetAt: null,
  threadIds: threadIds.map((threadId) => ThreadId.make(threadId)),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const menu = (threadIds: string[], canOperate = true) =>
  moveToFolderMenuItem({
    environmentId,
    threadIds: threadIds.map((threadId) => ThreadId.make(threadId)),
    canOperate,
    folders: [folder("a", ["t1", "t2"]), folder("b", [])],
  });

describe("moveToFolderMenuItem", () => {
  it("checks a folder only when it holds every target and offers removal", () => {
    const both = menu(["t1", "t2"]).children!;
    expect(both.map((child) => [child.id, child.checked ?? false])).toEqual([
      ["folder:new", false],
      ["folder:id:a", true],
      ["folder:id:b", false],
      ["folder:remove", false],
    ]);
    expect(menu(["t1", "t3"]).children!.find((c) => c.id === "folder:id:a")?.checked).toBe(false);
  });

  it("hides removal when no target is filed and disables everything without permission", () => {
    expect(menu(["t3"]).children!.some((child) => child.id === "folder:remove")).toBe(false);
    const locked = menu(["t1"], false);
    expect([locked, ...locked.children!].every((item) => item.disabled)).toBe(true);
  });
});

describe("isThreadFolderMenuId", () => {
  it("accepts folder ids and rejects others", () => {
    expect(
      ["folder", "folder:new", "folder:id:x", "folder:remove"].every(isThreadFolderMenuId),
    ).toBe(true);
    expect(isThreadFolderMenuId("pin")).toBe(false);
  });
});
