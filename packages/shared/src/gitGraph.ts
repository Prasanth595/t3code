import type { GitHistoryCommit } from "@t3tools/contracts";

export const GIT_GRAPH_ROW_HEIGHT = 32;
const LANE_WIDTH = 14;
const laneX = (lane: number) => 10 + lane * LANE_WIDTH;

/** Lay out a topologically ordered DAG, retaining lane positions until their histories join. */
export function layoutGitGraph(commits: ReadonlyArray<GitHistoryCommit>) {
  const lanes: Array<{ sha: string; color: number } | null> = [];
  const loaded = new Set(commits.map((commit) => commit.sha));
  let color = 0;
  let width = 24;
  const rows = commits.map((commit) => {
    let lane = lanes.findIndex((entry) => entry?.sha === commit.sha);
    const incoming = lane >= 0;
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = { sha: commit.sha, color: color++ % 5 };
    }
    const node = lanes[lane]!;
    const paths: Array<{ d: string; color: number }> = [];
    for (let index = 0; index < lanes.length; index++) {
      const entry = lanes[index];
      if (entry === null || entry === undefined || index === lane) continue;
      paths.push({ d: `M ${laneX(index)} 0 V 32`, color: entry.color });
    }
    if (incoming) paths.push({ d: `M ${laneX(lane)} 0 V 16`, color: node.color });
    lanes[lane] = null;
    for (const [index, parent] of [...new Set(commit.parents)].entries()) {
      // History past the loaded window fades out within the row instead of holding a lane open,
      // so a base full of sync merges does not widen the graph row after row.
      if (!loaded.has(parent)) {
        const from = laneX(lane);
        const to = laneX(lane + index);
        paths.push({
          d: from === to ? `M ${from} 16 V 26` : `M ${from} 16 C ${from} 23 ${to} 21 ${to} 26`,
          color: index === 0 ? node.color : color++ % 5,
        });
        width = Math.max(width, to + 12);
        continue;
      }
      let parentLane = lanes.findIndex((entry) => entry?.sha === parent);
      if (parentLane < 0) {
        parentLane = index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null);
        if (parentLane < 0) parentLane = lanes.length;
        lanes[parentLane] = { sha: parent, color: index === 0 ? node.color : color++ % 5 };
      }
      const from = laneX(lane);
      const to = laneX(parentLane);
      paths.push({
        d: from === to ? `M ${from} 16 V 32` : `M ${from} 16 C ${from} 27 ${to} 21 ${to} 32`,
        color: lanes[parentLane]!.color,
      });
    }
    width = Math.max(width, laneX(lanes.length - 1) + 12, laneX(lane) + 12);
    return { commit, x: laneX(lane), color: node.color, paths };
  });
  return { rows, width };
}

/**
 * Commits only the head branch contributes: ancestors of `headSha` that `baseSha` reaches without
 * passing through the head, so a base that already merged the head still leaves its commits.
 */
export function branchOnlyShas(
  commits: ReadonlyArray<GitHistoryCommit>,
  headSha: string | null,
  baseSha: string | null,
): ReadonlySet<string> {
  const parents = new Map(commits.map((commit) => [commit.sha, commit.parents]));
  const walk = (from: string | null, stop: string | null) => {
    const seen = new Set<string>();
    const queue = from === null ? [] : [from];
    for (let sha = queue.pop(); sha !== undefined; sha = queue.pop()) {
      if (sha === stop || seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(parents.get(sha) ?? []));
    }
    return seen;
  };
  const base = walk(baseSha, headSha);
  return new Set([...walk(headSha, null)].filter((sha) => !base.has(sha)));
}
