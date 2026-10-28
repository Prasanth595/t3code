/**
 * The atom reads the workflow fixtures stub, from the same atoms the app reads. An atom with no
 * stub throws: answering `[]` would make a permission atom read as "allowed". A `vi.mock` factory
 * for the atom library must not import this module; it calls `readQaAtom` through a static import.
 */
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../src/state/server";
import { QA_ENVIRONMENT, QA_PROVIDERS } from "./providers";

const STUBS = new Map<unknown, unknown>([
  [serverEnvironment.providersValueAtom(QA_ENVIRONMENT), QA_PROVIDERS],
  [providersIgnoringCheckedAtAtom(QA_ENVIRONMENT), QA_PROVIDERS],
]);

/** What `useAtomValue(atom, selector)` returns in a fixture. */
export function readQaAtom(atom: unknown, selector?: (value: unknown) => unknown): unknown {
  if (!STUBS.has(atom)) {
    const label = (atom as { readonly label?: ReadonlyArray<string> | string }).label;
    throw new Error(`A workflow fixture read an atom it has no stub for: ${String(label)}`);
  }
  const value = STUBS.get(atom);
  return selector === undefined ? value : selector(value);
}
