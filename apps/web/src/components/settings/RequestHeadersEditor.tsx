import {
  CLOUDFLARE_ACCESS_CLIENT_ID_HEADER,
  type ConnectionCatalogEntry,
  connectionRoutes,
  requestHeaderOrigin,
  CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER,
  type RequestHeader,
  requestHeadersError,
} from "@t3tools/client-runtime/connection";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readRequestHeaders, saveRequestHeaders } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** A generic header row. `id` only keys the row while editing. */
type RequestHeaderRow = RequestHeader & { readonly id: number };
let nextRequestHeaderRowId = 0;
const requestHeaderRow = (header: RequestHeader): RequestHeaderRow => ({
  ...header,
  id: nextRequestHeaderRowId++,
});

/** Form state: the Cloudflare Access preset plus any other headers. */
export interface RequestHeadersForm {
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly custom: ReadonlyArray<RequestHeaderRow>;
}

export const EMPTY_REQUEST_HEADERS_FORM: RequestHeadersForm = {
  accessClientId: "",
  accessClientSecret: "",
  custom: [],
};

/** Only the desktop app can add headers to WebSocket handshakes. */
export function supportsRequestHeaders(): boolean {
  return window.desktopBridge?.setConnectionCatalog !== undefined;
}

/** The distinct origins of an environment's direct (bearer) routes. */
export function environmentRequestHeaderOrigins(
  entry: ConnectionCatalogEntry,
): ReadonlyArray<string> {
  const origins = connectionRoutes(entry).flatMap((route) =>
    route.profile._tag === "Some" && route.profile.value._tag === "BearerConnectionProfile"
      ? (requestHeaderOrigin(route.profile.value.httpBaseUrl) ?? [])
      : [],
  );
  return [...new Set(origins)];
}

/** Asks the desktop app whether the last response from `url` was a Cloudflare Access login. */
export async function isCloudflareAccessChallenged(url: string): Promise<boolean> {
  const query = window.desktopBridge?.isCloudflareAccessChallenged;
  if (query === undefined) return false;
  try {
    return await query(url);
  } catch {
    return false;
  }
}

/**
 * True while any of `origins` answered with a Cloudflare Access challenge.
 * Re-checks when `failure` changes, so pass the current connection error.
 */
export function useCloudflareAccessChallenged(
  origins: ReadonlyArray<string>,
  failure: string | null,
): boolean {
  const [challenged, setChallenged] = useState(false);
  const originsKey = origins.join(" ");
  useEffect(() => {
    if (failure === null || originsKey === "") return;
    let cancelled = false;
    void Promise.all(originsKey.split(" ").map(isCloudflareAccessChallenged)).then((results) => {
      if (!cancelled) setChallenged(results.some(Boolean));
    });
    return () => {
      cancelled = true;
    };
  }, [failure, originsKey]);
  return failure !== null && originsKey !== "" && challenged;
}

function isHeaderName(header: RequestHeader, name: string): boolean {
  return header.name.toLowerCase() === name.toLowerCase();
}

export function requestHeadersToForm(headers: ReadonlyArray<RequestHeader>): RequestHeadersForm {
  const isPreset = (header: RequestHeader) =>
    isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_ID_HEADER) ||
    isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER);
  return {
    accessClientId:
      headers.find((header) => isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_ID_HEADER))?.value ??
      "",
    accessClientSecret:
      headers.find((header) => isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER))
        ?.value ?? "",
    custom: headers.filter((header) => !isPreset(header)).map(requestHeaderRow),
  };
}

/** The headers to store, or an error message for the user. */
export function requestHeadersFromForm(
  form: RequestHeadersForm,
): { readonly headers: ReadonlyArray<RequestHeader> } | { readonly error: string } {
  const clientId = form.accessClientId.trim();
  const clientSecret = form.accessClientSecret.trim();
  if ((clientId === "") !== (clientSecret === "")) {
    return { error: "Enter both the Client ID and the Client Secret, or neither." };
  }
  const preset: RequestHeader[] =
    clientId === ""
      ? []
      : [
          { name: CLOUDFLARE_ACCESS_CLIENT_ID_HEADER, value: clientId },
          { name: CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER, value: clientSecret },
        ];
  const headers = [
    ...preset,
    ...form.custom.map((header) => ({ name: header.name.trim(), value: header.value.trim() })),
  ];
  const error = requestHeadersError(headers);
  return error === null ? { headers } : { error };
}

/** Controlled fields for one origin's request headers. Values stay masked. */
export function RequestHeadersFields({
  form,
  disabled,
  onChange,
}: {
  readonly form: RequestHeadersForm;
  readonly disabled?: boolean;
  readonly onChange: (form: RequestHeadersForm) => void;
}) {
  const setCustom = (id: number, next: RequestHeaderRow | null) =>
    onChange({
      ...form,
      custom:
        next === null
          ? form.custom.filter((header) => header.id !== id)
          : form.custom.map((header) => (header.id === id ? next : header)),
    });
  return (
    <div className="space-y-3">
      <p className="text-2xs text-muted-foreground">
        Extra headers this app sends with every request to this server, for example to pass a proxy
        such as Cloudflare Access. Values are stored encrypted on this device.
      </p>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-foreground">
          Cloudflare Access service token
        </span>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label="Cloudflare Access Client ID"
            placeholder="Client ID"
            value={form.accessClientId}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onChange({ ...form, accessClientId: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
            aria-label="Cloudflare Access Client Secret"
            placeholder="Client Secret"
            value={form.accessClientSecret}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onChange({ ...form, accessClientSecret: event.target.value })}
          />
        </div>
      </div>
      {form.custom.map((header) => (
        <div key={header.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          <Input
            aria-label="Header name"
            placeholder="Header name"
            value={header.name}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setCustom(header.id, { ...header, name: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
            aria-label="Header value"
            placeholder="Value"
            value={header.value}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setCustom(header.id, { ...header, value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Remove header"
            disabled={disabled}
            onClick={() => setCustom(header.id, null)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onChange({
            ...form,
            custom: [...form.custom, requestHeaderRow({ name: "", value: "" })],
          })
        }
      >
        <PlusIcon className="size-3.5" />
        Add header
      </Button>
    </div>
  );
}

/** Loads, edits, and saves the request headers of one saved origin. */
export function OriginRequestHeadersEditor({
  origin,
  showOrigin,
}: {
  readonly origin: string;
  readonly showOrigin: boolean;
}) {
  const read = useAtomCommand(readRequestHeaders, { reportFailure: false });
  const save = useAtomCommand(saveRequestHeaders, { reportFailure: false });
  const [form, setForm] = useState<RequestHeadersForm | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void read(origin).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setForm(requestHeadersToForm(result.value));
      } else {
        setMessage({ tone: "error", text: "Could not load the request headers." });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [origin, read]);

  if (form === null) {
    return message ? <p className="text-xs text-destructive">{message.text}</p> : null;
  }

  const onSave = async () => {
    const parsed = requestHeadersFromForm(form);
    if ("error" in parsed) {
      setMessage({ tone: "error", text: parsed.error });
      return;
    }
    setSaving(true);
    const result = await save({ origin, headers: parsed.headers });
    setSaving(false);
    setMessage(
      result._tag === "Success"
        ? { tone: "info", text: "Saved. The next connection attempt uses these headers." }
        : { tone: "error", text: "Could not save the request headers." },
    );
  };

  return (
    <div className="space-y-3 py-2">
      {showOrigin ? <p className="text-xs font-medium text-foreground">{origin}</p> : null}
      <RequestHeadersFields
        form={form}
        disabled={saving}
        onChange={(next) => {
          setForm(next);
          setMessage(null);
        }}
      />
      {message ? (
        <p
          className={
            message.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {message.text}
        </p>
      ) : null}
      <Button type="button" size="xs" disabled={saving} onClick={() => void onSave()}>
        {saving ? "Saving…" : "Save headers"}
      </Button>
    </div>
  );
}
