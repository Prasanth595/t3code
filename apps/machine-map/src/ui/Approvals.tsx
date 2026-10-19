/**
 * MM-1207, MM-1208: the passkey check of the approval path and the Cloudflare steps before it.
 * The check is a Cloudflare page, not a browser prompt, so the page says what happens.
 */
import { useEffect, useState } from "react";

import {
  type ApprovalsStatus,
  CLOUDFLARE_STEP_PERMISSION,
  type CloudflareStep,
  type PasskeyResponse,
} from "../api.ts";
import { callApi, PASSKEY_STEP_TEXT } from "./apiClient.ts";

const ZERO_TRUST_DASHBOARD = "https://one.dash.cloudflare.com/";
const INDEPENDENT_MFA_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/#turn-on-independent-mfa";
const APP_LAUNCHER_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/";

const PermissionLine = ({ step }: { step: CloudflareStep }) => (
  <p className="hint">
    To let Set up approvals do this step itself, add "{CLOUDFLARE_STEP_PERMISSION[step]}" to the
    CF_API_TOKEN.
  </p>
);

/** Goes to the approval path. Cloudflare asks for the passkey there and returns to this route. */
export const confirmWithPasskey = (): void => {
  location.href = `/api/grant/start?then=${encodeURIComponent(location.hash)}`;
};

let enrollUrlRequest: Promise<string> | null = null;

/** The passkey enrollment page of the Zero Trust organization. Null until the portal answers. */
function useEnrollUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    enrollUrlRequest ??= callApi<PasskeyResponse>("GET", "/api/passkey").then((r) => r.enrollUrl);
    enrollUrlRequest.then(
      (next) => current && setUrl(next),
      () => {
        // The next component asks again. Without the link, the steps still work.
        enrollUrlRequest = null;
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return url;
}

const External = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);

function EnrollLine({ lead, label }: { lead: string; label: string }) {
  const enrollUrl = useEnrollUrl();
  if (enrollUrl === null) return null;
  return (
    <p className="hint">
      {lead} <External href={enrollUrl}>{label}</External>.
    </p>
  );
}

/** What "Confirm with passkey" does, and where to register a first passkey. */
export function PasskeyStepUp() {
  return (
    <div className="passkey-step">
      <p className="hint">{PASSKEY_STEP_TEXT}</p>
      <EnrollLine lead="No passkey yet?" label="Register one first" />
    </div>
  );
}

/** The Zero Trust dashboard steps that "Set up approvals" cannot do with the API token. */
function CloudflareStepGuide({ step }: { step: CloudflareStep }) {
  if (step === "appLauncher") {
    return (
      <div className="v">
        <strong>Turn on the App Launcher in Cloudflare first</strong>
        <ol className="small steps">
          <li>
            Open the <External href={ZERO_TRUST_DASHBOARD}>Zero Trust dashboard</External> and
            choose this account.
          </li>
          <li>Go to Access controls &gt; Access settings.</li>
          <li>Under App Launcher, select Manage.</li>
          <li>Add an Allow policy that includes the owner emails, then Save.</li>
          <li>Come back and select Set up approvals again.</li>
        </ol>
        <p className="hint">
          Cloudflare needs the App Launcher to register a passkey.{" "}
          <External href={APP_LAUNCHER_DOCS}>Cloudflare docs: App Launcher</External>
        </p>
        <PermissionLine step="appLauncher" />
      </div>
    );
  }
  return (
    <div className="v">
      <strong>Allow a passkey in Cloudflare first</strong>
      <ol className="small steps">
        <li>
          Open the <External href={ZERO_TRUST_DASHBOARD}>Zero Trust dashboard</External> and choose
          this account.
        </li>
        <li>Go to Access controls &gt; Access settings.</li>
        <li>
          Under "Allow multi-factor authentication (MFA)", select Biometrics (Touch ID, Face ID,
          Windows Hello), Security key, or both, then Save.
        </li>
        <li>
          Do not turn on "Apply global MFA settings by default". Only the approval path needs MFA.
        </li>
        <li>Come back and select Set up approvals again.</li>
      </ol>
      <EnrollLine
        lead="After setup, Cloudflare asks you to register the passkey at the first approval, or"
        label="register it now"
      />
      <p className="hint">
        <External href={INDEPENDENT_MFA_DOCS}>Cloudflare docs: turn on independent MFA</External>
      </p>
      <PermissionLine step="allowPasskey" />
    </div>
  );
}

/** Why approvals do not work yet, with "Set up approvals". */
export function ApprovalsSetup({
  status,
  disabled = false,
  setUp,
}: {
  status: Exclude<ApprovalsStatus, { _tag: "ready" }>;
  disabled?: boolean;
  setUp: () => void;
}) {
  const button = (
    <button type="button" className="btn small" disabled={disabled} onClick={setUp}>
      Set up approvals
    </button>
  );
  if (status._tag === "missing") {
    return (
      <div className="row callout">
        <div className="v">{status.reason}</div>
        {button}
      </div>
    );
  }
  return (
    <div className="callout cloudflare-step">
      <CloudflareStepGuide step={status.step} />
      <div className="actions">{button}</div>
    </div>
  );
}
