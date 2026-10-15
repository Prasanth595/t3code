/**
 * - `contextIsolation=false`: the picker preload needs to share `globalThis`
 *   with the page so react-grab/bippy can read the React DevTools hook
 *   (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) and resolve component names. Without
 *   this every pick comes back with `componentName: null` even on dev React
 *   apps.
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Critical
 *   when paired with `contextIsolation=false` — without sandbox, the preload
 *   has full Node access (`require`, `fs`, `child_process`, ...) and that
 *   `require` would land on the page's shared `globalThis`, giving any
 *   third-party page in the preview full Node + IPC access to the host.
 *   In sandboxed mode Electron still synthesizes the `electron` module for
 *   the preload's `import { ipcRenderer }` line, but no Node globals leak.
 * - Whitespace-free. Electron's webpreferences parser splits on `,` and
 *   does not trim, so a leading space would turn a key into an unknown one
 *   and silently drop it.
 * - Values are JS-boolean strings (`true`/`false`) — `yes`/`no` are not
 *   special-cased by the parser; `value="no"` becomes the truthy STRING
 *   `"no"` when assigned to a boolean webPreferences key.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";
