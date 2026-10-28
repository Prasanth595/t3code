import type { ProjectScript } from "@t3tools/contracts";
import { releaseClaimedRoles } from "@t3tools/shared/projectScripts";

export function replaceProjectAction(
  scripts: readonly ProjectScript[],
  saved: ProjectScript,
): readonly ProjectScript[] {
  const next = scripts.map((script) =>
    script.id === saved.id ? saved : releaseClaimedRoles(script, saved),
  );
  return scripts.some((script) => script.id === saved.id) ? next : [...next, saved];
}
