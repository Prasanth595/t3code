import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as JiraCli from "./JiraCli.ts";
import { buildJiraListJql, make, parseJiraBinding } from "./JiraIssueProvider.ts";
import { jiraIssueKeyParts, renderJiraBody } from "./jiraIssueJson.ts";

const PROJECT: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "checkout-web",
  workspaceRoot: "/work/checkout-web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const settingsLayer = ServerSettings.layerTest({
  issueTracking: {
    connections: {
      jira: { projectBindings: { [PROJECT.id]: { repository: "acme.atlassian.net/CHK" } } },
    },
  },
} as never);

/** A TWG CLI stand-in that answers each run by its operation and records the arguments. */
function cliLayer(answers: Record<string, unknown>, calls: Array<ReadonlyArray<string>> = []) {
  return Layer.succeed(
    JiraCli.JiraCli,
    JiraCli.JiraCli.of({
      run: ({ operation, site, args }) => {
        calls.push([...(site === undefined ? [] : ["--site", site]), ...args]);
        return Effect.succeed(JSON.stringify(answers[operation]));
      },
    }),
  );
}

const apiAnswer = (body: unknown) => ({
  apiVersion: "v2",
  command: "api",
  data: { status: 200, body },
});

it("reads a binding as a Jira site and project key", () => {
  assert.deepStrictEqual(parseJiraBinding("Acme.atlassian.net/chk"), {
    host: "acme.atlassian.net",
    key: "CHK",
  });
  assert.strictEqual(parseJiraBinding("CHK"), null);
  assert.deepStrictEqual(jiraIssueKeyParts("CHK-412"), { repository: "CHK", number: 412 });
  assert.strictEqual(jiraIssueKeyParts("chk-412"), null);
});

it("builds JQL for the listing filters, quoting free text", () => {
  assert.strictEqual(
    buildJiraListJql({
      project: "CHK",
      state: "open",
      involvement: "assigned",
      query: 'apple "pay"',
      order: "desc",
    }),
    'project = "CHK" AND statusCategory != Done AND assignee = currentUser() AND text ~ "apple \\"pay\\"" ORDER BY updated DESC',
  );
  assert.strictEqual(
    buildJiraListJql({
      project: "CHK",
      state: "closed",
      involvement: "authored",
      sort: "created",
      order: "asc",
    }),
    'project = "CHK" AND statusCategory = Done AND reporter = currentUser() ORDER BY created ASC',
  );
});

it.effect("numbers ordered lists in Jira documents", () =>
  Effect.gen(function* () {
    const body = yield* renderJiraBody("test", {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: ["Open checkout", "Pay"].map((text) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
      ],
    });
    assert.strictEqual(body, "1. Open checkout\n2. Pay");
  }),
);

it.effect("resolves a project's Jira binding and lists its issues", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const adapter = yield* make;
    const source = yield* adapter.resolveSource!(PROJECT);
    assert.deepStrictEqual(source, { host: "acme.atlassian.net", repository: "CHK" });
    const page = yield* adapter.listIssues({
      cwd: PROJECT.workspaceRoot,
      host: "acme.atlassian.net",
      repository: "CHK",
      state: "open",
      involvement: "all",
      viewer: "account-1",
      limit: 25,
    });
    assert.deepStrictEqual(page.items, [
      {
        number: 412,
        title: "Apple Pay sheet freezes",
        url: "https://acme.atlassian.net/browse/CHK-412",
        author: { login: "Sam Okafor", name: "Sam Okafor", avatarUrl: null },
        state: "open",
        stateReason: null,
        createdAt: "2026-10-05T14:08:03.000Z",
        updatedAt: "2026-10-11T15:08:03.000Z",
        closedAt: null,
        assignees: [],
        labels: [{ name: "payments", color: null }],
        milestone: "2026.10.2",
        commentCount: 0,
      },
    ]);
    assert.strictEqual(page.truncated, true);
    assert.deepStrictEqual(calls[0]?.slice(0, 3), ["--site", "acme.atlassian.net", "api"]);
    const url = new URL(`https://x${calls[0]![3]!.slice("jira:".length)}`);
    assert.strictEqual(url.pathname, "/rest/api/3/search/jql");
    assert.strictEqual(
      url.searchParams.get("jql"),
      'project = "CHK" AND statusCategory != Done ORDER BY updated DESC',
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        cliLayer(
          {
            listIssues: apiAnswer({
              isLast: false,
              nextPageToken: "next",
              issues: [
                {
                  id: "10412",
                  key: "CHK-412",
                  fields: {
                    summary: "Apple Pay sheet freezes",
                    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                    reporter: { accountId: "account-2", displayName: "Sam Okafor" },
                    assignee: null,
                    labels: ["payments"],
                    fixVersions: [{ name: "2026.10.2" }],
                    created: "2026-10-05T14:08:03.000+0000",
                    updated: "2026-10-11T15:08:03.000+0000",
                  },
                },
              ],
            }),
          },
          calls,
        ),
        settingsLayer,
      ),
    ),
  );
});

it.effect("keeps Jira comment audiences and posts internal notes with --internal", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const comment = (id: string, extra: object) => ({
    id,
    author: { accountId: "account-3", displayName: "Riley Chen" },
    created: "2026-10-10T09:00:00.000+0000",
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] },
    ...extra,
  });
  return Effect.gen(function* () {
    const adapter = yield* make;
    const ref = { cwd: "/work", host: "acme.atlassian.net", repository: "CHK", number: 412 };
    const activity = yield* adapter.getIssueActivity(ref);
    assert.deepStrictEqual(
      activity.comments.map((entry) => [entry.body, entry.visibility]),
      [
        ["public", "public"],
        ["internal", "internal"],
        ["restricted", "restricted"],
        ["software", undefined],
      ],
    );
    assert.strictEqual(activity.nextCommentsCursor, "cursor-2");
    assert.strictEqual(activity.commentCount, 5);
    yield* adapter.comment({ ...ref, body: "Shared the workaround", visibility: "internal" });
    assert.deepStrictEqual(calls.at(-1), [
      "--site",
      "acme.atlassian.net",
      "jira",
      "workitem",
      "comment",
      "create",
      "--issue-id",
      "CHK-412",
      "--body",
      "Shared the workaround",
      "--body-format",
      "markdown",
      "--internal",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        cliLayer(
          {
            getIssueActivity: {
              data: [
                comment("public", { jsdPublic: true }),
                comment("internal", { jsdPublic: false }),
                comment("restricted", { visibility: { type: "role", value: "Developers" } }),
                comment("software", {}),
              ],
              pageInfo: { hasNextPage: true, nextCursor: "cursor-2" },
              total: 5,
            },
            comment: { data: comment("posted", { jsdPublic: false }) },
          },
          calls,
        ),
        settingsLayer,
      ),
    ),
  );
});
