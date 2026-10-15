import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

/** What the shared bridge has already checked before a backend runs a ceremony. */
export interface PasskeyCeremonyContext {
  /** The committed origin of the frame that asked; never the page's own claim. */
  readonly origin: string;
  readonly nativeWindowHandle: Buffer;
}

/**
 * The bridge in `Passkeys.ts` owns everything platform-neutral: which frame may
 * ask, focus, one ceremony at a time, the deadline, and dropping results for a
 * page that navigated away.
 */
export interface PasskeyBackend {
  readonly create: (
    publicKey: PublicKeyCredentialCreationOptions,
    context: PasskeyCeremonyContext,
  ) => Promise<PasskeyCeremonyResult>;
  readonly get: (
    publicKey: PublicKeyCredentialRequestOptions,
    context: PasskeyCeremonyContext,
  ) => Promise<PasskeyCeremonyResult>;
}
