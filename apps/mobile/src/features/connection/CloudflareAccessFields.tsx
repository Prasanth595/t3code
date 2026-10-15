import {
  type CloudflareAccessServiceToken,
  cloudflareAccessServiceToken,
  requestHeadersError,
  withCloudflareAccessServiceToken,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { readRequestHeaders, saveRequestHeaders } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionFormField } from "./ConnectionFormField";

/** Fork: the Cloudflare Access service token that the app sends to one origin. */
export interface CloudflareAccessForm {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const EMPTY_CLOUDFLARE_ACCESS_FORM: CloudflareAccessForm = {
  clientId: "",
  clientSecret: "",
};

/** The token to store (null removes it), or an error message for the user. */
export function cloudflareAccessTokenFromForm(
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
 * Replaces the service token of `origin` and keeps its other headers.
 * Returns an error message, or null when the token is saved.
 */
export function useSaveCloudflareAccessToken() {
  const read = useAtomCommand(readRequestHeaders, { reportFailure: false });
  const save = useAtomCommand(saveRequestHeaders, { reportFailure: false });
  return useCallback(
    async (origin: string, token: CloudflareAccessServiceToken | null): Promise<string | null> => {
      const current = await read(origin);
      if (!AsyncResult.isSuccess(current)) return "Could not read the saved headers.";
      const headers = withCloudflareAccessServiceToken(current.value, token);
      const error = requestHeadersError(headers);
      if (error !== null) return error;
      const saved = await save({ origin, headers });
      return AsyncResult.isSuccess(saved) ? null : "Could not save the service token.";
    },
    [read, save],
  );
}

/** Loads the saved service token of `origin` into a form. Null while loading. */
function useCloudflareAccessForm(origin: string): CloudflareAccessForm | null {
  const read = useAtomCommand(readRequestHeaders, { reportFailure: false });
  const [form, setForm] = useState<CloudflareAccessForm | null>(null);
  useEffect(() => {
    let cancelled = false;
    void read(origin).then((result) => {
      if (cancelled) return;
      const token = AsyncResult.isSuccess(result)
        ? cloudflareAccessServiceToken(result.value)
        : null;
      setForm(token ?? EMPTY_CLOUDFLARE_ACCESS_FORM);
    });
    return () => {
      cancelled = true;
    };
  }, [origin, read]);
  return form;
}

/** Client ID and Client Secret inputs. The secret stays masked. */
export function CloudflareAccessFields(props: {
  readonly form: CloudflareAccessForm;
  readonly onChange: (form: CloudflareAccessForm) => void;
  readonly disabled?: boolean;
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

/**
 * Settings section that edits the service token of a saved environment. It uses
 * the origin of the environment's main address; another route with its own
 * origin keeps whatever headers it already has. Revisit if routes on several
 * Access-protected origins become common.
 */
export function CloudflareAccessSection(props: {
  readonly origin: string;
  readonly onSaved: () => void;
}) {
  const loaded = useCloudflareAccessForm(props.origin);
  // The last saved form; null until the first save on this screen.
  const [stored, setStored] = useState<CloudflareAccessForm | null>(null);
  const [form, setForm] = useState<CloudflareAccessForm | null>(null);
  const saved = stored ?? loaded;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const saveToken = useSaveCloudflareAccessToken();
  const current = form ?? saved;
  if (current === null) return null;
  const hasSaved = saved !== null && saved.clientId !== "";

  const store = async (next: CloudflareAccessForm) => {
    const parsed = cloudflareAccessTokenFromForm(next);
    if ("error" in parsed) {
      setMessage(parsed.error);
      return;
    }
    setPending(true);
    const error = await saveToken(props.origin, parsed.token);
    setPending(false);
    setMessage(
      error ?? (parsed.token === null ? "Service token removed." : "Service token saved."),
    );
    if (error === null) {
      setStored(next);
      setForm(null);
      props.onSaved();
    }
  };

  return (
    <SettingsSection title="Cloudflare Access">
      <View collapsable={false} className="gap-3 bg-grouped-card px-4 py-4">
        <CloudflareAccessFields form={current} onChange={setForm} disabled={pending} />
        {message ? <Text className="px-1 text-sm text-foreground-muted">{message}</Text> : null}
      </View>
      <SettingsActionRow
        icon="checkmark"
        label="Save service token"
        loading={pending}
        disabled={pending || form === null}
        onPress={() => void store(current)}
      />
      {hasSaved ? (
        <SettingsActionRow
          icon="trash"
          label="Remove service token"
          tone="danger"
          disabled={pending}
          onPress={() => void store(EMPTY_CLOUDFLARE_ACCESS_FORM)}
        />
      ) : null}
    </SettingsSection>
  );
}
