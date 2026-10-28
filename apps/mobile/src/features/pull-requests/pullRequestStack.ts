import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestRef, PullRequestStack, ThreadPullRequestLink } from "@t3tools/contracts";

export function pullRequestStackMerge(
  stack: PullRequestStack,
  number: number,
  terminology: ChangeRequestTerminology,
) {
  const position = stack.layers.findIndex((layer) => layer.number === number);
  const layers = stack.layers.slice(0, position + 1).filter((layer) => layer.state !== "merged");
  const heads = layers.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const reason =
    position < 0
      ? `Acest ${terminology.singular} nu mai e în stack. Reîmprospătează-l.`
      : stack.layers[position]?.state !== "open" || layers.length === 0
        ? `Nu există straturi deschise de îmbinat până la acest ${terminology.singular}.`
        : layers.some((layer) => layer.state !== "open")
          ? "Redeschide straturile închise înainte de merge."
          : layers.some((layer) => layer.isDraft)
            ? "Marchează fiecare strat ca gata de revizuire."
            : heads.length !== layers.length
              ? "Reîmprospătează stack-ul ca să încarci ultimele versiuni înainte de merge."
              : null;
  return { position: position + 1, layers, heads, reason };
}

/** Saved membership supplies navigation while offline, never revisions for a merge. */
export function savedPullRequestStack(
  links: readonly ThreadPullRequestLink[],
  reference: PullRequestRef,
): PullRequestStack | null {
  const matches = links.filter(
    (link) =>
      link.host.toLowerCase() === reference.host?.toLowerCase() &&
      link.repository.toLowerCase() === reference.repository.toLowerCase(),
  );
  const candidates = matches.filter(
    (link) =>
      link.number === reference.number ||
      link.stack?.layers.some((layer) => layer.number === reference.number),
  );
  const newest = [...candidates].sort(
    (a, b) =>
      Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
      Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
  )[0]?.stack;
  if (!newest?.layers.some((layer) => layer.number === reference.number)) return null;
  return {
    ...newest,
    layers: newest.layers.map((layer) => {
      const snapshot = [...matches]
        .filter((link) => link.number === layer.number)
        .sort(
          (a, b) =>
            Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
            Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
        )[0]?.snapshot;
      return {
        number: layer.number,
        headBranch: layer.headBranch,
        state: layer.state,
        ...(snapshot ? { title: snapshot.title, isDraft: snapshot.isDraft } : {}),
      };
    }),
  };
}

export function singlePullRequestMergeAllowed(input: {
  readonly supportsStackActions: boolean;
  readonly hasStack: boolean;
  readonly isFresh: boolean;
}) {
  return !input.supportsStackActions || (!input.hasStack && input.isFresh);
}
