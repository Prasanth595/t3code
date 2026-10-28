import type { ProjectScript } from "@t3tools/contracts";

export function replaceProjectAction(
  scripts: readonly ProjectScript[],
  saved: ProjectScript,
): readonly ProjectScript[] {
  const next = scripts.map((script) =>
    script.id === saved.id
      ? saved
      : {
          ...script,
          ...(saved.runOnWorktreeCreate ? { runOnWorktreeCreate: false } : {}),
          ...(saved.runOnSettle ? { runOnSettle: false } : {}),
        },
  );
  return scripts.some((script) => script.id === saved.id) ? next : [...next, saved];
}
