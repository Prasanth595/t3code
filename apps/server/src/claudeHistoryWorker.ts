// @effect-diagnostics nodeBuiltinImport:off -- this isolated SDK entrypoint has a Promise filesystem boundary and never changes the server environment.
import { forkSession, getSessionMessages, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { captureClaudeSessionSnapshot } from "./claudeSessionSnapshot.ts";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      projectsRoot: Schema.optionalKey(Schema.String),
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

const PolicySettings = Schema.StructWithRest(
  Schema.Struct({
    permissions: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          disableBypassPermissionsMode: Schema.optionalKey(Schema.Literal("disable")),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodePolicySettings = Schema.decodeUnknownSync(fromLenientJson(PolicySettings));
const readPolicySettings = async (path: string) => {
  try {
    return decodePolicySettings(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
};
const resolveHandoffPolicy = async (cwd: string) => {
  const root = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(process.env.HOME ?? "", ".claude");
  const remote = await readPolicySettings(NodePath.join(root, "remote-settings.json"));
  const user = await readPolicySettings(NodePath.join(root, "settings.json"));
  const resolved = await resolveSettings({
    cwd,
    settingSources: ["user", "project", "local"],
    serverManagedSettings: remote,
  });
  return {
    bypassDisabled: [remote, user, resolved.effective].some(
      (settings) => settings.permissions?.disableBypassPermissionsMode === "disable",
    ),
  };
};

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "resolveHandoffPolicy"
      ? await resolveHandoffPolicy(options.dir ?? "")
      : method === "captureSession"
        ? await captureClaudeSessionSnapshot({
            nativeId: sessionId,
            cwd: options.dir ?? "",
            projectsRoot: options.projectsRoot ?? "",
          })
        : method === "getSessionMessages"
          ? await getSessionMessages(sessionId, options)
          : method === "forkSession"
            ? await forkSession(sessionId, options).then(async (forked) => {
                const headMessageId = await getSessionMessages(forked.sessionId, options)
                  .then((messages) => messages.at(-1)?.uuid)
                  .catch(() => undefined);
                return headMessageId === undefined ? forked : { ...forked, headMessageId };
              })
            : (() => {
                throw new Error("Unknown Claude history operation.");
              })();
  process.stdout.write(JSON.stringify(result));
}
