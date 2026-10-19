import { INVITE_FALLBACK, inviteAppUrl, isPhone } from "./clientInvite.ts";

/** The code stays in the fragment until the owner opens the app; this page never redeems it. */
export const INVITE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<title>T3 invite</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Open this invite in the T3 app</h1><p>Scan the QR code with the T3 app on your phone.</p>
<p><a id="open-app" hidden>Open in the T3 app</a></p>
<button id="copy" type="button" style="min-height:44px;padding:0 1rem">Copy link</button>
<p>${INVITE_FALLBACK}</p>
<script>
const link = document.getElementById("open-app");
if ((${isPhone.toString()})(navigator.userAgent)) {
  link.href = (${inviteAppUrl.toString()})(location.href);
  link.hidden = false;
}
document.getElementById("copy").onclick = () => navigator.clipboard.writeText(location.href);
</script>`;
