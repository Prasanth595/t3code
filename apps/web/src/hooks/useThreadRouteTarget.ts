import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import {
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";

// The router re-runs selectors on every store update (preloads, location state,
// same-route navigations) and compares with ===. Selecting the string params keeps
// those updates from reaching consumers; the target is then built once per id change.
function useThreadRouteParams() {
  const environmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  return { environmentId, threadId, draftId };
}

export function useThreadRouteTarget(): ThreadRouteTarget | null {
  const { environmentId, threadId, draftId } = useThreadRouteParams();
  return resolveThreadRouteTarget({ environmentId, threadId, draftId });
}

export function useThreadRouteRef(): ScopedThreadRef | null {
  const { environmentId, threadId } = useThreadRouteParams();
  return resolveThreadRouteRef({ environmentId, threadId });
}
