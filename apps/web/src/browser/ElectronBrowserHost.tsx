"use client";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewOpenLinkEvent,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ComponentProps, useEffect, useEffectEvent, useState } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { applyPreviewServerEvent, useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

/**
 * The server binds a tab to this desktop's browser profile only if the desktop attaches it within
 * seconds of opening; otherwise the tab runs in the server's own browser, without the user's
 * sign-ins. Agents open tabs in threads the user is not viewing, so every server tab opened in the
 * primary environment is seeded here instead of waiting for its thread's view to subscribe.
 */
const serverTabOpeningsAtom = Atom.family((environmentId: EnvironmentId) => {
  const events = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    get.subscribe(events, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type !== "opened" || event.snapshot.runtime !== "server") return;
      applyPreviewServerEvent(scopeThreadRef(environmentId, ThreadId.make(event.threadId)), event);
    });
    get.mount(events);
  });
});

const noServerTabOpeningsAtom = Atom.make(() => undefined);

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  useAtomValue(
    isElectron && primaryEnvironmentId !== null
      ? serverTabOpeningsAtom(primaryEnvironmentId)
      : noServerTabOpeningsAtom,
  );
  // A seeded tab's thread stays synced so its navigation and closing reach the webview below.
  const syncedThreadRefs = Object.keys(previewByThreadKey).flatMap((threadKey) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef?.environmentId === primaryEnvironmentId ? [threadRef] : [];
  });
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  const sessions = activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const onOpenLink = useEffectEvent(({ tabId, url, background }: DesktopPreviewOpenLinkEvent) => {
    const source = sessions.find((session) => session.runtimeTabId === tabId);
    if (!source) return;
    void openUrlInPreview({
      threadRef: source.threadRef,
      url,
      openPreview,
      profileId: source.snapshot.profileId,
      background,
    });
  });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(onOpenLink);
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {syncedThreadRefs.map((threadRef) => (
        <PreviewSessionSync key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      {sessions.map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <AuthorizedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            pictureInPicture={pictureInPicture}
            profileId={snapshot.profileId}
            zoomFactor={zoomFactor}
            serverDriven={snapshot.runtime === "server"}
            {...(snapshot.runtime === "server"
              ? {
                  serverRendering: {
                    colorScheme: snapshot.colorScheme ?? "system",
                    zoomFactor: snapshot.zoomFactor ?? 1,
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}

function PreviewSessionSync({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <HostedBrowserWebview {...props} profileId={profileId} /> : null;
}

/**
 * It is latched once settings load: Electron fixes the partition when the guest attaches, so a
 * later settings change must not move a live tab.
 */
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
