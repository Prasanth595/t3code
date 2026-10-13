import type { MachineMapObject } from "./MachineMapObject.ts";

/** Bindings, vars and secrets of the Worker. See `wrangler.jsonc` and the README. */
export interface Env {
  readonly MAP: DurableObjectNamespace<MachineMapObject>;
  readonly TEAM_DOMAIN: string;
  readonly OWNER_EMAILS: string;
  readonly ACCOUNT_ID: string;
  /** The Access app of the machine hostnames. MM-201 adds new machine tokens to its policy. */
  readonly MACHINE_ACCESS_APP_ID: string;
  /** Audience of the Access app of the portal pages and API. */
  readonly PAGE_AUD: string;
  /** Audience of the Access app of `/connect`. */
  readonly CONNECT_AUD: string;
  readonly CONNECT_ACCESS_APP_ID: string;
  /** MM-1205. Optional: without it, "Add machine" takes an existing machine token (MM-210). */
  readonly CF_API_TOKEN?: string;
  /** MM-1201: AES-GCM key for secrets that wait for their machine. */
  readonly SECRET_KEY?: string;
  /** Local development only. See `access.ts`. */
  readonly DEV_FAKE_ACCESS?: string;
}
