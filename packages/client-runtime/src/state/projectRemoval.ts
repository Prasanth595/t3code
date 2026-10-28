import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number;
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  const threadCount = projectThreads.length + (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? `Elimini ${targetKind === "checkout" ? "checkout-ul" : "proiectul"} „${targetLabel}” și ștergi ${threadCount === 1 ? "conversația lui" : `cele ${threadCount} conversații ale lui`}?`
      : `Elimini ${targetKind === "checkout" ? "checkout-ul" : "proiectul"} „${targetLabel}”?`,
    ...(singleMember
      ? [
          `Cale: ${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel ? [`Mediu: ${singleMember.environmentLabel}`] : []),
        ]
      : [`Se elimină ${members.length} intrări de proiect grupate.`]),
    ...(threadCount > 0
      ? ["Se șterge definitiv istoricul acestor conversații și al celor arhivate."]
      : ["Se șterge definitiv istoricul conversațiilor arhivate."]),
    isWholeGroup && !hasOtherMembers
      ? "Se elimină doar intrările proiectului, nu și fișierele de pe disc."
      : "Celelalte intrări din acest proiect grupat nu sunt afectate.",
    "Acțiunea nu poate fi anulată.",
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
