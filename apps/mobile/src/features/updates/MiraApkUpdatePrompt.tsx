import { useEffect } from "react";
import { AppState } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import {
  type ApkRelease,
  checkForApkUpdate,
  downloadAndInstallApk,
  isApkUpdateSupported,
} from "./apk-updates";

const RECHECK_MS = 6 * 60 * 60 * 1000;

let lastCheckAt = 0;
const offeredTags = new Set<string>();
let installing = false;

export async function installApkRelease(release: ApkRelease): Promise<void> {
  if (installing) return;
  installing = true;
  try {
    const outcome = await downloadAndInstallApk(release);
    if (outcome === "needs-permission") {
      Dialog.alert(
        "Permite instalarea",
        "Activează „Permite din această sursă” pentru Mira, apoi revino și apasă din nou Actualizează.",
      );
    }
  } catch (cause) {
    Dialog.alert(
      "Actualizarea nu a putut fi descărcată",
      cause instanceof Error ? cause.message : "Încearcă din nou.",
    );
  } finally {
    installing = false;
  }
}

async function offerUpdate() {
  if (Date.now() - lastCheckAt < RECHECK_MS) return;
  lastCheckAt = Date.now();
  const release = await checkForApkUpdate().catch(() => null);
  if (!release || offeredTags.has(release.tag)) return;
  offeredTags.add(release.tag);
  Dialog.alert("Actualizare disponibilă", `Versiunea ${release.name} e gata. O instalezi acum?`, [
    { text: "Mai târziu", style: "cancel" },
    { text: "Actualizează", onPress: () => void installApkRelease(release) },
  ]);
}

/** Offers a newer release once per launch and again when the app returns after a while. */
export function MiraApkUpdatePrompt() {
  useEffect(() => {
    if (!isApkUpdateSupported()) return;
    void offerUpdate();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void offerUpdate();
    });
    return () => subscription.remove();
  }, []);
  return null;
}
