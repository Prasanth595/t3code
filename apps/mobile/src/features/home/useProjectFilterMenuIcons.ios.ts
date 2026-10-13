import { useAtomValue } from "@effect/atom-react";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PixelRatio } from "react-native";
import { resolveProjectIconGlyph } from "../../lib/projectIcon";
import { projectFaviconUrlAtom } from "../../state/assets";
import type { HomeListFilterMenuIcon, HomeListFilterMenuProject } from "./home-list-filter-menu";

const MENU_ICON_SIZE = 20;
const FOLDER_ICON: HomeListFilterMenuIcon = { type: "sfSymbol", name: "folder.fill" };

// UIKit builds the menu synchronously, so the favicon has to be handed over as
// bytes (a data URI) instead of a URL the native image loader would fetch later.
// Loaded favicons live in a module-level store shared by every filter menu.
let faviconDataUris: ReadonlyMap<string, string | null> = new Map();
const pendingFavicons = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return faviconDataUris;
}

function loadFaviconDataUri(url: string) {
  if (pendingFavicons.has(url)) return;
  pendingFavicons.add(url);
  void fetch(url)
    .then((response) => (response.ok ? response.blob() : null))
    .then(
      (blob) =>
        new Promise<string | null>((resolve) => {
          if (!blob) return resolve(null);
          const reader = new FileReader();
          reader.addEventListener("error", () => resolve(null));
          reader.addEventListener("load", () =>
            resolve(typeof reader.result === "string" ? reader.result : null),
          );
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => null)
    .then((dataUri) => {
      pendingFavicons.delete(url);
      faviconDataUris = new Map(faviconDataUris).set(url, dataUri);
      for (const listener of listeners) listener();
    });
}

export function useProjectFilterMenuIcons<T extends HomeListFilterMenuProject>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const faviconUrls = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          projects.map((project) => {
            const representative = project.representative;
            if (
              !representative ||
              resolveProjectIconGlyph(representative.projectIcon, project.label) !== null
            ) {
              return null;
            }
            const url = get(
              projectFaviconUrlAtom({
                environmentId: representative.environmentId,
                cwd: representative.workspaceRoot,
                faviconPath: representative.faviconPath,
              }),
            );
            return isProjectFaviconFallbackUrl(url) ? null : url;
          }),
        ),
      [projects],
    ),
  );

  const dataUris = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    for (const url of faviconUrls) {
      if (url && !getSnapshot().has(url)) loadFaviconDataUri(url);
    }
  }, [faviconUrls]);

  return useMemo(
    () =>
      projects.map((project, index) => {
        const url = faviconUrls[index];
        const uri = url ? dataUris.get(url) : null;
        return {
          ...project,
          icon: uri
            ? {
                type: "imageSource" as const,
                imageSource: {
                  uri,
                  width: MENU_ICON_SIZE,
                  height: MENU_ICON_SIZE,
                  scale: PixelRatio.get(),
                },
              }
            : FOLDER_ICON,
        };
      }),
    [dataUris, faviconUrls, projects],
  );
}
