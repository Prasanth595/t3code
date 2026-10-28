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

const ADMIN_CSS = `
:root{color-scheme:dark;--bg:#09090b;--panel:#111114;--panel-2:#16161a;--line:#24242a;--line-2:#2e2e35;--text:#ececef;--muted:#8d8d97;--faint:#5d5d66;--accent:#5b7cff;--accent-2:#8ea3ff;--accent-soft:rgba(91,124,255,.14);--ok:#3ecf8e;--ok-soft:rgba(62,207,142,.13);--warn:#f5a524;--warn-soft:rgba(245,165,36,.13);--err:#ff5f5f;--err-soft:rgba(255,95,95,.13);--radius:12px;font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-height:100vh}button,input,select{font:inherit;color:inherit}
a{color:var(--accent-2)}
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:18px 12px;border-right:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px 18px}
.logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-weight:700;background:linear-gradient(135deg,#5b7cff,#a35bff);color:#fff}
.brand b{font-size:15px}.brand small{display:block;color:var(--muted);font-size:11.5px;margin-top:-2px}
.nav{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;text-align:left}
.nav:hover{background:var(--panel-2);color:var(--text)}.nav[aria-current=page]{background:var(--accent-soft);color:var(--text)}
.nav svg{width:17px;height:17px;flex:none}
.side-foot{margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 8px 0;border-top:1px solid var(--line)}
.side-foot span{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{min-width:0;padding:28px 32px 48px;max-width:1240px}
.top{display:flex;align-items:flex-start;gap:16px;margin-bottom:22px}
.top h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.01em}.top p{margin:2px 0 0;color:var(--muted)}
.top .grow{flex:1}
.btn{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel-2);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:#3a3a43}.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:#4c6ef0}
.btn svg{width:15px;height:15px}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-bottom:14px}
.two{grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.card h2{margin:0 0 2px;font-size:14px;font-weight:600}.card .hint{margin:0 0 14px;color:var(--muted);font-size:12.5px}
.kpi .label{color:var(--muted);font-size:12.5px;display:flex;align-items:center;gap:6px}
.kpi .value{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:6px}
.kpi .sub{color:var(--muted);font-size:12px;margin-top:2px}
.up{color:var(--ok)}
.chart{width:100%;height:auto;display:block}.chart text{fill:var(--faint);font-size:10px}
.chart .grid-line{stroke:var(--line)}.chart rect:hover{opacity:.8}
.legend{display:flex;gap:16px;color:var(--muted);font-size:12px;margin-top:10px}.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.hbar{display:grid;grid-template-columns:110px 1fr auto;align-items:center;gap:10px;margin:9px 0}
.hbar .track,.meter{height:8px;border-radius:99px;background:var(--panel-2);overflow:hidden}
.hbar .fill,.meter>span{display:block;height:100%;border-radius:99px;background:var(--accent)}
.meter.warn>span{background:var(--warn)}.meter.full>span{background:var(--err)}
.hbar>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar .n{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12.5px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}
.field,select,.input{background:var(--panel-2);border:1px solid var(--line-2);border-radius:8px;padding:7px 10px;outline:none}
.field:focus,select:focus,.input:focus{border-color:var(--accent)}
.search{position:relative;flex:1;min-width:200px;max-width:360px}.search svg{position:absolute;left:10px;top:50%;width:15px;height:15px;transform:translateY(-50%);color:var(--faint)}
.search input{width:100%;padding-left:32px}
.count{color:var(--muted);font-size:12.5px;margin-left:auto}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#141418}
th{color:var(--muted);font-weight:500;font-size:12px;background:var(--panel);position:sticky;top:0}
td.num{font-variant-numeric:tabular-nums}
.who{display:flex;align-items:center;gap:10px;min-width:0}.who div{min-width:0}
.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:600;font-size:12.5px;background:var(--accent-soft);color:var(--accent-2)}
.who b{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.who small,.muted{color:var(--muted)}.who small{font-size:11.5px;font-family:ui-monospace,monospace}
.usage{min-width:170px}.usage .meter{margin-bottom:4px}.usage small{color:var(--muted);font-size:11.5px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:500;background:var(--panel-2);color:var(--muted);border:1px solid var(--line-2)}
.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.badge.err{background:var(--err-soft);color:var(--err);border-color:transparent}.badge.info{background:var(--accent-soft);color:var(--accent-2);border-color:transparent}
.plans{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.plan-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}.plan-head h2{margin:0;font-size:15px}
.price{font-size:22px;font-weight:650;margin:-6px 0 14px}.price small{font-size:12.5px;color:var(--muted);font-weight:400}
.form{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
.form label.wide{grid-column:1/-1}.form input,.form select{width:100%}
.toggle{flex-direction:row!important;align-items:center;gap:9px!important;color:var(--text)!important;font-size:13px!important;cursor:pointer}
.toggle input{width:auto;accent-color:var(--accent)}
.card-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.settings{max-width:720px}.settings .card{margin-bottom:14px}.settings .form{grid-template-columns:1fr}
.status{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.help{color:var(--muted);font-size:12px;margin:2px 0 0}
.empty{padding:40px;text-align:center;color:var(--muted)}
.loading{display:flex;align-items:center;gap:10px;color:var(--muted);padding:40px 0}
.spinner{width:16px;height:16px;border:2px solid var(--line-2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:10}
.toast{padding:10px 14px;border-radius:10px;background:var(--panel-2);border:1px solid var(--line-2);box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:360px}
.toast.ok{border-color:rgba(62,207,142,.4)}.toast.err{border-color:rgba(255,95,95,.45)}
#sign-in{min-height:100vh;display:grid;place-items:center;padding:24px}
.sign-card{display:flex;flex-direction:column;align-items:center;gap:18px}
.sign-card .brand{padding:0}
@media (max-width:820px){
.shell{grid-template-columns:1fr}
.side{position:sticky;z-index:5;height:auto;flex-direction:row;align-items:center;gap:2px;padding:10px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}
.brand{padding:0 8px 0 2px}.brand div{display:none}.nav{width:auto;white-space:nowrap}.nav span{display:inline}
.side-foot{margin:0 0 0 auto;border:0;padding:0 4px}.side-foot span{display:none}
main{padding:20px 14px 40px}.kpi .value{font-size:22px}.card{padding:14px}.hbar{grid-template-columns:96px 1fr auto}.top{flex-wrap:wrap}.form{grid-template-columns:1fr}
}
`;

// Plain strings only: this runs in the browser, and `${` here would be interpolated on the server.
const ADMIN_SCRIPT = `
const state = { tab: "overview", users: null, plans: null, settings: null, stats: null, query: "", planFilter: "all", sort: "newest" };
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};
const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
};
const ICONS = {
  overview: "M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  plans: "M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  plus: "M12 5v14M5 12h14",
};
const icon = (name) => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, svg("path", { d: ICONS[name] }));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n || 0));
const money = (cents) => (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const ago = (iso) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? days + " days ago" : days < 365 ? Math.floor(days / 30) + " mo ago" : Math.floor(days / 365) + " y ago";
};
const PAYING = new Set(["active", "trialing"]);
const TITLES = {
  overview: ["Overview", "Accounts, revenue and chat activity at a glance."],
  users: ["Users", "Every account, its plan and this month's agentic usage."],
  plans: ["Plans", "What each plan costs and what it unlocks."],
  settings: ["Model", "The DeepSeek key, model and limits behind Mira."],
};

async function api(path, init = {}) {
  const token = await window.Clerk.session.getToken({ template: "JWT_TEMPLATE_PLACEHOLDER" });
  const response = await fetch(path, { ...init, headers: { authorization: "Bearer " + token, "content-type": "application/json", ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || (body._tag === "SaasForbiddenError" ? "This account is not an admin." : body._tag) || "Request failed (" + response.status + ")");
  return body;
}

function toast(message, kind = "ok") {
  const node = el("div", { className: "toast " + kind, role: kind === "err" ? "alert" : "status", textContent: message });
  $("toasts").append(node);
  setTimeout(() => node.remove(), kind === "err" ? 6000 : 3000);
}

async function load(force) {
  const need = {
    overview: ["users", "plans", "settings", "stats"],
    users: ["users", "plans"],
    plans: ["plans", "users"],
    settings: ["settings"],
  }[state.tab];
  const paths = { users: "/v1/admin/users", plans: "/v1/admin/plans", settings: "/v1/admin/settings", stats: "/v1/admin/stats" };
  await Promise.all(need.filter((key) => force || state[key] === null).map(async (key) => {
    const body = await api(paths[key]);
    state[key] = key === "users" ? body.users : key === "plans" ? body.plans : key === "stats" ? body.chatDays : body;
  }));
}

function kpi(label, value, sub) {
  return el("div", { className: "card kpi" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }), sub ? el("div", { className: "sub" }, sub) : null);
}

function activityChart(days) {
  const width = 720, height = 190, top = 10, bottom = 22, left = 30;
  const max = Math.max(4, ...days.map((d) => d.userMessages + d.anonymousMessages));
  const step = (width - left) / days.length;
  const bar = Math.max(3, step * 0.62);
  const y = (v) => top + (height - top - bottom) * (1 - v / max);
  const chart = svg("svg", { class: "chart", viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "Chat messages per day" });
  for (const fraction of [0, 0.5, 1]) {
    const v = Math.round(max * fraction);
    chart.append(svg("line", { class: "grid-line", x1: left, x2: width, y1: y(v), y2: y(v) }), svg("text", { x: 0, y: y(v) + 3 }, String(v)));
  }
  days.forEach((d, i) => {
    const x = left + i * step + (step - bar) / 2;
    const tip = svg("title", {}, d.day + ": " + fmt(d.userMessages) + " signed in, " + fmt(d.anonymousMessages) + " guests");
    const userTop = y(d.userMessages);
    const guestTop = y(d.userMessages + d.anonymousMessages);
    const group = svg("g", {}, tip);
    if (d.userMessages > 0) group.append(svg("rect", { x, y: userTop, width: bar, height: y(0) - userTop, rx: 2, fill: "var(--accent)" }));
    if (d.anonymousMessages > 0) group.append(svg("rect", { x, y: guestTop, width: bar, height: userTop - guestTop, rx: 2, fill: "#8ea3ff66" }));
    if (d.userMessages + d.anonymousMessages === 0) group.append(svg("rect", { x, y: y(0) - 2, width: bar, height: 2, rx: 1, fill: "var(--line-2)" }));
    chart.append(group);
    if (i % 5 === 0 || i === days.length - 1) chart.append(svg("text", { x: x, y: height - 6 }, new Date(d.day + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })));
  });
  return el("div", {}, chart, el("div", { className: "legend" }, el("span", {}, el("i", { style: "background:var(--accent)" }), "Signed in"), el("span", {}, el("i", { style: "background:#8ea3ff66" }), "Guests")));
}

function hbar(label, value, total, text) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return el("div", { className: "hbar" }, el("span", { textContent: label }), el("div", { className: "track" }, el("span", { className: "fill", style: "width:" + pct + "%" })), el("span", { className: "n", textContent: text }));
}

function meter(used, limit) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return el("div", { className: "meter" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "") }, el("span", { style: "width:" + pct + "%" }));
}

const tokensUsed = (user) => user.usage.inputTokens + user.usage.outputTokens;

function renderOverview() {
  const { users, plans, settings, stats } = state;
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const weekAgo = Date.now() - 7 * 86400000;
  const fresh = users.filter((user) => Date.parse(user.createdAt) >= weekAgo).length;
  const paying = users.filter((user) => PAYING.has(user.subscriptionStatus));
  const mrr = paying.reduce((sum, user) => sum + (planById.get(user.planId)?.priceCents || 0), 0);
  const today = stats[stats.length - 1];
  const week = stats.slice(-7).reduce((sum, d) => sum + d.userMessages + d.anonymousMessages, 0);
  const chatTokens = stats.reduce((sum, d) => sum + d.inputTokens + d.outputTokens, 0);
  const agenticTokens = users.reduce((sum, user) => sum + tokensUsed(user), 0);

  const warnings = [];
  if (!settings.deepseekKeyConfigured) warnings.push(el("span", { className: "badge err", textContent: "No DeepSeek key: nobody can chat" }));
  if (!plans.some((plan) => plan.isDefault)) warnings.push(el("span", { className: "badge warn", textContent: "No default plan" }));
  if (plans.some((plan) => plan.priceCents > 0 && !plan.stripePriceId)) warnings.push(el("span", { className: "badge warn", textContent: "A paid plan has no Stripe price" }));

  const byPlan = plans.map((plan) => [plan, users.filter((user) => user.planId === plan.id).length]);
  const top = [...users].sort((a, b) => tokensUsed(b) - tokensUsed(a)).filter((user) => tokensUsed(user) > 0).slice(0, 6);

  return el("div", {},
    warnings.length ? el("div", { className: "toolbar" }, ...warnings) : null,
    el("div", { className: "grid kpis" },
      kpi("Accounts", fmt(users.length), fresh ? el("span", { className: "up", textContent: "+" + fresh + " this week" }) : "No new accounts this week"),
      kpi("Paying", fmt(paying.length), money(mrr) + " monthly from plan prices"),
      kpi("Chat today", fmt(today.userMessages + today.anonymousMessages), fmt(today.userMessages) + " signed in · " + fmt(today.anonymousMessages) + " guests"),
      kpi("Active today", fmt(today.activeUsers + today.activeDevices), fmt(today.activeUsers) + " accounts · " + fmt(today.activeDevices) + " guest devices"),
      kpi("Chat, last 7 days", fmt(week), "messages"),
      kpi("Tokens", compact(chatTokens + agenticTokens), compact(chatTokens) + " chat (30 days) · " + compact(agenticTokens) + " agentic (month)")),
    el("div", { className: "card", style: "margin-bottom:14px" }, el("h2", { textContent: "Chat messages" }), el("p", { className: "hint", textContent: "Last 30 days, UTC. Hover a bar for the day." }), activityChart(stats)),
    el("div", { className: "grid two" },
      el("div", { className: "card" }, el("h2", { textContent: "Accounts by plan" }), el("p", { className: "hint", textContent: fmt(users.length) + " accounts" }),
        ...byPlan.map(([plan, count]) => hbar(plan.name, count, users.length, fmt(count) + (users.length ? " · " + Math.round((count / users.length) * 100) + "%" : "")))),
      el("div", { className: "card" }, el("h2", { textContent: "Top agentic usage" }), el("p", { className: "hint", textContent: "This month, against each plan's limit." }),
        top.length ? el("div", {}, ...top.map((user) => hbar(user.email || user.userId, tokensUsed(user), planById.get(user.planId)?.monthlyTokenLimit || 0, compact(tokensUsed(user))))) : el("p", { className: "muted", textContent: "No agentic usage yet this month." }))));
}

function subscriptionBadge(status) {
  if (!status) return el("span", { className: "muted", textContent: "—" });
  const kind = status === "active" ? "ok" : status === "trialing" ? "info" : status === "past_due" || status === "unpaid" || status === "incomplete" ? "warn" : "";
  return el("span", { className: "badge " + kind, textContent: status.replace("_", " ") });
}

function renderUsers() {
  const { plans } = state;
  const limits = new Map(plans.map((plan) => [plan.id, plan.monthlyTokenLimit]));
  const search = el("input", { className: "field", type: "search", placeholder: "Search email or id", value: state.query, "aria-label": "Search users" });
  const planFilter = el("select", { "aria-label": "Filter by plan" }, el("option", { value: "all", textContent: "All plans" }), ...plans.map((plan) => el("option", { value: plan.id, textContent: plan.name })));
  planFilter.value = state.planFilter;
  const sort = el("select", { "aria-label": "Sort users" }, ...[["newest", "Newest first"], ["usage", "Most tokens"], ["requests", "Most requests"], ["email", "Email A–Z"]].map(([value, label]) => el("option", { value, textContent: label })));
  sort.value = state.sort;
  const body = el("tbody");
  const count = el("span", { className: "count" });

  const draw = () => {
    const query = state.query.trim().toLowerCase();
    const list = state.users
      .filter((user) => state.planFilter === "all" || user.planId === state.planFilter)
      .filter((user) => !query || (user.email || "").toLowerCase().includes(query) || user.userId.toLowerCase().includes(query))
      .sort((a, b) => state.sort === "usage" ? tokensUsed(b) - tokensUsed(a) : state.sort === "requests" ? b.usage.requests - a.usage.requests : state.sort === "email" ? (a.email || a.userId).localeCompare(b.email || b.userId) : Date.parse(b.createdAt) - Date.parse(a.createdAt));
    count.textContent = fmt(list.length) + " of " + fmt(state.users.length);
    body.replaceChildren(...(list.length ? list.map((user) => {
      const used = tokensUsed(user);
      const limit = limits.get(user.planId) || 0;
      const select = el("select", { "aria-label": "Plan for " + (user.email || user.userId) }, ...plans.map((plan) => el("option", { value: plan.id, textContent: plan.name })));
      select.value = user.planId;
      select.onchange = async () => {
        select.disabled = true;
        try {
          await api("/v1/admin/users/" + encodeURIComponent(user.userId) + "/plan", { method: "PUT", body: JSON.stringify({ planId: select.value }) });
          user.planId = select.value;
          toast("Moved " + (user.email || "the account") + " to " + select.selectedOptions[0].textContent);
          draw();
        } catch (error) { toast(error.message, "err"); select.value = user.planId; }
        finally { select.disabled = false; }
      };
      const name = user.email || user.userId;
      return el("tr", {},
        el("td", {}, el("div", { className: "who" }, el("span", { className: "avatar", textContent: name.slice(0, 1).toUpperCase() }), el("div", {}, el("b", { textContent: name }), user.email ? el("small", { textContent: user.userId }) : null))),
        el("td", {}, select),
        el("td", { className: "usage" }, meter(used, limit), el("small", { textContent: compact(used) + " / " + (limit ? compact(limit) : "no agentic") })),
        el("td", { className: "num", textContent: fmt(user.usage.requests) }),
        el("td", {}, subscriptionBadge(user.subscriptionStatus)),
        el("td", {}, el("div", { textContent: day(user.createdAt) }), el("small", { className: "muted", textContent: ago(user.createdAt) })));
    }) : [el("tr", {}, el("td", { colSpan: 6, className: "empty", textContent: "No accounts match." }))]));
  };
  search.oninput = () => { state.query = search.value; draw(); };
  planFilter.onchange = () => { state.planFilter = planFilter.value; draw(); };
  sort.onchange = () => { state.sort = sort.value; draw(); };
  draw();
  return el("div", {},
    el("div", { className: "toolbar" }, el("div", { className: "search" }, icon("search"), search), planFilter, sort, count),
    el("div", { className: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ...["Account", "Plan", "Agentic tokens this month", "Requests", "Subscription", "Joined"].map((h) => el("th", { textContent: h })))),
      body)));
}

function planCard(plan, isNew) {
  const members = state.users ? state.users.filter((user) => user.planId === plan.id).length : 0;
  const input = (key, type, extra = {}) => {
    const node = el("input", { className: "input", type, ...extra });
    if (type === "checkbox") node.checked = Boolean(plan[key]); else node.value = plan[key] ?? "";
    node.dataset.key = key;
    return node;
  };
  const priceLabel = el("div", { className: "price" });
  const price = input("priceCents", "number", { min: "0" });
  const showPrice = () => { priceLabel.replaceChildren(Number(price.value) > 0 ? money(price.value) : "Free", el("small", { textContent: Number(price.value) > 0 ? " / month" : "" })); };
  price.oninput = showPrice; showPrice();
  const form = el("div", { className: "form" },
    isNew ? el("label", { className: "wide" }, "Plan id (letters, numbers, dashes)", input("id", "text", { placeholder: "pro-yearly" })) : null,
    el("label", {}, "Name", input("name", "text")),
    el("label", {}, "Price in cents", price),
    el("label", { className: "wide" }, "Stripe price id", input("stripePriceId", "text", { placeholder: "price_…" })),
    el("label", {}, "Agentic tokens / month", input("monthlyTokenLimit", "number", { min: "0" })),
    el("label", {}, "Chat messages / day (0 = unlimited)", input("dailyChatLimit", "number", { min: "0" })),
    el("label", {}, "Order", input("sortOrder", "number")),
    el("label", {}, " "),
    el("label", { className: "toggle" }, input("agenticEnabled", "checkbox"), "Agentic mode"),
    el("label", { className: "toggle" }, input("isDefault", "checkbox"), "Default for new accounts"));
  const save = el("button", { className: "btn primary", textContent: isNew ? "Create plan" : "Save changes" });
  save.onclick = async () => {
    const value = (key) => form.querySelector('[data-key="' + key + '"]');
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
    if (!next.id || !next.name) { toast("A plan needs an id and a name.", "err"); return; }
    save.disabled = true;
    try {
      await api("/v1/admin/plans/" + encodeURIComponent(next.id), { method: "PUT", body: JSON.stringify(next) });
      toast((isNew ? "Created " : "Saved ") + next.name);
      state.plans = null; await show(false);
    } catch (error) { toast(error.message, "err"); save.disabled = false; }
  };
  return el("div", { className: "card" },
    el("div", { className: "plan-head" }, el("h2", { textContent: isNew ? "New plan" : plan.name }), isNew ? null : el("span", { className: "badge", textContent: plan.id }),
      plan.isDefault ? el("span", { className: "badge info", textContent: "Default" }) : null,
      plan.agenticEnabled ? el("span", { className: "badge ok", textContent: "Agentic" }) : null,
      isNew ? null : el("span", { className: "muted", style: "margin-left:auto;font-size:12px", textContent: fmt(members) + (members === 1 ? " account" : " accounts") })),
    priceLabel, form,
    plan.priceCents > 0 && !plan.stripePriceId && !isNew ? el("p", { className: "help", style: "color:var(--warn)", textContent: "Add a Stripe price id before people can buy this plan." }) : null,
    el("div", { className: "card-foot" }, save));
}

function renderPlans() {
  const blank = { id: "", name: "", agenticEnabled: false, monthlyTokenLimit: 0, dailyChatLimit: 0, priceCents: 0, stripePriceId: "", isDefault: false, sortOrder: state.plans.length };
  return el("div", {},
    el("div", { className: "grid plans" }, ...state.plans.map((plan) => planCard(plan, false)), planCard(blank, true)),
    el("p", { className: "help", style: "margin-top:14px", textContent: "New accounts get the default plan. Chat messages per day guards against abuse; 0 means unlimited." }));
}

function renderSettings() {
  const settings = state.settings;
  const key = el("input", { className: "input", type: "password", placeholder: settings.deepseekKeyConfigured ? "Saved. Enter a new key to replace it." : "sk-…", autocomplete: "off" });
  const model = el("input", { className: "input", type: "text", value: settings.deepseekModel });
  const anonymous = el("input", { className: "input", type: "number", min: "0", value: String(settings.anonymousDailyChatLimit) });
  const effort = (value) => {
    const select = el("select", {}, ...[["disabled", "Disabled — answers right away"], ["low", "Low"], ["high", "High"], ["max", "Max"]].map(([option, label]) => el("option", { value: option, textContent: label })));
    select.value = value;
    return select;
  };
  const chatEffort = effort(settings.chatReasoningEffort);
  const agenticEffort = effort(settings.agenticReasoningEffort);
  const save = el("button", { className: "btn primary", textContent: "Save settings" });
  save.onclick = async () => {
    const body = { deepseekModel: model.value.trim(), anonymousDailyChatLimit: Number(anonymous.value), chatReasoningEffort: chatEffort.value, agenticReasoningEffort: agenticEffort.value };
    if (key.value.trim() !== "") body.deepseekApiKey = key.value.trim();
    save.disabled = true;
    try { state.settings = await api("/v1/admin/settings", { method: "PUT", body: JSON.stringify(body) }); toast("Settings saved"); await show(false); }
    catch (error) { toast(error.message, "err"); save.disabled = false; }
  };
  return el("div", { className: "settings" },
    el("div", { className: "card" },
      el("div", { className: "status" }, el("h2", { textContent: "DeepSeek" }), el("span", { className: "badge " + (settings.deepseekKeyConfigured ? "ok" : "err"), textContent: settings.deepseekKeyConfigured ? "Key saved" : "No key" })),
      el("div", { className: "form" },
        el("label", {}, "API key", key, el("span", { className: "help", textContent: "Stored on the relay and never shown again." })),
        el("label", {}, "Model", model))),
    el("div", { className: "card" }, el("h2", { textContent: "Guests" }), el("p", { className: "hint", textContent: "People chatting without an account." }),
      el("div", { className: "form" }, el("label", {}, "Chat messages per day before sign-up", anonymous, el("span", { className: "help", textContent: "After these, the app asks for a free account. 0 asks right away." })))),
    el("div", { className: "card" }, el("h2", { textContent: "Thinking" }), el("p", { className: "hint", textContent: "More thinking answers hard questions better, but replies start later and thinking tokens are billed." }),
      el("div", { className: "form" }, el("label", {}, "Chat mode", chatEffort), el("label", {}, "Agentic mode", agenticEffort))),
    el("div", { className: "card-foot", style: "border:0;padding:0" }, save));
}

async function show(force) {
  for (const button of document.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === state.tab) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  const [title, subtitle] = TITLES[state.tab];
  $("title").textContent = title; $("subtitle").textContent = subtitle;
  const view = $("view");
  const tab = state.tab;
  if (force || !["users", "plans", "settings", "stats"].every((key) => state[key] !== null)) {
    view.replaceChildren(el("div", { className: "loading" }, el("div", { className: "spinner" }), "Loading…"));
  }
  try {
    await load(force);
    if (tab !== state.tab) return;
    view.replaceChildren(tab === "overview" ? renderOverview() : tab === "users" ? renderUsers() : tab === "plans" ? renderPlans() : renderSettings());
  } catch (error) {
    if (tab !== state.tab) return;
    view.replaceChildren(el("div", { className: "card empty" }, el("p", { textContent: error.message }), el("button", { className: "btn", textContent: "Try again", onclick: () => show(true) })));
  }
}

const NAV = [["overview", "Overview"], ["users", "Users"], ["plans", "Plans"], ["settings", "Model"]];
$("nav").append(...NAV.map(([tab, label]) => {
  const button = el("button", { className: "nav", type: "button" }, icon(tab), el("span", { textContent: label }));
  button.dataset.tab = tab;
  button.onclick = () => { state.tab = tab; history.replaceState(null, "", "#" + tab); show(false); };
  return button;
}));
$("refresh").prepend(icon("refresh"));
$("refresh").onclick = () => show(true);
if (NAV.some(([tab]) => "#" + tab === location.hash)) state.tab = location.hash.slice(1);

window.addEventListener("load", async () => {
  await window.Clerk.load();
  if (!window.Clerk.user) { window.Clerk.mountSignIn($("clerk-sign-in")); return; }
  window.Clerk.mountUserButton($("user-button"));
  $("account").textContent = window.Clerk.user.primaryEmailAddress?.emailAddress || "";
  $("sign-in").hidden = true; $("app").hidden = false;
  show(false);
});
`;

export const renderAdminPanel = (config: AdminPanelConfig["Service"]) => {
  const host = clerkFrontendApiHost(config.clerkPublishableKey);
  if (host === null) return null;
  const script = ADMIN_SCRIPT.replace(
    '"JWT_TEMPLATE_PLACEHOLDER"',
    JSON.stringify(config.clerkJwtTemplate),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mira admin</title>
<style>${ADMIN_CSS}</style>
<script async crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(config.clerkPublishableKey)}" src="https://${escapeAttribute(host)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
</head>
<body>
<div id="sign-in"><div class="sign-card"><div class="brand"><span class="logo">M</span><div><b>Mira</b><small>Admin</small></div></div><div id="clerk-sign-in"></div></div></div>
<div class="shell" hidden id="app">
<aside class="side">
<div class="brand"><span class="logo">M</span><div><b>Mira</b><small>Admin</small></div></div>
<nav id="nav" aria-label="Sections" style="display:contents"></nav>
<div class="side-foot"><div id="user-button"></div><span id="account"></span></div>
</aside>
<main>
<div class="top"><div class="grow"><h1 id="title"></h1><p id="subtitle"></p></div><button class="btn" id="refresh" type="button">Refresh</button></div>
<section id="view"></section>
</main>
</div>
<div id="toasts" aria-live="polite"></div>
<script>${script}</script>
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
