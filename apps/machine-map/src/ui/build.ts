/**
 * MM-1002: the build label of a machine and how it compares with the other online machines.
 * The status `build` is `<kind> <commit>`, for example `live 5abed5f`, or `release`.
 */
import type { MachinePresence, MachineStatus } from "@t3tools/contracts/machineMap";

export const COMMIT_URL = "https://github.com/Yarden-zamir/t3code/commit/";

export interface BuildInfo {
  readonly version: string;
  readonly kind: string;
  /** 7 characters, or null for a release. */
  readonly commit: string | null;
}

const HEX = "0123456789abcdef";
const isCommit = (text: string) =>
  text.length >= 7 && [...text.toLowerCase()].every((char) => HEX.includes(char));

/** An older server sends a 12-character commit or `release <version>`; both still read well. */
export function parseBuild(status: MachineStatus): BuildInfo {
  const [kind = "", second = ""] = status.build.trim().split(" ");
  return {
    version: status.t3Version,
    kind,
    commit: isCommit(second) ? second.slice(0, 7).toLowerCase() : null,
  };
}

export type BuildStanding = "newest" | "behind";

/**
 * Marks each online machine as running the newest build or behind it. The portal cannot order
 * commits (it has no git history), so the newest build is the one with the highest version, then
 * the one whose server started last. The start time is stable while the server runs, unlike the
 * time of the last report. Fewer than two online machines marks nothing: there is nothing to compare.
 */
export function buildStandings(
  presence: Readonly<Record<string, MachinePresence>>,
): ReadonlyMap<string, BuildStanding> {
  const online = Object.entries(presence).flatMap(([id, entry]) => {
    if (!entry.online || entry.status === null) return [];
    const build = parseBuild(entry.status);
    const seenMs = Date.parse(entry.lastSeenAt ?? "");
    return [
      {
        id,
        key: build.commit ?? `${build.kind} ${build.version}`,
        version: build.version,
        startedMs: (Number.isNaN(seenMs) ? 0 : seenMs) - entry.status.uptimeSeconds * 1000,
      },
    ];
  });
  if (online.length < 2) return new Map();
  const [newest] = online.toSorted(
    (a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }) || b.startedMs - a.startedMs,
  );
  return new Map(
    online.map((machine) => [machine.id, machine.key === newest?.key ? "newest" : "behind"]),
  );
}
