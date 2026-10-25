// @effect-diagnostics nodeBuiltinImport:off - runs inside Vite+ before project services start.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { flushTelemetry, observeSummaries } from "./telemetry.ts";

export default function start({ root }: { readonly root: string }) {
  const configured = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, ".task-cache.json"), "utf8"),
  );
  if (!process.env.VP_REMOTE_CACHE_URL) {
    try {
      const credentials = JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(NodeOS.homedir(), ".config/t3-task-cache/credentials.json"),
          "utf8",
        ),
      );
      const credential = credentials[configured.endpoint];
      if (credential) {
        const url = new URL(configured.endpoint);
        url.username = credential.name;
        url.password = credential.token;
        process.env.VP_REMOTE_CACHE_URL = url.href;
        process.env.VP_REMOTE_CACHE ||= "read-write";
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (!process.env.VP_REMOTE_CACHE_URL) return;
  const endpoint = new URL(process.env.VP_REMOTE_CACHE_URL);
  endpoint.username = "";
  endpoint.password = "";
  if (process.env.T3_TASK_CACHE_TELEMETRY === "off") return;
  const stop = observeSummaries(root, endpoint.href.replace(/\/$/, ""), process.env);
  return async () => {
    stop();
    await flushTelemetry();
  };
}
