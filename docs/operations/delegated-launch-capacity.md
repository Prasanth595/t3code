# Delegated launch capacity

T3 checks delegated launches immediately before opening a provider session. A
missing, stale, incomplete or unsupported usage probe waits for capacity. Waiting
is persisted with the task; cancellation still works, and the durable outbox
probes again at most once per minute per waiting launch. It does not reserve
external quota. A first-request quota refusal returns to admission only before
content, a tool call, a plan or an input request has been observed.

`delegatedLaunchRoutes` in server settings declares ordered, opt-in alternatives
for an exact provider instance and model. The default is an empty list. Configure
only existing subscription instances you authorize for the task. Project provider
enablement and the original runtime mode still apply. Supported model options
are retained; an explicit fallback's options take precedence. No route purchases
capacity or adds credentials.

The [ready-to-apply settings fragment](examples/delegated-launch-routes.json) expresses
Sol → Opus → Astra, Opus → Astra, Copilot Claude → matching native Claude,
native Sonnet/Haiku → Sol, and Kimi/Gemini → Sol. Codex tries the same exact
model on another configured provider first. Sol is always `gpt-6.1-sol`. The
fragment covers the enabled `codex`, `claudeAgent`, `copilot_native_scale`,
`kimi_api` and `antigravity` catalog, including Claude 5.5, both global Kimi
slugs and all three Gemini 3.8 Flash variants. Apply only its
`delegatedLaunchRoutes` field through server settings. It is never loaded
automatically and does not enable providers or change credentials.

Account identity, credential fingerprints and credential-store bindings are
used to skip aliases of a blocked domain, including Sol → Astra on the same
Codex account. Different instance IDs alone do not establish different accounts.
A race-blocked domain is reconsidered after one minute with another fresh probe.
Model-specific exhausted windows block that model's quota across aliases;
unverified evidence does not establish an account-wide exhausted bucket.

Native Claude, Cursor, Grok and local OpenCode Go/Kimi collectors
provide usage evidence. Unknown model-specific quotas (including Codex Spark)
wait rather than treating unrelated bars as proof of capacity. Kimi uses the
read-only `GET /coding/v1/usages` endpoint on `api.kimi.com` for
`kimi-for-coding/*`, and on `api.kimi.ai` for `kimi-code-plan-global/*`.
The global host is the models.dev provider's canonical API; Kimi CLI's usage
reader appends `/usages` to the selected platform API. The collector requires
the matching inline OpenCode auth entry or an explicit inline provider API-key
option. It never substitutes the regional account's key.
OAuth, noncanonical API overrides, credentials loaded only inside an opaque
launcher, and unpinned OpenCode 2 database selection remain unsupported.
External OpenCode servers are unsupported because
local credentials cannot establish the runtime's account.

Direct Codex admission requires runtime `config/read`, ChatGPT `account/read`,
and backend-bound `account/rateLimits/read` evidence. The backend account ID
travels as an opaque quota identity. Before generation the dispatch app-server
rechecks that identity, fresh usage and the native thread's provider. Custom
providers, overrides of the built-in OpenAI provider, external API endpoints,
missing backend account IDs and changed accounts remain unverified. A caller's
`pinned` assertion cannot authorize a start. Managed token-sharing instances do
not expose this binding yet and remain unverified.

Native Claude admission uses a fresh read-only SDK capabilities/usage request,
independent of the ordinary five-minute cache. Its dispatch query rechecks
first-party account, organization, subscription and auth-source identity plus
fresh usage before accepting the prompt. API-key and custom-endpoint overrides
remain unverified. These controls do not atomically reserve quota or lock out an
external credential change between verification and generation. A structured
launch refusal still returns to fallback/waiting; no live account-swap or quota
race guarantee is claimed from the unit tests.
Unknown/account-wide first-request refusals block the account across aliases;
only a typed model window observed at admission permits a narrower block.

The configured `codex-t3` pool and the `opencode-t3` launcher that loads a Kimi
secret only inside the child process still need wrapper/pool integration.
They use healthy fallbacks or wait; this fragment alone cannot admit those
routes. No wrapper, credentials or live settings are changed by this feature.

ACP does not expose quota or pin a pooled account. Copilot's ACP integration
therefore reports unsupported; neither a GitHub login nor another account's
usage establishes its runtime capacity. Configure a healthy native fallback or
leave the task waiting. Antigravity's existing dashboard windows currently lack
a reliable mapping to the selected runtime model and also remain unverified.
