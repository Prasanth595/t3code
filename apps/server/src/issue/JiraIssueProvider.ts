import * as Effect from "effect/Effect";
import {
  IssueTrackingError,
  type IssueCapabilities,
  type IssueTrackerConnection,
  type IssueViewerPermissions,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as JiraCli from "./JiraCli.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type IssueAdapterSource,
  type IssueTracker,
} from "./IssueProvider.ts";
import {
  JIRA_LIST_FIELDS,
  JiraIssue,
  JiraRawIssue,
  JiraResponseError,
  JiraSearchPage,
  decodeApiResponse,
  decodeJiraAccount,
  decodeJiraCommentsPage,
  decodeJiraProjects,
  decodeJiraViewer,
  jiraIssueProperties,
  jiraIssueState,
  renderJiraBody,
  toJiraProviderIssue,
} from "./jiraIssueJson.ts";

const CAPABILITIES: IssueCapabilities = {
  sorts: ["updated", "created"],
  referenceStyle: "key-number",
  closesViaPullRequest: false,
  comment: true,
  actions: [],
  closeReasons: [],
  create: false,
  issueTemplates: false,
  edit: false,
  editComment: false,
  internalComments: true,
  reactions: false,
  labels: false,
  assignees: false,
  listLabelCandidates: false,
  listAssigneeCandidates: false,
  search: true,
  linkedPullRequests: false,
  timelineEvents: false,
};

/** Jira enforces its own permissions on the write, so the page offers what the CLI can do. */
const PERMISSIONS: IssueViewerPermissions = {
  actions: [],
  comment: true,
  edit: false,
  labels: false,
  assignees: false,
  create: false,
};

const COMMENT_PAGE_SIZE = "50";

/** A binding names its project as `site/KEY`, since one environment can read several sites. */
export function parseJiraBinding(repository: string): { host: string; key: string } | null {
  const match = /^([a-z0-9.-]+\.[a-z]{2,})\/([A-Z][A-Z0-9_]*)$/i.exec(repository.trim());
  return match ? { host: match[1]!.toLowerCase(), key: match[2]!.toUpperCase() } : null;
}

function jqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildJiraListJql(input: {
  readonly project: string;
  readonly state: "all" | "open" | "closed";
  readonly involvement: "all" | "assigned" | "authored" | "mentioned";
  readonly query?: string | undefined;
  readonly sort?: string | undefined;
  readonly order?: "asc" | "desc" | undefined;
}): string {
  const clauses = [`project = ${jqlString(input.project)}`];
  if (input.state === "open") clauses.push("statusCategory != Done");
  if (input.state === "closed") clauses.push("statusCategory = Done");
  if (input.involvement === "assigned") clauses.push("assignee = currentUser()");
  if (input.involvement === "authored") clauses.push("reporter = currentUser()");
  // JQL cannot search mentions; watching is the closest notion of being pulled into an issue.
  if (input.involvement === "mentioned") clauses.push("watcher = currentUser()");
  const query = input.query?.trim();
  if (query) clauses.push(`text ~ ${jqlString(query)}`);
  const field = input.sort === "created" ? "created" : "updated";
  return `${clauses.join(" AND ")} ORDER BY ${field} ${input.order === "asc" ? "ASC" : "DESC"}`;
}

const providerError =
  (operation: string) =>
  (error: JiraCli.JiraCliError | JiraResponseError): IssueProviderError => {
    if (error._tag === "JiraCliError")
      return new IssueProviderError({
        provider: "jira",
        operation,
        reason: error.reason,
        detail: error.detail,
        cause: error,
      });
    const status = error.status;
    return new IssueProviderError({
      provider: "jira",
      operation,
      reason:
        status === 401 || status === 403
          ? "unauthenticated"
          : status === 429
            ? "rate-limited"
            : "failed",
      detail:
        status === 401 || status === 403
          ? "Jira refused the TWG CLI login. Run `twg login` on this environment."
          : status === 404
            ? "The Jira issue was not found or is not visible to this account."
            : error.message,
      cause: error,
    });
  };

const unsupported = (operation: string) =>
  Effect.fail(
    new IssueProviderError({
      provider: "jira",
      operation,
      reason: "failed",
      detail: "This change is made in Jira.",
    }),
  );

const make = Effect.gen(function* () {
  const cli = yield* JiraCli.JiraCli;
  const settings = yield* ServerSettings.ServerSettingsService;

  const issueKey = (input: { readonly repository: string; readonly number: number }) =>
    `${input.repository}-${input.number}`;
  const api = (operation: string, host: string, path: string) =>
    cli.run({ operation, site: host, args: ["api", `jira:${path}`] });
  const readIssue = (
    operation: string,
    input: { readonly host: string; readonly repository: string; readonly number: number },
    fields: string,
  ) =>
    api(
      operation,
      input.host,
      `/rest/api/3/issue/${encodeURIComponent(issueKey(input))}?fields=${fields}`,
    ).pipe(Effect.flatMap((text) => decodeApiResponse(JiraIssue, operation, text)));
  const readComments = (
    operation: string,
    input: { readonly host: string; readonly repository: string; readonly number: number },
    cursor?: string,
  ) =>
    cli
      .run({
        operation,
        site: input.host,
        args: [
          "jira",
          "workitem",
          "comment",
          "query",
          "--issue-id",
          issueKey(input),
          "--first",
          COMMENT_PAGE_SIZE,
          "--order-by=created",
          ...(cursor === undefined ? [] : ["--after", cursor]),
        ],
      })
      .pipe(
        Effect.flatMap((text) =>
          decodeJiraCommentsPage(text, `https://${input.host}/browse/${issueKey(input)}`),
        ),
      );

  const status: Effect.Effect<IssueTrackerConnection, IssueTrackingError> = Effect.gen(
    function* () {
      const accountName = yield* cli
        .run({ operation: "status", args: ["whoami"] })
        .pipe(Effect.flatMap(decodeJiraAccount));
      const { site, projects } = yield* cli
        .run({ operation: "status", args: ["jira", "space", "list", "--limit", "200"] })
        .pipe(Effect.flatMap(decodeJiraProjects));
      const trackerProjects = projects.map((project) => ({
        id: project.id,
        key: `${site.toLowerCase()}/${project.key}`,
        name: project.name,
      }));
      return {
        status: "authenticated" as const,
        hasStoredToken: false,
        accountName,
        accountEmail: null,
        projects: trackerProjects,
        accounts: [],
        environmentAccount: {
          status: "authenticated" as const,
          accountName,
          accountEmail: null,
          projects: trackerProjects,
        },
      };
    },
  ).pipe(
    Effect.catchTags({
      JiraCliError: (error) =>
        error.reason === "missing-tool" || error.reason === "unauthenticated"
          ? Effect.succeed({
              status: "unauthenticated" as const,
              hasStoredToken: false,
              accountName: null,
              accountEmail: null,
              projects: [],
              accounts: [],
            })
          : Effect.fail(new IssueTrackingError({ operation: "status", detail: error.detail })),
      JiraResponseError: (error) =>
        Effect.fail(new IssueTrackingError({ operation: "status", detail: error.message })),
    }),
  );

  const tracker: IssueTracker = {
    status,
    connect: () =>
      Effect.fail(
        new IssueTrackingError({
          operation: "connect",
          detail: "Jira uses the TWG CLI login. Run `twg login` on this environment.",
        }),
      ),
    disconnect: () =>
      Effect.fail(
        new IssueTrackingError({
          operation: "disconnect",
          detail: "Jira uses the TWG CLI login. Run `twg logout` on this environment.",
        }),
      ),
    bind: (input) =>
      input.binding !== null && parseJiraBinding(input.binding.repository) === null
        ? Effect.fail(
            new IssueTrackingError({
              operation: "bind",
              detail: "Choose a Jira project as site/KEY, such as acme.atlassian.net/CHK.",
            }),
          )
        : settings
            .updateSettings({
              issueTracking: {
                connections: { jira: { projectBindings: { [input.projectId]: input.binding } } },
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new IssueTrackingError({
                    operation: "bind",
                    detail: "The Jira project could not be saved.",
                    cause,
                  }),
              ),
            ),
  };

  return {
    kind: "jira",
    // Jira issues are not owned by a repository, so any thread can read one it was handed.
    readsWithoutBinding: (source) =>
      source.host.endsWith(".atlassian.net") && /^[A-Z][A-Z0-9_]*$/u.test(source.repository),
    tracker,
    capabilities: CAPABILITIES,
    resolveSource: (project) =>
      settings.getSettings.pipe(
        Effect.map((value): IssueAdapterSource | null => {
          const binding = value.issueTracking.connections.jira?.projectBindings[project.id];
          const parsed = binding == null ? null : parseJiraBinding(binding.repository);
          return parsed === null ? null : { host: parsed.host, repository: parsed.key };
        }),
        Effect.orElseSucceed(() => null),
      ),
    getViewer: () =>
      cli
        .run({ operation: "getViewer", args: ["whoami"] })
        .pipe(Effect.flatMap(decodeJiraViewer), Effect.mapError(providerError("getViewer"))),
    listIssues: (input) => {
      const jql = buildJiraListJql({
        project: input.repository,
        state: input.state,
        involvement: input.involvement,
        query: input.query,
        sort: input.sort,
        order: input.order,
      });
      const params = new URLSearchParams({
        jql,
        maxResults: String(input.limit),
        fields: JIRA_LIST_FIELDS,
      });
      return api("listIssues", input.host, `/rest/api/3/search/jql?${params}`).pipe(
        Effect.flatMap((text) => decodeApiResponse(JiraSearchPage, "listIssues", text)),
        Effect.map((page) => ({
          items: page.issues.flatMap((issue) => toJiraProviderIssue(issue, input.host) ?? []),
          truncated: page.isLast === false || Boolean(page.nextPageToken),
          // Jira pages by an opaque token, not by update time, so a larger limit reaches the rest.
          continues: false,
        })),
        Effect.mapError(providerError("listIssues")),
      );
    },
    getIssueSummary: (input) =>
      readIssue("getIssueSummary", input, "summary,status").pipe(
        Effect.map((issue) => ({
          number: input.number,
          title: issue.fields.summary,
          url: `https://${input.host}/browse/${issue.key}`,
          state: jiraIssueState(issue.fields.status?.statusCategory?.key),
        })),
        Effect.mapError(providerError("getIssueSummary")),
      ),
    getIssue: (input) =>
      // Every field, with the site's names for them, so the detail can show what Jira shows.
      api(
        "getIssue",
        input.host,
        `/rest/api/3/issue/${encodeURIComponent(issueKey(input))}?expand=names`,
      ).pipe(
        Effect.flatMap((text) =>
          Effect.all([
            decodeApiResponse(JiraIssue, "getIssue", text),
            decodeApiResponse(JiraRawIssue, "getIssue", text),
          ]),
        ),
        Effect.flatMap(([issue, raw]) => {
          const base = toJiraProviderIssue(issue, input.host);
          return base === null
            ? Effect.fail(new JiraResponseError({ operation: "getIssue" }))
            : renderJiraBody("getIssue", issue.fields.description).pipe(
                Effect.map((body) => ({
                  ...base,
                  repositoryUrl: `https://${input.host}/browse/${input.repository}`,
                  body,
                  linkedPullRequests: [],
                  properties: jiraIssueProperties(raw),
                  viewerPermissions: PERMISSIONS,
                })),
              );
        }),
        Effect.mapError(providerError("getIssue")),
      ),
    getIssueActivity: (input) =>
      readComments("getIssueActivity", input).pipe(
        Effect.map((page) => ({
          comments: page.comments,
          commentCount: Math.max(page.total, page.comments.length),
          commentsTruncated: page.nextCursor !== null,
          nextCommentsCursor: page.nextCursor,
          events: [],
        })),
        Effect.mapError(providerError("getIssueActivity")),
      ),
    getIssueComments: (input) =>
      readComments("getIssueComments", input, input.cursor).pipe(
        Effect.map((page) => ({ comments: page.comments, nextCursor: page.nextCursor })),
        Effect.mapError(providerError("getIssueComments")),
      ),
    getViewerPermissions: () => Effect.succeed(PERMISSIONS),
    runAction: () => unsupported("runAction"),
    // One attempt only: a timeout can follow a successful Jira write.
    comment: (input) =>
      cli
        .run({
          operation: "comment",
          site: input.host,
          args: [
            "jira",
            "workitem",
            "comment",
            "create",
            "--issue-id",
            issueKey(input),
            "--body",
            input.body,
            "--body-format",
            "markdown",
            ...(input.visibility === "internal" ? ["--internal"] : []),
          ],
        })
        .pipe(Effect.asVoid, Effect.mapError(providerError("comment"))),
    create: () => unsupported("create"),
    update: () => unsupported("update"),
    setLabels: () => unsupported("setLabels"),
    setAssignees: () => unsupported("setAssignees"),
    listLabelCandidates: () => unsupported("listLabelCandidates"),
    listAssigneeCandidates: () => unsupported("listAssigneeCandidates"),
  } satisfies IssueAdapter;
});

export { make };
