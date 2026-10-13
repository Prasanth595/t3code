import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";

/** Let the browser or native download manager stream the signed attachment response. */
export async function downloadFile(url: string, name: string) {
  const api = isElectron ? readLocalApi() : null;
  if (api) return api.shell.openExternal(url);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.click();
}
