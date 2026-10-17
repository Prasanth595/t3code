import { formatThreadAppLink, parseThreadAddress } from "@t3tools/shared/threadAddress";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "~/env";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useEnvironmentIds } from "~/state/environments";

import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * Whether this tab came from outside T3 Code: a link from Slack, GitHub or a terminal opens a new
 * tab with no history, no opener and no referrer of this origin. A reload, the desktop app and the
 * installed web app never count. Read once at start, before the app navigates.
 */
function openedFromOutside(): boolean {
  if (typeof window === "undefined" || isElectron) return false;
  const navigation = performance.getEntriesByType("navigation")[0];
  const reload = navigation instanceof PerformanceNavigationTiming && navigation.type === "reload";
  const sameOriginReferrer =
    URL.canParse(document.referrer) && new URL(document.referrer).origin === window.location.origin;
  return (
    window.history.length === 1 &&
    !reload &&
    !window.matchMedia("(display-mode: standalone)").matches &&
    window.opener === null &&
    !sameOriginReferrer
  );
}

const START = openedFromOutside() ? parseThreadAddress(window.location.href) : null;

/**
 * Fork: with the server setting `threadLinksOpenDesktopApp` on, a thread address opened from
 * outside T3 Code (`openedFromOutside`) hands the thread to the desktop app at once and shows a page
 * to continue in the browser. Null in every other case, so the app renders as usual.
 *
 * Known limit: when the desktop app is not running, the link that starts it is lost (upstream
 * #18613). Revisit when #18422 merges upstream.
 */
export function useForkThreadAddressLanding(): ReactNode | null {
  const enabled = usePrimarySettings((settings) => settings.threadLinksOpenDesktopApp);
  const knownIds = useEnvironmentIds();
  const [continued, setContinued] = useState(false);
  if (START === null || !enabled || !knownIds.includes(START.environmentId) || continued) {
    return null;
  }
  return (
    <ThreadAddressLanding
      appLink={formatThreadAppLink(START)}
      onContinue={() => setContinued(true)}
    />
  );
}

function ThreadAddressLanding(props: {
  readonly appLink: string;
  readonly onContinue: () => void;
}) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    window.location.href = props.appLink;
  }, [props.appLink]);

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Opened in T3 Code"
        description="This thread opened in the desktop app. You can also continue in this tab."
      />
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="outline" onClick={props.onContinue}>
          Continue here
        </Button>
        <Button variant="ghost" render={<a href={props.appLink} />}>
          Open in desktop app
        </Button>
      </div>
    </StandalonePage>
  );
}
