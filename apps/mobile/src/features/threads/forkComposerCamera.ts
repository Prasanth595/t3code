import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { Atom } from "effect/reactivity";

import { environmentServerConfigsAtom } from "../../state/server";

/**
 * Fork: `mobileComposerCamera` is on when a connected server has it on. The machine map syncs
 * it to every server, so they normally agree.
 */
const composerCameraAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom).values()].some(
    (config) => config.settings.mobileComposerCamera,
  ),
).pipe(Atom.withLabel("mobile:fork-composer-camera"));

export function useComposerCameraEnabled(): boolean {
  return useAtomValue(composerCameraAtom);
}

export const TAKE_PHOTO_ACTION_ID = "camera";

/** The plus menu with "Take Photo" after "Photo Library", and without "Choose Files" for a server without files. */
export function withTakePhoto(
  actions: ReadonlyArray<MenuAction>,
  supportsFiles: boolean,
): MenuAction[] {
  return actions.flatMap((action) => {
    if (action.id === "files" && !supportsFiles) return [];
    return action.id === "photos"
      ? [action, { id: TAKE_PHOTO_ACTION_ID, title: "Take Photo", image: "camera" }]
      : [action];
  });
}
