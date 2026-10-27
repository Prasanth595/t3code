# GLM Agent

GLM Agent runs through ACP on the machine hosting your T3 Code server. It brings its own
models and tools; T3 Code provides projects, threads, checkpoints, and subscription limits.

## Set up GLM Agent

1. Open **Settings → Providers → Add provider** on web or desktop.
2. Choose **GLM Agent**, give the instance a name, and save it.
3. Complete sign-in in its provider settings, or add `Z_AI_API_KEY` to the instance's
   **Environment variables** and mark it sensitive.

T3 Code prepares GLM Agent from the official ACP Registry. To use an existing installation,
set **Executable override** to its command or absolute path on the server.

Existing GLM Agent instances added through the ACP Registry move to the dedicated GLM Agent
provider automatically. Their instance IDs, settings, and executable overrides are retained.

Credentials remain on the server, including when you connect from web, desktop, or mobile.
GLM Agent's saved credentials follow its XDG configuration directory. Instance environment
variables apply to both the agent and limit checks. For an installed, configured instance,
mobile offers sign-in under **Settings → Provider accounts**.

## Subscription limits

Open **Usage → Limits** to see the **GLM Agent** pool. It reports the Coding Plan's five-hour
and weekly allowances, plus monthly MCP tool usage when available. Instances using the same
account count once across environments.

Limit checks use `Z_AI_API_KEY` or the agent's saved credentials. Only official Z.ai and
BigModel Coding Plan endpoints are supported; a custom proxy does not report limits. Refresh
Limits after changing the key or account. Session history is not included in Usage's cost and
token totals.

To continue automatically after a Coding Plan limit resets, enable **Resume after usage limits**
in **Settings → Threads**, or choose **Resume at reset**
on a limited thread. T3 Code uses the quota API's reset time. If that time is unavailable, retry
manually; the timezone-free timestamp in GLM Agent's error is not used to schedule a resume.

## Models, permissions, and checkpoints

Models and options come from GLM Agent. Add unlisted model IDs under **Custom models** in the
instance settings. GLM Agent uses its own tools and native mode; T3 Code answers approval
requests according to the thread's [permission mode](./permission-modes.md).

Checkpoint rollback restores files and starts a fresh agent session on the next turn. GLM Agent
does not provide T3 Code's app-owned text generation, such as thread titles and commit messages.
Configure another provider for those actions.

See [ACP providers](./providers-acp.md) for sign-in methods, native sessions, and advanced
configuration shared by ACP agents.
