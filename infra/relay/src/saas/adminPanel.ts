import { RelayApi } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

export class AdminPanelConfig extends Context.Service<
  AdminPanelConfig,
  { readonly clerkPublishableKey: string; readonly clerkJwtTemplate: string }
>()("t3code-relay/saas/adminPanel/AdminPanelConfig") {}

/** Clerk publishable keys encode the Frontend API host as base64 of `<host>$`. */
export const clerkFrontendApiHost = (publishableKey: string): string | null => {
  const encoded = publishableKey.split("_").slice(2).join("_");
  try {
    const decoded = atob(encoded);
    return decoded.endsWith("$") && decoded.length > 1 ? decoded.slice(0, -1) : null;
  } catch {
    return null;
  }
};

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export const renderAdminPanel = (config: AdminPanelConfig["Service"]) => {
  const host = clerkFrontendApiHost(config.clerkPublishableKey);
  if (host === null) return null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mira admin</title>
<style>
:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#0b0b0c;color:#e8e8e8}
body{margin:0}header{display:flex;gap:1rem;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid #222}
header h1{font-size:1rem;margin:0 auto 0 0}nav button{margin-right:.25rem}
main{padding:1.5rem;max-width:72rem}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #1d1d1f;vertical-align:middle}
th{color:#999;font-weight:500}input,select,button{font:inherit;color:inherit;background:#161618;border:1px solid #2a2a2e;border-radius:6px;padding:.3rem .5rem}
button{cursor:pointer}button.primary{background:#2d5bff;border-color:#2d5bff}button[aria-pressed=true]{border-color:#2d5bff}
input[type=number]{width:9rem}.muted{color:#888}.error{color:#ff6b6b}.bar{height:6px;background:#222;border-radius:3px;overflow:hidden;width:8rem}
.bar>span{display:block;height:100%;background:#2d5bff}label{display:block;margin:.75rem 0 .25rem}#sign-in{display:grid;place-items:center;padding:3rem}
</style>
<script async crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(config.clerkPublishableKey)}" src="https://${escapeAttribute(host)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
</head>
<body>
<header><h1>Mira admin</h1><nav hidden id="nav">
<button data-tab="users" aria-pressed="true">Users</button><button data-tab="plans">Plans</button><button data-tab="settings">Model</button>
</nav><div id="user-button"></div></header>
<div id="sign-in"></div>
<main hidden id="app"><p class="error" id="error" role="alert"></p><section id="view"></section></main>
<script>
const JWT_TEMPLATE = ${JSON.stringify(config.clerkJwtTemplate)};
const state = { tab: "users", plans: [] };
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const fmt = (n) => Number(n).toLocaleString("en-US");

async function api(path, init = {}) {
  const token = await window.Clerk.session.getToken({ template: JWT_TEMPLATE });
  const response = await fetch(path, {
    ...init,
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body._tag || "Request failed (" + response.status + ")");
  return body;
}

function showError(error) { $("error").textContent = error ? String(error.message || error) : ""; }

async function renderUsers() {
  const [{ users }, { plans }] = await Promise.all([api("/v1/admin/users"), api("/v1/admin/plans")]);
  state.plans = plans;
  const limits = new Map(plans.map((plan) => [plan.id, plan.monthlyTokenLimit]));
  const rows = users.map((user) => {
    const used = user.usage.inputTokens + user.usage.outputTokens;
    const limit = limits.get(user.planId) || 0;
    const select = el("select", { "aria-label": "Plan for " + (user.email || user.userId) },
      ...plans.map((plan) => el("option", { value: plan.id, textContent: plan.name, selected: plan.id === user.planId })));
    select.onchange = async () => {
      try { await api("/v1/admin/users/" + encodeURIComponent(user.userId) + "/plan", { method: "PUT", body: JSON.stringify({ planId: select.value }) }); showError(); }
      catch (error) { showError(error); select.value = user.planId; }
    };
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
    return el("tr", {},
      el("td", {}, user.email || el("span", { className: "muted", textContent: user.userId })),
      el("td", {}, select),
      el("td", {}, el("div", { className: "bar" }, el("span", { style: "width:" + pct + "%" })), el("span", { className: "muted", textContent: fmt(used) + " / " + fmt(limit) })),
      el("td", { textContent: fmt(user.usage.requests) }),
      el("td", { className: "muted", textContent: user.subscriptionStatus || "—" }),
      el("td", { className: "muted", textContent: user.createdAt.slice(0, 10) }));
  });
  return el("table", {},
    el("thead", {}, el("tr", {}, ...["Account", "Plan", "Tokens this month", "Requests", "Subscription", "Joined"].map((h) => el("th", { textContent: h })))),
    el("tbody", {}, ...rows));
}

function planRow(plan, isNew) {
  const field = (key, type, label) => {
    const input = el("input", { type, "aria-label": label });
    if (type === "checkbox") input.checked = Boolean(plan[key]); else input.value = plan[key] ?? "";
    input.dataset.key = key;
    return el("td", {}, input);
  };
  const row = el("tr", {},
    isNew ? field("id", "text", "Plan id") : el("td", { textContent: plan.id }),
    field("name", "text", "Name"), field("agenticEnabled", "checkbox", "Agentic mode"),
    field("monthlyTokenLimit", "number", "Monthly agentic tokens"),
    field("dailyChatLimit", "number", "Chat messages per day"),
    field("priceCents", "number", "Price in cents"), field("stripePriceId", "text", "Stripe price id"),
    field("isDefault", "checkbox", "Default plan"), field("sortOrder", "number", "Order"));
  const save = el("button", { className: "primary", textContent: "Save" });
  save.onclick = async () => {
    const value = (key) => row.querySelector('[data-key="' + key + '"]');
    const next = {
      id: isNew ? value("id").value.trim() : plan.id,
      name: value("name").value.trim(),
      agenticEnabled: value("agenticEnabled").checked,
      monthlyTokenLimit: Number(value("monthlyTokenLimit").value),
      dailyChatLimit: Number(value("dailyChatLimit").value),
      priceCents: Number(value("priceCents").value),
      stripePriceId: value("stripePriceId").value.trim() || null,
      isDefault: value("isDefault").checked,
      sortOrder: Number(value("sortOrder").value),
    };
    try { await api("/v1/admin/plans/" + encodeURIComponent(next.id), { method: "PUT", body: JSON.stringify(next) }); showError(); await render(); }
    catch (error) { showError(error); }
  };
  row.append(el("td", {}, save));
  return row;
}

async function renderPlans() {
  const { plans } = await api("/v1/admin/plans");
  const blank = { id: "", name: "", agenticEnabled: false, monthlyTokenLimit: 0, dailyChatLimit: 0, priceCents: 0, stripePriceId: "", isDefault: false, sortOrder: plans.length };
  return el("div", {},
    el("table", {},
      el("thead", {}, el("tr", {}, ...["Id", "Name", "Agentic", "Agentic tokens / month", "Chat messages / day", "Price (cents)", "Stripe price id", "Default", "Order", ""].map((h) => el("th", { textContent: h })))),
      el("tbody", {}, ...plans.map((plan) => planRow(plan, false)), planRow(blank, true))),
    el("p", { className: "muted", textContent: "New accounts get the default plan. A plan needs a Stripe price id before users can buy it. Chat messages per day of 0 means unlimited; a cap guards against abuse. The last row adds a plan." }));
}

async function renderSettings() {
  const settings = await api("/v1/admin/settings");
  const key = el("input", { type: "password", id: "deepseek-key", placeholder: settings.deepseekKeyConfigured ? "Saved. Enter a new key to replace it." : "sk-…", style: "width:28rem", autocomplete: "off" });
  const model = el("input", { type: "text", id: "deepseek-model", value: settings.deepseekModel, style: "width:28rem" });
  const anonymous = el("input", { type: "number", id: "anonymous-limit", min: "0", value: String(settings.anonymousDailyChatLimit) });
  const save = el("button", { className: "primary", textContent: "Save" });
  save.onclick = async () => {
    const body = { deepseekModel: model.value.trim(), anonymousDailyChatLimit: Number(anonymous.value) };
    if (key.value.trim() !== "") body.deepseekApiKey = key.value.trim();
    try { await api("/v1/admin/settings", { method: "PUT", body: JSON.stringify(body) }); showError(); await render(); }
    catch (error) { showError(error); }
  };
  const status = settings.deepseekKeyConfigured ? "A DeepSeek key is saved." : "No DeepSeek key yet. Users cannot run the model until you add one.";
  return el("div", {},
    el("p", { className: settings.deepseekKeyConfigured ? "muted" : "error", textContent: status }),
    el("label", { htmlFor: "deepseek-key", textContent: "DeepSeek API key" }), key,
    el("label", { htmlFor: "deepseek-model", textContent: "DeepSeek model" }), model,
    el("label", { htmlFor: "anonymous-limit", textContent: "Chat messages per day without an account" }), anonymous,
    el("p", { className: "muted", textContent: "After these, the app asks people to create a free account. 0 asks right away." }),
    el("p", {}, save));
}

async function render() {
  for (const button of document.querySelectorAll("[data-tab]")) button.setAttribute("aria-pressed", String(button.dataset.tab === state.tab));
  const view = $("view");
  try {
    const content = await (state.tab === "users" ? renderUsers() : state.tab === "plans" ? renderPlans() : renderSettings());
    view.replaceChildren(content);
  } catch (error) { showError(error); view.replaceChildren(); }
}

for (const button of document.querySelectorAll("[data-tab]")) {
  button.onclick = () => { state.tab = button.dataset.tab; showError(); render(); };
}

window.addEventListener("load", async () => {
  await window.Clerk.load();
  if (!window.Clerk.user) { window.Clerk.mountSignIn($("sign-in")); return; }
  window.Clerk.mountUserButton($("user-button"));
  $("sign-in").hidden = true; $("nav").hidden = false; $("app").hidden = false;
  render();
});
</script>
</body>
</html>`;
};

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "adminPanel",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* AdminPanelConfig;
    const html = renderAdminPanel(config);
    return handlers.handleRaw("page", () =>
      Effect.succeed(
        html === null
          ? HttpServerResponse.text("Clerk is not configured.", { status: 503 })
          : HttpServerResponse.text(html, {
              contentType: "text/html; charset=utf-8",
              headers: { "cache-control": "no-store", "x-frame-options": "DENY" },
            }),
      ),
    );
  }),
);
