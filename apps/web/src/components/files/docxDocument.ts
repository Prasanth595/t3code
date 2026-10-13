import DOMPurify from "dompurify";
import { defaultOptions, parseAsync, renderDocument } from "docx-preview";

/** Yield between DOM phases so a close or file switch can cancel the next phase. */
async function documentPhase(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 0);
    signal.addEventListener("abort", abort, { once: true });
  });
  signal.throwIfAborted();
}

/** Render outside the app DOM, then isolate document styles and content in an inert frame. */
export async function renderDocxDocument(bytes: Uint8Array, signal = new AbortController().signal) {
  await documentPhase(signal);
  const body = document.createElement("div");
  const styles = document.createElement("div");
  let nodes = 0;
  let characters = 0;
  const options = {
    useBase64URL: true,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    experimental: false,
    h: (element: Parameters<typeof defaultOptions.h>[0]) => {
      signal.throwIfAborted();
      if (typeof element === "string") characters += element.length;
      if (++nodes > 20_000 || characters > 2 * 1024 * 1024)
        throw new Error(
          "This Word document is too complex to preview. Save it to open it in another app.",
        );
      return defaultOptions.h(element);
    },
  };
  const parsed = await parseAsync(bytes, options);
  await documentPhase(signal);
  const rendered = await renderDocument(parsed, options);
  await documentPhase(signal);
  for (const node of rendered) (node.nodeName === "STYLE" ? styles : body).appendChild(node);
  const markup = body.innerHTML;
  const styleMarkup = styles.innerHTML;
  if (markup.length + styleMarkup.length > 8 * 1024 * 1024)
    throw new Error(
      "This Word document is too complex to preview. Save it to open it in another app.",
    );
  const content = DOMPurify.sanitize(markup, {
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcset"],
  });
  await documentPhase(signal);
  const css = DOMPurify.sanitize(styleMarkup, {
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["iframe", "object", "embed", "form"],
  });
  signal.throwIfAborted();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0}body{background:#e5e7eb}.docx-wrapper{padding:16px!important;overflow:auto;align-items:flex-start!important}.docx-wrapper>section.docx{flex-shrink:0}</style>${css}</head><body>${content}</body></html>`;
}
