import type { AcpRegistrySettings } from "../settings.ts";

// Without this flag Cursor lists one fixed preset per model, such as
// `claude-opus-5-5[context=300k,effort=medium,fast=false]`. With it Cursor lists
// plain model ids and reports effort, context and fast as config options.
export const cursorClientCapabilitiesMeta = { parameterizedModelPicker: true };

// Local installs launch the `cursor-agent` binary directly with no registry id.
export function isCursorAcpAgent(settings: AcpRegistrySettings): boolean {
  return (
    (settings.source !== "local" && settings.agentId === "cursor") ||
    (settings.source === "local" &&
      /^cursor-agent(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? ""))
  );
}

// Threads saved before the flag keep a preset id; open its plain model instead.
export function cursorBaseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}
