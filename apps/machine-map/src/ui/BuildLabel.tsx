import type { MachineStatus } from "@t3tools/contracts/machineMap";
import type { SyntheticEvent } from "react";

import { type BuildStanding, COMMIT_URL, parseBuild } from "./build.ts";

// The machine card drags and selects on pointer events; the commit link must not do either.
const keepInLink = (event: SyntheticEvent) => event.stopPropagation();

/** MM-1002: `<version> · <kind> <commit>`, with the commit linked to GitHub. */
export function BuildLabel({ status }: { readonly status: MachineStatus }) {
  const build = parseBuild(status);
  return (
    <span className="mono build">
      {build.version} · {build.kind}
      {build.commit !== null && (
        <>
          {" "}
          <a
            href={`${COMMIT_URL}${build.commit}`}
            target="_blank"
            rel="noreferrer"
            onPointerDown={keepInLink}
            onClick={keepInLink}
          >
            {build.commit}
          </a>
        </>
      )}
    </span>
  );
}

/** MM-1002: NEWEST or BEHIND among the online machines; nothing when there is nothing to compare. */
export function BuildSticker({ standing }: { readonly standing: BuildStanding | undefined }) {
  if (standing === undefined) return null;
  return <span className={`sticker ${standing === "newest" ? "ok" : "warn"}`}>{standing}</span>;
}
