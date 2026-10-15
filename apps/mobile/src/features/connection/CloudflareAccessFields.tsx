/**
 * Fork: the Cloudflare Access service token that the app sends to one server
 * origin. Add environment saves it before pairing; the environment settings
 * edit or remove it.
 */
import {
  type CloudflareAccessServiceToken,
  cloudflareAccessServiceToken,
  type RequestHeader,
  requestHeaderOrigin,
  requestHeadersError,
  withCloudflareAccessServiceToken,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { readRequestHeaders, saveRequestHeaders } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionFormField } from "./ConnectionFormField";
import { buildPairingUrl, parsePairingUrl } from "./pairing";

export interface CloudflareAccessForm {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const EMPTY_CLOUDFLARE_ACCESS_FORM: CloudflareAccessForm = {
  clientId: "",
  clientSecret: "",
};

/**
 * The origin of the server that a pairing URL pairs with. A hosted pairing
 * link (app.t3.codes) names the server in its query, so the token never lands
 * on the hosting site.
 */
export function pairingTargetOrigin(pairingUrl: string): string | null {
  const { host } = parsePairingUrl(pairingUrl);
  if (host === "") return null;
  // buildPairingUrl adds the scheme that pairing uses for a bare host; the code is a placeholder.
  return requestHeaderOrigin(buildPairingUrl(host, "origin"));
}

type TokenUpdate = (
  current: CloudflareAccessServiceToken | null,
) => CloudflareAccessServiceToken | null;

/** Reads and writes the service token of one origin, keeping its other headers. */
function useCloudflareAccessStore() {
  const read = useAtomCommand(readRequestHeaders, { reportFailure: false });
  const save = useAtomCommand(saveRequestHeaders, { reportFailure: false });
  const write = useCallback(
    async (origin: string, headers: ReadonlyArray<RequestHeader>): Promise<string | null> => {
      const error = requestHeadersError(headers);
      if (error !== null) return error;
      const saved = await save({ origin, headers });
      return AsyncResult.isSuccess(saved) ? null : "Could not save the service token.";
    },
    [save],
  );
  /** Applies `update` to the saved token. Returns the headers before the change, or an error. */
  const update = useCallback(
    async (
      origin: string,
      change: TokenUpdate,
    ): Promise<
      { readonly previous: ReadonlyArray<RequestHeader> } | { readonly error: string }
    > => {
      const current = await read(origin);
      if (!AsyncResult.isSuccess(current)) return { error: "Could not read the saved headers." };
      const next = change(cloudflareAccessServiceToken(current.value));
      const error = await write(origin, withCloudflareAccessServiceToken(current.value, next));
      return error === null ? { previous: current.value } : { error };
    },
    [read, write],
  );
  return useMemo(() => ({ read, write, update }), [read, update, write]);
}

/** The token to store (null removes it), or an error message for the user. */
function cloudflareAccessTokenFromForm(
  form: CloudflareAccessForm,
): { readonly token: CloudflareAccessServiceToken | null } | { readonly error: string } {
  const clientId = form.clientId.trim();
  const clientSecret = form.clientSecret.trim();
  if ((clientId === "") !== (clientSecret === "")) {
    return { error: "Enter both the Client ID and the Client Secret, or neither." };
  }
  return { token: clientId === "" ? null : { clientId, clientSecret } };
}

/**
 * Add environment: saves the form's token for the pairing target before pairing.
 * `undo` puts back the headers of that origin as they were, for a pairing that fails.
 */
export function useStageCloudflareAccessToken() {
  const store = useCloudflareAccessStore();
  return useCallback(
    async (
      pairingUrl: string,
      form: CloudflareAccessForm,
    ): Promise<{ readonly undo: () => Promise<void> } | { readonly error: string }> => {
      const parsed = cloudflareAccessTokenFromForm(form);
      if ("error" in parsed) return parsed;
      const origin = pairingTargetOrigin(pairingUrl);
      if (parsed.token === null || origin === null) return { undo: async () => {} };
      const token = parsed.token;
      const result = await store.update(origin, () => token);
      if ("error" in result) return result;
      return {
        undo: async () => {
          await store.write(origin, result.previous);
        },
      };
    },
    [store],
  );
}

/** Client ID and Client Secret inputs. The secret stays masked. */
function CloudflareAccessFields(props: {
  readonly form: CloudflareAccessForm;
  readonly onChange: (form: CloudflareAccessForm) => void;
  readonly disabled?: boolean;
  readonly secretSaved?: boolean;
}) {
  return (
    <View collapsable={false} className="gap-3">
      <ConnectionFormField
        label="Client ID"
        placeholder="….access"
        autoCapitalize="none"
        autoCorrect={false}
        editable={props.disabled !== true}
        value={props.form.clientId}
        onChangeText={(clientId) => props.onChange({ ...props.form, clientId })}
      />
      <ConnectionFormField
        label="Client Secret"
        placeholder={props.secretSaved ? "Saved" : undefined}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        editable={props.disabled !== true}
        value={props.form.clientSecret}
        onChangeText={(clientSecret) => props.onChange({ ...props.form, clientSecret })}
      />
      <Text className="px-1 text-sm leading-normal text-foreground-muted">
        For servers behind Cloudflare Access. The app sends this service token only to this server.
      </Text>
    </View>
  );
}

/** Add environment: the collapsible token section. A Cloudflare Access login keeps it open. */
export function AddEnvironmentCloudflareAccess(props: {
  readonly form: CloudflareAccessForm;
  readonly onChange: (form: CloudflareAccessForm) => void;
  readonly challenged: boolean;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || props.challenged;
  return (
    <View collapsable={false} className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center justify-between px-4 active:opacity-70"
      >
        <Text className="text-sm font-t3-medium text-foreground-muted">
          Cloudflare Access service token
        </Text>
        <SymbolView
          name={shown ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
      {shown ? (
        <CloudflareAccessFields
          form={props.form}
          onChange={props.onChange}
          disabled={props.disabled}
        />
      ) : null}
    </View>
  );
}

/** The saved Client ID of `origin` and whether a secret is saved. Null while loading. */
function useSavedCloudflareAccess(
  origin: string,
): { readonly clientId: string; readonly hasSecret: boolean } | null {
  const { read } = useCloudflareAccessStore();
  const [saved, setSaved] = useState<{ clientId: string; hasSecret: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void read(origin).then((result) => {
      if (cancelled) return;
      const token = AsyncResult.isSuccess(result)
        ? cloudflareAccessServiceToken(result.value)
        : null;
      setSaved({ clientId: token?.clientId ?? "", hasSecret: token !== null });
    });
    return () => {
      cancelled = true;
    };
  }, [origin, read]);
  return saved;
}

/**
 * Settings section that edits the service token of a saved environment. The
 * secret never loads into the form: an empty secret field keeps the saved one.
 * It uses the origin of the environment's main address; another route with its
 * own origin keeps whatever headers it already has. Revisit if routes on
 * several Access-protected origins become common.
 */
export function CloudflareAccessSection(props: {
  readonly origin: string;
  readonly onSaved: () => void;
}) {
  const loaded = useSavedCloudflareAccess(props.origin);
  // The state after the last save on this screen; null until then.
  const [stored, setStored] = useState<{ clientId: string; hasSecret: boolean } | null>(null);
  const [form, setForm] = useState<CloudflareAccessForm | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const store = useCloudflareAccessStore();
  const saved = stored ?? loaded;
  if (saved === null) return null;
  const current = form ?? { clientId: saved.clientId, clientSecret: "" };

  const apply = async (change: TokenUpdate, done: string) => {
    setPending(true);
    const result = await store.update(props.origin, change);
    setPending(false);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    setMessage(done);
    const next = change(cloudflareAccessServiceToken(result.previous));
    setStored({ clientId: next?.clientId ?? "", hasSecret: next !== null });
    setForm(null);
    props.onSaved();
  };

  const save = () => {
    const clientId = current.clientId.trim();
    const clientSecret = current.clientSecret.trim();
    if (clientId === "") {
      setMessage("Enter the Client ID, or remove the service token.");
      return;
    }
    if (clientSecret === "" && !saved.hasSecret) {
      setMessage("Enter the Client Secret.");
      return;
    }
    void apply(
      (previous) => ({
        clientId,
        clientSecret: clientSecret === "" ? (previous?.clientSecret ?? "") : clientSecret,
      }),
      "Service token saved.",
    );
  };

  return (
    <SettingsSection title="Cloudflare Access">
      <View collapsable={false} className="gap-3 bg-grouped-card px-4 py-4">
        <CloudflareAccessFields
          form={current}
          onChange={setForm}
          disabled={pending}
          secretSaved={saved.hasSecret}
        />
        {message ? <Text className="px-1 text-sm text-foreground-muted">{message}</Text> : null}
      </View>
      <SettingsActionRow
        icon="checkmark"
        label="Save service token"
        loading={pending}
        disabled={pending || form === null}
        onPress={save}
      />
      {saved.hasSecret ? (
        <SettingsActionRow
          icon="trash"
          label="Remove service token"
          tone="danger"
          disabled={pending}
          onPress={() => void apply(() => null, "Service token removed.")}
        />
      ) : null}
    </SettingsSection>
  );
}
