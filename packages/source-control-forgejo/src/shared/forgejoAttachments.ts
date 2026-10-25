import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Forgejo serves an upload at `/attachments/<uuid>` below its mount, or below a repository. No
 * Forgejo owner name starts with `_`, which leaves `_apis/` paths, such as Azure DevOps
 * attachments, to their own host.
 */
const ATTACHMENT_PATH = new RegExp(`^(?:/[^/_][^/]*)*/attachments/(${UUID})$`, "iu");

/**
 * Forgejo's editor writes a pasted upload as a link relative to the server, `/attachments/<uuid>`,
 * which means nothing once the body is shown anywhere else. A code span matches first and is kept,
 * because code shows its text as written.
 */
const RELATIVE_ATTACHMENT_LINK = new RegExp(
  `(?<!\`)(\`+)(?!\`)[\\s\\S]*?(?<!\`)\\1(?!\`)|((?<!\\\\)\\]\\(\\s*<?|<[a-z][^<>]*?\\bsrc\\s*=\\s*["'])/?(attachments/${UUID})(?=[\\s>)"'])`,
  "giu",
);

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/u;
const INDENTED_CODE = /^(?: {4}|\t)/u;

/** The server's mount: everything in a change request's path before `/<owner>/<repo>/pulls/<n>`. */
const REPOSITORY_PAGE_PATH = /^(.*?)\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+(?:\/.*)?$/u;

/** Forgejo serves an upload with the visibility of the repository it was posted in. */
export function forgejoMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:") return null;
  const uuid = ATTACHMENT_PATH.exec(url.pathname)?.[1];
  return uuid === undefined ? null : { fetchUrl: `${url.origin}${url.pathname}`, fileName: uuid };
}

export function resolveForgejoAttachmentLinks(markdown: string, changeRequestUrl: string): string {
  const page = URL.parse(changeRequestUrl);
  const mount = page ? REPOSITORY_PAGE_PATH.exec(page.pathname)?.[1] : undefined;
  if (!page || mount === undefined) return markdown;
  const resolved: string[] = [];
  const prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    resolved.push(
      prose
        .join("\n")
        .replace(
          RELATIVE_ATTACHMENT_LINK,
          (link, codeSpan: string | undefined, prefix: string, path: string) =>
            codeSpan === undefined ? `${prefix}${page.origin}${mount}/${path}` : link,
        ),
    );
    prose.length = 0;
  };
  let openFence: string | null = null;
  let inParagraph = false;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      if (openFence === null) openFence = marker;
      else if (
        marker[0] === openFence[0] &&
        marker.length >= openFence.length &&
        fence[2]!.trim().length === 0
      ) {
        openFence = null;
      }
    }
    // An indented line continues a paragraph, so only after a blank line does it start code.
    if (fence !== null || openFence !== null || (!inParagraph && INDENTED_CODE.test(line))) {
      flushProse();
      resolved.push(line);
      inParagraph = false;
    } else {
      prose.push(line);
      inParagraph = line.trim().length > 0;
    }
  }
  flushProse();
  return resolved.join("\n");
}
