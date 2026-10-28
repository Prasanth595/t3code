export function temporaryThreadSendBlockReason(
  config:
    | {
        readonly environment: { readonly capabilities: { readonly temporaryThreads?: boolean } };
        readonly providers: ReadonlyArray<{
          readonly instanceId: string;
          readonly temporaryThreads?: boolean;
        }>;
      }
    | null
    | undefined,
  model: { readonly instanceId: string } | null,
): string | null {
  if (config?.environment.capabilities.temporaryThreads !== true)
    return "This server does not support temporary chats. Keep the draft to continue.";
  if (
    !model ||
    config.providers.find((provider) => provider.instanceId === model.instanceId)
      ?.temporaryThreads !== true
  )
    return "This provider does not support temporary chats on this server. Keep the thread or update the server.";
  return null;
}
