const OPAQUE_MESSAGES = new Set(["<none>", "none", "ai_apicallerror: <none>"]);
const MAX_DETAIL_LENGTH = 240;

/**
 * OpenCode's AI SDK stores `<none>` when a provider answers with a body it
 * cannot read, such as a Cloudflare HTML error page. The status and that
 * page's title are the message the user can act on.
 */
export function readableProviderErrorMessage(input: {
  readonly message?: string | null | undefined;
  readonly statusCode?: number | null | undefined;
  readonly responseBody?: string | null | undefined;
}): string {
  const message = input.message?.trim() ?? "";
  if (message.length > 0 && !isOpaqueProviderMessage(message)) return message;

  const detail =
    input.responseBody === undefined || input.responseBody === null
      ? undefined
      : detailFromBody(input.responseBody);
  const statusCode =
    typeof input.statusCode === "number" && Number.isInteger(input.statusCode)
      ? input.statusCode
      : undefined;

  if (detail !== undefined && statusCode !== undefined) return `${detail} (HTTP ${statusCode}).`;
  if (detail !== undefined) return /[.!?]$/u.test(detail) ? detail : `${detail}.`;
  if (statusCode !== undefined)
    return `The model provider failed the request (HTTP ${statusCode}).`;
  return "The model provider failed the request and did not include an error message.";
}

function isOpaqueProviderMessage(message: string): boolean {
  return OPAQUE_MESSAGES.has(message.trim().toLowerCase());
}

function detailFromBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  const title = htmlTitle(trimmed);
  if (title !== undefined) return title;
  if (trimmed.startsWith("<")) return undefined;
  const jsonMessage = jsonErrorMessage(trimmed);
  if (jsonMessage !== undefined) return boundDetail(jsonMessage);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
  return boundDetail(trimmed);
}

function htmlTitle(body: string): string | undefined {
  const title = /<title[^>]*>([^<]{1,300})<\/title>/iu.exec(body)?.[1];
  if (title === undefined) return undefined;
  return boundDetail(decodeBasicEntities(title));
}

function jsonErrorMessage(body: string): string | undefined {
  if (!body.startsWith("{") && !body.startsWith("[")) return undefined;
  try {
    return stringField(JSON.parse(body), "message");
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && !isOpaqueProviderMessage(direct)) return direct;
  const nested = record.error;
  if (nested !== undefined && nested !== value) return stringField(nested, key);
  return undefined;
}

function boundDetail(value: string): string | undefined {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0 || isOpaqueProviderMessage(collapsed)) return undefined;
  return collapsed.length <= MAX_DETAIL_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function decodeBasicEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}
