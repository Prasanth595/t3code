import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerPathMenuItems } from "./composerPathMenuItems";

const environmentId = EnvironmentId.make("env-1");
const releaseNotes = {
  environmentId,
  id: ThreadId.make("thread-release"),
  title: "Release notes",
  updatedAt: "2026-10-11T12:00:00.000Z",
  archivedAt: null,
};
const readme = { path: "docs/release.md", kind: "file" as const };

function itemIdsFor(answeringQuestion: boolean, query = "release") {
  return composerPathMenuItems({
    threadShells: [releaseNotes],
    environmentId,
    activeThreadId: ThreadId.make("thread-current"),
    query,
    entries: [readme],
    answeringQuestion,
  }).map((item) => item.id);
}

describe("composerPathMenuItems", () => {
  it("offers matching threads ahead of files in an ordinary message", () => {
    expect(itemIdsFor(false)).toEqual(["thread:env-1:thread-release", "path:file:docs/release.md"]);
  });

  it("offers only files while answering a question, then threads again afterwards", () => {
    expect(itemIdsFor(true)).toEqual(["path:file:docs/release.md"]);
    expect(itemIdsFor(false)).toContain("thread:env-1:thread-release");
  });

  it("keeps a bare @ a file picker", () => {
    expect(itemIdsFor(false, "")).toEqual(["path:file:docs/release.md"]);
  });
});
