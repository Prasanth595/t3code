import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

let mainAppEntry: { href: string; historyIndex: number | null } | null = null;

export function MainAppLocationTracker() {
  const { history } = useRouter();
  useEffect(() => {
    const { location } = history;
    if (!isSidebarUtilityPage(location.pathname)) {
      mainAppEntry = { href: location.href, historyIndex: location.state.__TSR_index };
    }
    return history.subscribe(({ location, action }) => {
      const historyIndex = location.state.__TSR_index;
      if (!isSidebarUtilityPage(location.pathname)) {
        mainAppEntry = { href: location.href, historyIndex };
      } else if (
        mainAppEntry?.historyIndex != null &&
        ((action.type === "PUSH" && historyIndex <= mainAppEntry.historyIndex) ||
          (action.type === "REPLACE" && historyIndex === mainAppEntry.historyIndex))
      ) {
        mainAppEntry = { href: mainAppEntry.href, historyIndex: null };
      }
    });
  }, [history]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  const router = useRouter();
  return () => {
    // Pushing the thread URL again would leave Settings in the way of earlier threads.
    const stepsBack =
      mainAppEntry?.historyIndex != null
        ? router.history.location.state.__TSR_index - mainAppEntry.historyIndex
        : 0;
    if (stepsBack !== 0) {
      router.history.go(-stepsBack);
      return;
    }
    void navigate({ href: mainAppEntry?.href ?? "/" });
  };
}
