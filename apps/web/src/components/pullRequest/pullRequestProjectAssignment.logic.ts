import {
  pullRequestHostOf,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type PullRequestProviderSummary,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?:
    | Partial<Pick<RepositoryIdentity, "canonicalKey" | "provider" | "locator">>
    | null
    | undefined;
}

export type PullRequestHostAvailability = ReadonlyMap<EnvironmentId, ReadonlyMap<string, boolean>>;

export type PullRequestHostRead = {
  readonly observedAt: number;
  readonly hosts: ReadonlyMap<string, boolean>;
};

export function rememberPullRequestHosts(
  previous: ReadonlyMap<EnvironmentId, PullRequestHostRead>,
  observations: ReadonlyArray<
    readonly [
      EnvironmentId,
      { readonly providers: ReadonlyArray<PullRequestProviderSummary> },
      number,
    ]
  >,
): ReadonlyMap<EnvironmentId, PullRequestHostRead> {
  let next = previous;
  for (const [environmentId, { providers }, observedAt] of observations) {
    const before = next.get(environmentId);
    if (before !== undefined && observedAt <= before.observedAt) continue;
    const hosts = new Map(before?.hosts);
    for (const provider of providers) hosts.set(provider.host.toLowerCase(), provider.configured);
    next = new Map(next).set(environmentId, { observedAt, hosts });
  }
  return next;
}

function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
  hostAvailability?: PullRequestHostAvailability,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  const owner = new Map<string, EnvironmentId>();
  const unreadable = (project: AssignableProject, environmentId: EnvironmentId) =>
    hostAvailability
      ?.get(environmentId)
      ?.get(
        pullRequestHostOf(
          project.repositoryIdentity,
          (project.repositoryIdentity?.provider ?? "unknown") as SourceControlProviderKind,
        ),
      ) === false;
  for (const project of projects) {
    const key = repositoryKey(project);
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (current === undefined) {
      owner.set(key, project.environmentId);
      continue;
    }
    const currentUnreadable = unreadable(project, current);
    const candidateUnreadable = unreadable(project, project.environmentId);
    if (currentUnreadable !== candidateUnreadable) {
      if (currentUnreadable) owner.set(key, project.environmentId);
      continue;
    }
    if (current === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project.environmentId);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = repositoryKey(project);
    if (key && owner.get(key) !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
}

export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly machine?: EnvironmentMachineKind;
}

export function resolvePickableEnvironments(
  current: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly machine?: EnvironmentMachineKind;
  }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const key = own === undefined ? undefined : repositoryKey(own);
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || !key || ownEnvironment === undefined) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    const copy = projects.find(
      (project) =>
        project.environmentId === environment.environmentId && repositoryKey(project) === key,
    );
    return copy === undefined
      ? []
      : [
          {
            environmentId: environment.environmentId,
            projectId: copy.id,
            workspaceRoot: copy.workspaceRoot,
            label: environment.label,
            ...(environment.machine === undefined ? {} : { machine: environment.machine }),
          },
        ];
  });
  if (others.length === 0) return [];
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: own.workspaceRoot,
      label: ownEnvironment.label,
      ...(ownEnvironment.machine === undefined ? {} : { machine: ownEnvironment.machine }),
    },
    ...others,
  ];
}
