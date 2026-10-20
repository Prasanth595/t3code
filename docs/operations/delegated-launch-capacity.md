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

The [example settings fragment](examples/delegated-launch-routes.json) expresses
Sol → Opus → Astra, Opus → Astra, Copilot Claude → matching native Claude,
native Sonnet/Haiku → Sol, and Kimi/Gemini → Sol. Codex tries the same exact
model on the alternate account first. Sol is always `gpt-6.1-sol`. Replace the
example instance IDs and model slugs with your configured catalog IDs; duplicate
or extend the exact-model entries for other configured versions. This file is
an example and is never loaded automatically.

The example's `codex-alt` must be a separately authenticated subscription.
Account identity, credential fingerprints and credential-store bindings are
used to skip aliases of a blocked domain, including Sol → Astra on the same
Codex account. Different instance IDs alone do not establish different accounts.
A race-blocked domain is reconsidered after one minute with another fresh probe.

Local Codex, native Claude, Cursor, Grok and local OpenCode Go/Kimi collectors
provide usage evidence. Unknown model-specific quotas (including Codex Spark)
wait rather than treating unrelated bars as proof of capacity. Kimi uses the
read-only `GET /coding/v1/usages` endpoint on `api.kimi.com` and the local
OpenCode credential overlay. External OpenCode servers are unsupported because
local credentials cannot establish the runtime's account.

ACP does not expose quota or pin a pooled account. Copilot's ACP integration
therefore reports unsupported; neither a GitHub login nor another account's
usage establishes its runtime capacity. Configure a healthy native fallback or
leave the task waiting. Antigravity's existing dashboard windows currently lack
a reliable mapping to the selected runtime model and also remain unverified.
