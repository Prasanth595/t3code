import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type FileChange = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

export function toolCallPatch(item: Pick<FileChange, "diffStr" | "fileName" | "changes">) {
  let patch = item.diffStr;
  if (!patch || patch.startsWith("diff --git ") || patch.startsWith("--- ")) return patch;
  const change = item.changes?.[0];
  // Codex can record added/deleted file contents or bare hunks instead of a complete patch.
  if (!patch.trimStart().startsWith("@@ ")) {
    if (change?.operation !== "add" && change?.operation !== "delete") return patch;
    const lines = patch.split("\n");
    const hasFinalNewline = patch.endsWith("\n");
    if (hasFinalNewline) lines.pop();
    const added = change.operation === "add";
    const range = `1,${lines.length}`;
    patch = `@@ -${added ? "0,0" : range} +${added ? range : "0,0"} @@\n${lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n")}\n${hasFinalNewline ? "" : "\\ No newline at end of file\n"}`;
  }
  const oldPath = change?.oldPath ?? item.fileName;
  const newPath = change?.path ?? item.fileName;
  const before = change?.operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
  const after = change?.operation === "delete" ? "/dev/null" : JSON.stringify(`b/${newPath}`);
  return `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${newPath}`)}\n--- ${before}\n+++ ${after}\n${patch.trimStart()}`;
}
