import { assert, it } from "@effect/vitest";

import { classifyFirstParentCommit } from "./fork-release-notes.ts";

it("sorts first-parent commits into pull requests, upstream syncs and direct commits", () => {
  const merge = ["main-parent", "branch-parent"];
  assert.deepStrictEqual(
    classifyFirstParentCommit({
      parents: merge,
      subject: "Merge pull request #131 from Yarden-zamir/feat/machine-map-zoom-pan",
      body: "feat(machine-map): zoom and pan the map\n",
    }),
    { _tag: "PullRequest", number: 131, title: "feat(machine-map): zoom and pan the map" },
  );
  // A merge without a body falls back to the branch name.
  assert.deepStrictEqual(
    classifyFirstParentCommit({
      parents: merge,
      subject: "Merge pull request #7 from Yarden-zamir/fix/a",
      body: "",
    }),
    { _tag: "PullRequest", number: 7, title: "Yarden-zamir/fix/a" },
  );
  assert.deepStrictEqual(
    classifyFirstParentCommit({
      parents: merge,
      subject: "chore(sync): merge pingdotgg/t3code main",
      body: "",
    }),
    { _tag: "UpstreamSync", upstreamHead: "branch-parent" },
  );
  // A commit that only names a pull request in its subject is not a merge.
  assert.deepStrictEqual(
    classifyFirstParentCommit({
      parents: ["main-parent"],
      subject: "Merge pull request #8 from Yarden-zamir/fix/b",
      body: "",
    }),
    { _tag: "Direct" },
  );
});
