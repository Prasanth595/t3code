import {
  ServerConfig,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ComposerContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ComposerContextRecord as ContextRecord } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export const ENVIRONMENT_ID = EnvironmentId.make("chip-evidence-offline");
export const THREAD_ID = ThreadId.make("chip-evidence");
export const FIXED_TIME = "2026-01-01T12:00:00.000Z";
export const SKILLS = [
  {
    name: "check.mobile",
    displayName: "Check mobile",
    path: "/fixture/skills/check.mobile/SKILL.md",
    enabled: true,
    userInvocable: true,
    description: "Offline fixture skill",
  },
];
export const SERVER_CONFIG = Schema.decodeUnknownSync(ServerConfig)({
  environment: {
    environmentId: ENVIRONMENT_ID,
    label: "Offline fixture",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "fixture",
    capabilities: {},
  },
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "fixture-unused",
  },
  cwd: "/fixture",
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: FIXED_TIME,
      models: [],
      skills: SKILLS,
    },
  ],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {},
  scratchWorkspaceRoot: "/fixture/scratch",
});
const base = (id: string, label: string) => ({
  version: 1 as const,
  contextId: ComposerContextId.make(id),
  label,
});
const file = (
  id: string,
  name: string,
  mimeType: string,
  sizeBytes = 2048,
): ComposerContextRecord => ({
  ...base(id, name),
  kind: "file",
  attachmentId: id,
  name,
  mimeType,
  sizeBytes,
});
export const REVIEW = {
  ...base("review", "Review note"),
  kind: "review-comment" as const,
  sectionId: "file:src/app.tsx",
  sectionTitle: "src/app.tsx",
  filePath: "src/app.tsx",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "L1",
  text: "Please check [app.tsx](file:///fixture/src/app.tsx) and [terminal](t3-context://v1/terminal/missing).",
  diff: "@@ -1 +1 @@\n-old\n+new",
  fenceLanguage: "diff",
};
export const ATLAS: ReadonlyArray<ComposerContextRecord> = [
  {
    ...base("image", "Image.png"),
    kind: "image",
    attachmentId: "image",
    name: "Image.png",
    mimeType: "image/png",
    sizeBytes: 2048,
  },
  file("video", "Video.mp4", "video/mp4"),
  file("file", "app.tsx", "text/plain"),
  { ...base("mention", "src/app.tsx"), kind: "mention", path: "src/app.tsx" },
  {
    ...base("terminal", "Terminal output"),
    kind: "terminal",
    terminalId: "offline-terminal",
    terminalLabel: "Terminal",
    lineStart: 0,
    lineEnd: 2,
    text: "npm test\npassed",
  },
  {
    ...base("element", "Submit button"),
    kind: "element",
    pageUrl: "https://example.invalid",
    pageTitle: "Fixture",
    tagName: "button",
    selector: "#submit",
    htmlPreview: "<button>Submit</button>",
    componentName: "Submit",
    source: null,
    styles: "color: red",
  },
  {
    ...base("preview", "Preview annotation"),
    kind: "preview-annotation",
    annotationId: "annotation",
    pageUrl: "https://example.invalid",
    pageTitle: "Fixture",
    comment: "Align this",
    targetSummary: "Submit",
    styleChanges: [],
  },
  REVIEW,
  { ...base("skill", "Check mobile"), kind: "skill", name: "check.mobile" },
  {
    ...base("thread", "Linked thread"),
    kind: "thread",
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("linked-thread"),
    title: "Linked thread",
  },
];
export const PR_REVIEWS: ReadonlyArray<ComposerContextRecord> = [
  "open",
  "draft",
  "merged",
  "closed",
  "unknown",
].map((state, index) => ({
  ...REVIEW,
  ...base(`pr-review-${state}`, `PR ${state}`),
  sectionId: `pull-request:${index + 1}`,
  ...(state === "unknown"
    ? {}
    : {
        pullRequest: {
          number: index + 1,
          title: `PR ${state}`,
          url: `https://github.com/fixture/repo/pull/${index + 1}`,
          headBranch: "feature",
          baseBranch: "main",
          state: state === "draft" ? ("open" as const) : (state as "open" | "merged" | "closed"),
          isDraft: state === "draft",
        },
      }),
}));
export const FILES = [
  file("tsx", "app.tsx", "text/plain"),
  file("unknown-ext", "sample.unknown", "application/octet-stream"),
  file("image-mime", "image.bin", "image/png"),
  file("video-mime", "video.bin", "video/mp4"),
  file("image-extension", "photo.png", "application/octet-stream"),
  file("video-extension", "clip.mp4", "application/octet-stream"),
  file("nonmedia", "data.csv", "text/csv"),
];
export const SIZES = [
  file("size-zero", "zero.txt", "text/plain", 0),
  file("size-normal", "normal.txt", "text/plain", 2048),
  file("size-large", "large.txt", "text/plain", 123456789),
  file(
    "size-long",
    "a-very-long-file-name-with-a-preserved-suffix-for-truncation-check.tsx",
    "text/plain",
    2048,
  ),
];
export const UNKNOWN: ComposerContextRecord = {
  ...base("future", "Future context"),
  kind: "future-kind",
  payload: {},
};
export const href = (record: ComposerContextRecord) =>
  `t3-context://v1/${record.kind}/${record.contextId}`;
export const markdown = (records: ReadonlyArray<ComposerContextRecord>) =>
  records
    .map((record) => `Compare [${record.label}](${href(record)}) with nearby prose.`)
    .join("\n\n");
export const context = (
  records: ReadonlyArray<ComposerContextRecord>,
): OrchestrationMessageContext => ({ version: 1, records });
export function feed(
  text: string,
  role: "user" | "assistant",
  records?: ReadonlyArray<ComposerContextRecord>,
  streaming = false,
): ReadonlyArray<ThreadFeedEntry> {
  return [
    {
      type: "message",
      id: `fixture-${role}`,
      createdAt: FIXED_TIME,
      message: {
        id: MessageId.make(`fixture-${role}`),
        role,
        text,
        attachments: [],
        runId: null,
        streaming,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
        ...(records ? { context: context(records) } : {}),
      },
    },
  ];
}
export const EXTERNAL =
  "[GitHub PR](https://github.com/fixture/repo/pull/42)\n\n[GitCafe PR](https://git.cafe/fixture/repo/pulls/42)\n\n[External](https://example.invalid)\n\n[First label](https://github.com/fixture/repo/pull/42) [Second label](https://github.com/fixture/repo/pull/42)\n\n**Markdown control** and plain prose.";
export const PREVIEW =
  "# Preview fixture\n\n[app.tsx](file:///fixture/src/app.tsx)\n\n[Terminal](t3-context://v1/terminal/missing)\n\n[External control](https://example.invalid)";
export const SCENES = [
  "U1-1",
  "U1-2",
  "A1-1",
  "A1-2",
  "C1-1",
  "C1-2",
  "C1-3",
  "P1-user",
  "P1-composer",
  "P2-user",
  "P2-composer",
  "P3-user",
  "P3-assistant",
  "P3-streaming",
  "F1-user-1",
  "F1-user-2",
  "F1-assistant-1",
  "F1-assistant-2",
  "F1-composer-1",
  "F1-composer-2",
  "F2-user",
  "F2-composer",
  "N1-user",
  "N1-assistant",
  "N1-composer",
  "E1",
  "E2",
  "E2-grouped",
  "E2-note",
  "E2-description",
  "E2-timeline",
  "E4",
  "E4-empty",
  "E3-expanded",
  "E3-collapsed",
  "W1-chat",
  "W1-composer",
  "W1-plain",
  "T1",
  "T2-emoji",
  "T2-mono1",
  "T2-mono2",
  "T2-lucide",
  "T3-normal",
  "T3-punctuation",
  "T3-digit",
  "T4-missing",
  "T4-blank",
  "T4-scratch",
  "T4-pending",
  "T4-failed",
  "T5-before",
  "T5-renamed",
  "G1",
  "G2",
  "C2-thread-composer",
  "K1",
  "K2",
  "G3-sizes",
  "G3-home",
  "G3-archive",
  "G3-new-task",
  "C2-1",
  "C2-2",
  "C2-pr",
] as const;
export type Scene = (typeof SCENES)[number];
export function validateFixtures() {
  const decode = Schema.decodeUnknownSync(ContextRecord);
  for (const record of [...ATLAS, ...PR_REVIEWS, ...FILES, ...SIZES, UNKNOWN])
    decode(JSON.parse(JSON.stringify(record)));
}
