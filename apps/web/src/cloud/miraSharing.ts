// Per-account choices that keep automatic account sync from undoing what the user did.

const sharingOffKey = (accountId: string) => `mira:computer-sharing-off:${accountId}`;
const autoAddedKey = (accountId: string) => `mira:auto-added-computers:${accountId}`;

export function isComputerSharingOff(accountId: string): boolean {
  return localStorage.getItem(sharingOffKey(accountId)) === "1";
}

export function setComputerSharingOff(accountId: string, off: boolean): void {
  if (off) localStorage.setItem(sharingOffKey(accountId), "1");
  else localStorage.removeItem(sharingOffKey(accountId));
}

/** Computers added automatically once; a computer the user later removes stays removed. */
export function readAutoAddedComputers(accountId: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(autoAddedKey(accountId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberAutoAddedComputer(accountId: string, environmentId: string): void {
  const ids = new Set(readAutoAddedComputers(accountId));
  ids.add(environmentId);
  localStorage.setItem(autoAddedKey(accountId), JSON.stringify([...ids]));
}
