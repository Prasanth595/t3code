import type { SaasAccountResponse } from "@t3tools/contracts/saas";

export interface MiraAccess {
  /** False until the account is known, and in builds without Mira accounts. */
  readonly signedIn: boolean;
  readonly account: SaasAccountResponse | null;
  /** Opens the sign-in flow, which also offers creating an account. */
  readonly openSignIn: (() => void) | null;
}

/** Agentic mode needs a plan that includes it. */
export const hasAgenticAccess = (access: MiraAccess) =>
  access.account?.plan.agenticEnabled === true;

/** What the signed-in plan allows, set by the app's account sync and read anywhere. */
export class MiraAccessStore {
  private access: MiraAccess = { signedIn: false, account: null, openSignIn: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.access;

  set(next: MiraAccess) {
    this.access = next;
    for (const listener of this.listeners) listener();
  }
}
