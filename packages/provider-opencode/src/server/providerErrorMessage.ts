/** OpenCode stores `<none>` when it cannot read the provider body. */
export function readableProviderErrorMessage(input: {
  readonly message?: string | null | undefined;
  readonly statusCode?: number | null | undefined;
  readonly responseBody?: string | null | undefined;
}): string | undefined {
  const message = input.message?.trim() ?? "";
  if (message.length > 0 && message.toLowerCase() !== "<none>") return message;

  const title = input.responseBody
    ?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  const status =
    typeof input.statusCode === "number" && Number.isInteger(input.statusCode)
      ? input.statusCode
      : undefined;
  if (title) return status === undefined ? title : `${title} (HTTP ${status}).`;
  if (status !== undefined) return `The model provider failed the request (HTTP ${status}).`;
  if (message.length > 0) {
    return "The model provider failed the request and did not include an error message.";
  }
  return undefined;
}
