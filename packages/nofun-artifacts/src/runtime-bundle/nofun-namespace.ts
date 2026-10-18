/**
 * Installs the artifacts runtime on `target.nofun` without replacing that object.
 *
 * Canvas hosts `window.nofun.canvas` on the same object. Assigning a new
 * `nofun` value drops the page bridge. Callers extend the existing object
 * with `Object.assign` and only define the property when it is missing.
 */
export function extendNofunNamespace(
  target: object,
  api: unknown,
): Record<string, unknown> {
  const host = target as { nofun?: unknown };
  const current = host.nofun;
  const root: Record<string, unknown> =
    current !== null && typeof current === "object"
      ? (current as Record<string, unknown>)
      : {};
  Object.assign(root, { NoFunUI: api });
  if (current !== root) {
    Object.defineProperty(target, "nofun", {
      value: root,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return root;
}
