import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  it("limits a checkout's thread count to its environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        { environmentId: local.environmentId, projectId: local.id },
        { environmentId: remote.environmentId, projectId: remote.id },
      ],
    });
    expect(plan.projectThreads).toHaveLength(1);
    expect(plan.confirmationMessage).toBe(
      "Elimini checkout-ul „Repo” și ștergi conversația lui?\nCale: /work/repo\nMediu: Local\nSe șterge definitiv istoricul acestor conversații și al celor arhivate.\nCelelalte intrări din acest proiect grupat nu sunt afectate.\nAcțiunea nu poate fi anulată.",
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Mediu: Remote");
    expect(plan.confirmationMessage).toContain(
      "Celelalte intrări din acest proiect grupat nu sunt afectate.",
    );
    expect(plan.confirmationMessage).toContain(
      "Se șterge definitiv istoricul conversațiilor arhivate.",
    );
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("Se elimină 2 intrări de proiect grupate.");
    expect(plan.confirmationMessage).toContain(
      "Se elimină doar intrările proiectului, nu și fișierele de pe disc.",
    );
  });
});
