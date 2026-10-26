import {
  NativeSessionSettings,
  NativeSessionRecord,
  type ClaudeSessionIdentityPlan,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ThreadId,
  type OrchestrationV2ServerCommand,
  type NativeSessionOperation,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ClaudeEnrollment } from "./ClaudeSessionJournal.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

type NativeCommandCategory =
  | "create"
  | "independent"
  | "metadata"
  | "controlled"
  | "unsupported"
  | "journal";

const commandCategories: ReadonlyMap<string, NativeCommandCategory> = new Map(
  Object.entries({
    "thread.stop": "controlled",
    "thread.create": "create",
    "thread.archive": "unsupported",
    "thread.guest-share.close": "controlled",
    "thread.guest-message.dismiss": "controlled",
    "thread.unarchive": "unsupported",
    "thread.delete": "unsupported",
    "thread.settle": "unsupported",
    "thread.auto-settle": "unsupported",
    "thread.unsettle": "metadata",
    "thread.snooze": "independent",
    "thread.unsnooze": "independent",
    "thread.auto-settle.set": "metadata",
    "thread.pin": "independent",
    "thread.unpin": "independent",
    "thread.pin.reorder": "independent",
    "thread.active.reorder": "independent",
    "thread.visit": "independent",
    "thread.mark-unread": "independent",
    "thread.metadata.update": "metadata",
    "thread.pull-request.link": "metadata",
    "thread.pull-request.unlink": "metadata",
    "thread.pull-request-link.sync": "metadata",
    "thread.pull-request.watch": "metadata",
    "thread.pull-request.sync": "metadata",
    "thread.title.regeneration.complete": "metadata",
    "thread.runtime-mode.set": "unsupported",
    "thread.interaction-mode.set": "unsupported",
    "thread.model-selection.set": "unsupported",
    "provider-session.detach": "unsupported",
    "message.dispatch": "controlled",
    "prepared-run.release": "controlled",
    "notification.delivery.accept": "controlled",
    "prepared-run.progress": "controlled",
    "prepared-run.fail": "controlled",
    "prepared-run.retry": "controlled",
    "subagent.stop": "controlled",
    "run.interrupt": "independent",
    "queued-message.promote-to-steer": "controlled",
    "queue.resume": "controlled",
    "queued-run.start": "controlled",
    "queued-run.reorder": "controlled",
    "queued-run.cancel": "independent",
    "queued-run.edit": "controlled",
    "runtime-request.respond": "controlled",
    "thread.user-input.dismiss": "controlled",
    "checkpoint.rollback": "unsupported",
    "thread.fork": "unsupported",
    "thread.merge_back": "controlled",
    "delegated_task.request": "controlled",
    "delegated_task.wake-policy": "controlled",
    "delegated_task.completion-delivery.acknowledge": "controlled",
    "delegated_task.completion-delivery.dispose": "controlled",
    "thread.created.record": "independent",
    "provider.switch": "unsupported",
    "thread.guest-share.open": "controlled",
    "thread.guest-share.redeem": "controlled",
    "thread.guest-message.submit": "controlled",
    "thread.pull-request-watch.sync": "controlled",
    "checkpoint.rollback.fail": "controlled",
    "runtime-request.delivery.fail": "controlled",
    "thread.background-work.settle": "controlled",
    "secret_request.record": "independent",
    "claudeSessions.adopt": "journal",
    "claudeSessions.refresh": "journal",
    "claudeSessions.release": "journal",
    "nativeSessions.adopt": "journal",
    "nativeSessions.release": "journal",
    "nativeSessions.refresh": "journal",
  } satisfies Record<
    | OrchestrationV2ServerCommand["type"]
    | `nativeSessions.${NativeSessionOperation["kind"]}`
    | `claudeSessions.${NativeSessionOperation["kind"]}`,
    NativeCommandCategory
  >),
);

export const nativeCommandCategory = (type: string): NativeCommandCategory =>
  commandCategories.get(type) ?? "unsupported";

export function nativePermissionsFit(
  settings: NativeSessionSettings,
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): boolean {
  const mode: RuntimeMode = policy.runtimeMode;
  if (policy.approvalPolicy !== undefined) {
    if (policy.approvalPolicy !== settings.approvalPolicy) return false;
  } else if (
    mode !== "full-access" &&
    settings.approvalPolicy !== (mode === "approval-required" ? "untrusted" : "on-request")
  )
    return false;
  const decoded: Option.Option<NativeSessionSettings["sandboxPolicy"]> =
    policy.sandboxPolicy === undefined
      ? Option.some(
          mode === "full-access"
            ? { type: "dangerFullAccess" as const }
            : mode === "approval-required"
              ? { type: "readOnly" as const }
              : { type: "workspaceWrite" as const },
        )
      : Schema.decodeUnknownOption(NativeSessionSettings.fields.sandboxPolicy, {
          onExcessProperty: "error",
        })(policy.sandboxPolicy);
  if (Option.isNone(decoded)) return false;
  const allowed = decoded.value;
  const native = settings.sandboxPolicy;
  if (allowed.type === "dangerFullAccess") return true;
  if (
    native.type === "dangerFullAccess" ||
    (native.networkAccess === true && allowed.networkAccess !== true)
  )
    return false;
  if (native.type === "readOnly") return true;
  if (allowed.type !== "workspaceWrite") return false;
  const roots = [policy.cwd, ...(allowed.writableRoots ?? [])];
  return (
    (native.writableRoots ?? []).every((root) => roots.includes(root)) &&
    (allowed.excludeSlashTmp !== true || native.excludeSlashTmp === true) &&
    (allowed.excludeTmpdirEnvVar !== true || native.excludeTmpdirEnvVar === true)
  );
}

const decodeCodexOwner = Schema.decodeEffect(Schema.fromJsonString(NativeSessionRecord));
const decodeClaudeOwner = Schema.decodeEffect(Schema.fromJsonString(ClaudeEnrollment));

export const nativeCommandOwners = Effect.fn("NativeSessionPolicy.owners")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ provider: "codex" | "claude"; payload_json: string }>`
    SELECT 'codex' AS provider, payload_json FROM orchestration_v2_native_sessions WHERE thread_id IN ${sql.in(threadIds)}
    UNION ALL
    SELECT 'claude' AS provider, payload_json FROM orchestration_v2_claude_sessions WHERE thread_id IN ${sql.in(threadIds)}
  `;
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      if (row.provider === "codex")
        return {
          provider: "codex" as const,
          record: yield* decodeCodexOwner(row.payload_json),
        };
      return {
        provider: "claude" as const,
        record: yield* decodeClaudeOwner(row.payload_json),
      };
    }),
  );
});

export const claudeModelSelectionFits = (
  plan: ClaudeSessionIdentityPlan,
  selection: ModelSelection,
) =>
  selection.instanceId === plan.providerInstanceId &&
  selection.model === plan.selection.model &&
  (selection.options ?? []).every(
    (option) => option.id === "effort" && option.value === plan.selection.effort,
  ) &&
  (selection.options ?? []).length === (plan.selection.effort === undefined ? 0 : 1);

export const claudeThreadSettingsFit = (
  plan: ClaudeSessionIdentityPlan,
  thread: OrchestrationV2AppThread,
) =>
  thread.projectId === plan.projectId &&
  thread.providerInstanceId === plan.providerInstanceId &&
  claudeModelSelectionFits(plan, thread.modelSelection) &&
  thread.runtimeMode === plan.selection.runtimeMode &&
  thread.interactionMode === "default" &&
  (thread.worktreePath === null || thread.worktreePath === plan.cwd.path) &&
  thread.archivedAt === null &&
  thread.deletedAt === null;
