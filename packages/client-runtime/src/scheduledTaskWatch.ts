import {
  MAX_WEBHOOK_FILTERS,
  ScheduledTaskWatchFilter,
  ScheduledTaskWatchInput,
  type ScheduledTask,
  type ScheduledTaskWatch,
  type ScheduledTaskWatchSource,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { WEBHOOK_FILTER_OPS, type WebhookFilterDraft } from "./scheduledTaskWebhook.ts";

export interface WatchDraft {
  readonly sourceType: "jira" | "http_json";
  readonly url: string;
  readonly jql: string;
  readonly itemsPath: string;
  readonly keyPath: string;
  readonly authType: "none" | "basic" | "bearer";
  readonly username: string;
  readonly secret: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly maxConcurrentRuns: string;
}

export function emptyWatchDraft(): WatchDraft {
  return {
    sourceType: "jira",
    url: "",
    jql: "",
    itemsPath: "",
    keyPath: "id",
    authType: "none",
    username: "",
    secret: "",
    filters: [],
    maxConcurrentRuns: "1",
  };
}

export function watchDraft(watch: ScheduledTaskWatch): WatchDraft {
  const { source } = watch;
  return {
    ...emptyWatchDraft(),
    sourceType: source.type,
    url: source.type === "jira" ? source.baseUrl : source.url,
    ...(source.type === "jira"
      ? { jql: source.jql }
      : { itemsPath: source.itemsPath, keyPath: source.keyPath }),
    authType: source.auth?.type ?? "none",
    username: source.auth?.type === "basic" ? source.auth.username : "",
    filters: watch.filters.map((filter, index) => ({
      id: `watch-filter-${index}`,
      path: filter.path,
      op: filter.op,
      value:
        filter.op === "exists"
          ? ""
          : filter.op !== "in"
            ? filter.value
            : filter.value.every(
                  (value) => value !== "" && !value.includes(",") && value === value.trim(),
                ) && !filter.value[0]!.startsWith("[")
              ? filter.value.join(", ")
              : JSON.stringify(filter.value),
    })),
    maxConcurrentRuns: String(watch.maxConcurrentRuns),
  };
}

const decodeWatchInput = Schema.decodeUnknownOption(ScheduledTaskWatchInput);
const decodeWatchFilter = Schema.decodeUnknownOption(ScheduledTaskWatchFilter);
const decodeFilterList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export function parseWatchDraft(
  draft: WatchDraft,
):
  | { readonly watch: ScheduledTaskWatchInput; readonly watchSecret?: string }
  | { readonly error: string } {
  try {
    const url = new URL(draft.url.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return { error: "Use an HTTP or HTTPS URL without credentials or a fragment." };
  } catch {
    return { error: "Enter a valid source URL." };
  }
  if (draft.filters.length > MAX_WEBHOOK_FILTERS)
    return { error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.` };
  const filters: ScheduledTaskWatchFilter[] = [];
  for (const [index, draftFilter] of draft.filters.entries()) {
    const path = draftFilter.path.trim();
    const text = draftFilter.value.trim();
    const values = text.startsWith("[")
      ? Option.getOrUndefined(decodeFilterList(text))
      : text
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
    const filter = decodeWatchFilter(
      draftFilter.op === "exists"
        ? { path, op: draftFilter.op }
        : { path, op: draftFilter.op, value: draftFilter.op === "in" ? values : draftFilter.value },
    );
    if (Option.isNone(filter))
      return { error: `Filter ${index + 1} needs an item path and a valid value or list.` };
    filters.push(filter.value);
  }
  const auth =
    draft.authType === "none"
      ? undefined
      : draft.authType === "basic"
        ? { type: "basic", username: draft.username.trim() }
        : { type: "bearer" };
  const watch = decodeWatchInput({
    source: {
      ...(draft.sourceType === "jira"
        ? { type: "jira", baseUrl: draft.url.trim(), jql: draft.jql.trim() }
        : {
            type: "http_json",
            url: draft.url.trim(),
            itemsPath: draft.itemsPath,
            keyPath: draft.keyPath.trim(),
          }),
      ...(auth === undefined ? {} : { auth }),
    },
    filters,
    maxConcurrentRuns:
      draft.maxConcurrentRuns.trim() === "" ? undefined : Number(draft.maxConcurrentRuns),
  });
  if (Option.isNone(watch))
    return {
      error: "Check the source fields, authentication username, and run limit from 1 to 4.",
    };
  return {
    watch: watch.value,
    ...(auth !== undefined && draft.secret !== "" ? { watchSecret: draft.secret } : {}),
  };
}

export type ScheduledTaskWithWatch = ScheduledTask & { readonly watch: ScheduledTaskWatch };

export function isWatchTask(task: ScheduledTask): task is ScheduledTaskWithWatch {
  return task.watch !== undefined;
}

export function watchSourceLabel(source: ScheduledTaskWatchSource): string {
  const kind = source.type === "jira" ? "Jira" : "JSON feed";
  try {
    return `${kind} · ${new URL(source.type === "jira" ? source.baseUrl : source.url).host}`;
  } catch {
    return kind;
  }
}

function filterLabel(filter: ScheduledTaskWatchFilter): string {
  const op = WEBHOOK_FILTER_OPS.find((entry) => entry.op === filter.op)?.label ?? filter.op;
  if (filter.op === "exists") return `${filter.path} ${op}`;
  const value = filter.op === "in" ? filter.value.join(", ") : filter.value;
  return `${filter.path} ${op} ${value}`;
}

export function watchRuleLabel(filters: ReadonlyArray<ScheduledTaskWatchFilter>): string {
  const [first, ...rest] = filters;
  if (!first) return "Any new item";
  return rest.length > 0 ? `${filterLabel(first)} +${rest.length} more` : filterLabel(first);
}

export type WatchStatusTone = "muted" | "error" | "info" | "success";

export function watchStatus(task: ScheduledTaskWithWatch): {
  readonly label: string;
  readonly tone: WatchStatusTone;
} {
  if (!task.enabled) return { label: "Paused", tone: "muted" };
  if (task.lastRunStatus === "failed") return { label: "Check failed", tone: "error" };
  if (task.watch.initializedAt === null) return { label: "Setting baseline", tone: "info" };
  return { label: "Watching", tone: "success" };
}

export function watchActivityLabel(watch: ScheduledTaskWatch): string {
  const runs = `${watch.fireCount} ${watch.fireCount === 1 ? "run" : "runs"} started`;
  return [
    watch.activeRunCount > 0
      ? `${watch.activeRunCount} of ${watch.maxConcurrentRuns} running`
      : null,
    watch.pendingCount > 0 ? `${watch.pendingCount} queued` : null,
    runs,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
