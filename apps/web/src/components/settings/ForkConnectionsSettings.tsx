/**
 * The fork parts of `ConnectionsSettings.tsx`: request headers per origin (for proxies such as
 * Cloudflare Access), the Access sign-in message and the sibling sign-in rows. The upstream file
 * imports this module once and keeps one line per hook.
 */
import {
  CLOUDFLARE_ACCESS_MESSAGE,
  type ConnectionCatalogEntry,
  requestHeaderOrigin,
} from "@t3tools/client-runtime/connection";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  readRequestHeaders as readRequestHeadersAtom,
  saveRequestHeaders as saveRequestHeadersAtom,
} from "~/connection/onboarding";
import { type SiblingIssue, useSiblingIssues } from "~/connection/siblingEnvironments";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  EMPTY_REQUEST_HEADERS_FORM,
  OriginRequestHeadersEditor,
  RequestHeadersFields,
  type RequestHeadersForm,
  environmentRequestHeaderOrigins,
  isCloudflareAccessChallenged,
  requestHeadersFromForm,
  supportsRequestHeaders,
  useCloudflareAccessChallenged,
} from "./RequestHeadersEditor";
import { SettingsRow } from "./settingsLayout";

export { TunnelPairingSettingsRow } from "./TunnelPairingSettingsRow";

/** Request headers and the Access state of one saved backend row. */
export function useEnvironmentRequestHeaders(
  entry: ConnectionCatalogEntry,
  connectionError: string | null,
) {
  const [open, setOpen] = useState(false);
  const origins = supportsRequestHeaders() ? environmentRequestHeaderOrigins(entry) : [];
  const accessChallenged = useCloudflareAccessChallenged(origins, connectionError);
  return { open, setOpen, origins, accessChallenged };
}
type EnvironmentRequestHeaders = ReturnType<typeof useEnvironmentRequestHeaders>;

/** The line that the row subtitle adds while Cloudflare Access asks for a sign-in. */
export const accessChallengeSubtitle = (show: boolean) =>
  show ? `\n${CLOUDFLARE_ACCESS_MESSAGE}` : "";

export function AccessChallengeMessage({ show }: { readonly show: boolean }) {
  return show ? <p className="mt-1 text-xs text-destructive">{CLOUDFLARE_ACCESS_MESSAGE}</p> : null;
}

export function RequestHeadersToggle({
  state,
  environmentId,
}: {
  readonly state: EnvironmentRequestHeaders;
  readonly environmentId: string;
}) {
  const { open, setOpen, origins } = state;
  return origins.length > 0 ? (
    <>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`request-headers-${environmentId}`}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        Request headers
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
    </>
  ) : null;
}

export function RequestHeadersPanel({
  state,
  environmentId,
}: {
  readonly state: EnvironmentRequestHeaders;
  readonly environmentId: string;
}) {
  const { open, origins } = state;
  return open ? (
    <div
      id={`request-headers-${environmentId}`}
      className="mt-2 max-w-xl border-t border-border/50"
    >
      {origins.map((origin) => (
        <OriginRequestHeadersEditor key={origin} origin={origin} showOrigin={origins.length > 1} />
      ))}
    </div>
  ) : null;
}

type RemotePairingInput = Parameters<typeof resolveRemotePairingTarget>[0];
type RequestHeaders = ReadonlyArray<{ readonly name: string; readonly value: string }>;
export type PairingRequestHeaders =
  | { readonly _tag: "Error"; readonly message: string }
  | {
      readonly _tag: "Saved";
      /** A failed pairing saves no environment, so this restores the origin's headers. */
      readonly restore: () => Promise<void>;
      /** The Access sign-in message when Access blocked the pairing, else `fallback`. */
      readonly failureMessage: (fallback: string) => Promise<string>;
    };

/** The request headers form of the add backend dialog. */
export function useAddBackendRequestHeaders() {
  const readRequestHeaders = useAtomCommand(readRequestHeadersAtom, { reportFailure: false });
  const saveRequestHeaders = useAtomCommand(saveRequestHeadersAtom, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RequestHeadersForm>(EMPTY_REQUEST_HEADERS_FORM);

  const reset = useCallback(() => {
    setForm(EMPTY_REQUEST_HEADERS_FORM);
    setOpen(false);
  }, []);

  // Headers are keyed by origin, so they are saved before pairing to let
  // the pairing request itself pass a proxy such as Cloudflare Access.
  const saveForPairing = useCallback(
    async (input: RemotePairingInput): Promise<PairingRequestHeaders> => {
      let httpBaseUrl: string;
      try {
        httpBaseUrl = resolveRemotePairingTarget(input).httpBaseUrl;
      } catch (error) {
        return {
          _tag: "Error",
          message: error instanceof Error ? error.message : "Failed to add backend.",
        };
      }
      const headerOrigin = requestHeaderOrigin(httpBaseUrl);
      const parsedHeaders = requestHeadersFromForm(form);
      if ("error" in parsedHeaders) {
        return { _tag: "Error", message: parsedHeaders.error };
      }
      let previousHeaders: RequestHeaders | null = null;
      if (headerOrigin !== null && parsedHeaders.headers.length > 0) {
        const previous = await readRequestHeaders(headerOrigin);
        const saved =
          previous._tag === "Success"
            ? await saveRequestHeaders({ origin: headerOrigin, headers: parsedHeaders.headers })
            : previous;
        if (previous._tag !== "Success" || saved._tag !== "Success") {
          return { _tag: "Error", message: "Could not save the request headers." };
        }
        previousHeaders = previous.value;
      }
      return {
        _tag: "Saved",
        restore: async () => {
          if (headerOrigin !== null && previousHeaders !== null) {
            await saveRequestHeaders({ origin: headerOrigin, headers: previousHeaders });
          }
        },
        failureMessage: async (fallback) =>
          (await isCloudflareAccessChallenged(httpBaseUrl)) ? CLOUDFLARE_ACCESS_MESSAGE : fallback,
      };
    },
    [form, readRequestHeaders, saveRequestHeaders],
  );

  return useMemo(
    () => ({ open, setOpen, form, setForm, reset, saveForPairing }),
    [open, form, reset, saveForPairing],
  );
}
type AddBackendRequestHeaders = ReturnType<typeof useAddBackendRequestHeaders>;

export function AddBackendRequestHeadersFields({
  state,
  disabled,
}: {
  readonly state: AddBackendRequestHeaders;
  readonly disabled: boolean;
}) {
  const { open, setOpen, form, setForm } = state;
  return supportsRequestHeaders() ? (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className="inline-flex items-center gap-0.5 rounded-sm text-xs font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        Request headers
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="mt-2">
          <RequestHeadersFields form={form} disabled={disabled} onChange={setForm} />
        </div>
      ) : null}
    </div>
  ) : null;
}

// Trusted siblings that could not pair yet. Most often the browser has no
// Cloudflare Access cookie for them: opening one signs in, and the page tries
// again when it gets focus. A browser key can also wait for approval (MM-918),
// or the machine map can be paused (MM-718).
const SIBLING_ISSUE_TEXT: Record<SiblingIssue, { title: string; description: string }> = {
  "sign-in": {
    title: "Sign in at",
    description: "Open it once to sign in with Cloudflare Access, then come back to this tab.",
  },
  waiting: {
    title: "Waiting for approval at",
    description: "Approve this browser in the machine map portal. The page checks every minute.",
  },
  paused: {
    title: "Paused at",
    description: "The machine map is paused. The page tries again in 10 minutes.",
  },
};

export function SiblingSignInRows() {
  const issues = useSiblingIssues();
  return [...issues].map(([origin, issue]) => (
    <SettingsRow
      key={origin}
      title={`${SIBLING_ISSUE_TEXT[issue].title} ${origin}`}
      description={SIBLING_ISSUE_TEXT[issue].description}
      control={
        <Button
          size="xs"
          variant="outline"
          render={<a href={origin} target="_blank" rel="noreferrer" />}
        >
          Open
        </Button>
      }
    />
  ));
}
