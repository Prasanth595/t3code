import DOMPurify from "dompurify";
import { renderAsync } from "docx-preview";

/** Render outside the app DOM, then isolate document styles and content in an inert frame. */
export async function renderDocxDocument(bytes: Uint8Array) {
  const body = document.createElement("div");
  const styles = document.createElement("div");
  await renderAsync(bytes, body, styles, {
    useBase64URL: true,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    experimental: false,
  });
  const content = DOMPurify.sanitize(body.innerHTML, {
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcset"],
  });
  const css = DOMPurify.sanitize(styles.innerHTML, {
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["iframe", "object", "embed", "form"],
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0}body{background:#e5e7eb}.docx-wrapper{padding:16px!important;overflow:auto;align-items:flex-start!important}.docx-wrapper>section.docx{flex-shrink:0}</style>${css}</head><body>${content}</body></html>`;
}
