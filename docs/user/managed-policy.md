# Managed policy

A managed policy lets an administrator configure T3 Code for every user on a machine. Deploy it
with your usual device management tool (Jamf, Kandji, Intune, Group Policy, Ansible). The T3 Code
server on that machine follows it, whichever app connects: desktop, the browser, or mobile.

## Where the policy goes

Deploy the policy one way per machine:

| OS      | Native                                                              | File                                              |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| macOS   | Configuration profile for `com.t3tools.t3code`                      | `/Library/Application Support/T3Code/policy.json` |
| Windows | `Policy` string value under `HKLM\SOFTWARE\Policies\T3Tools\T3Code` | `C:\Program Files\T3Code\policy.json`             |
| Linux   |                                                                     | `/etc/t3code/policy.json`                         |

- **macOS profile:** add a custom settings payload for `com.t3tools.t3code` whose keys are the
  policy's top-level keys (`schemaVersion`, `organization`, `settings`, `limits`), with nested
  dictionaries for the rest. Install it as a device profile; user profiles are ignored. To make
  the payload from a policy file you checked, run
  `plutil -convert xml1 -o com.t3tools.t3code.plist policy.json` and upload the result.
- **Windows registry:** set `Policy` (`REG_SZ`) to the whole policy as one line of JSON, from
  Group Policy Preferences or an Intune script. T3 Code reads it with `reg.exe`; where registry
  tools are blocked for users, deploy the file instead. In PowerShell, as an administrator:

  ```powershell
  $json = (Get-Content -Raw -Encoding UTF8 policy.json) -replace '\r?\n\s*', ''
  New-Item -Path HKLM:\SOFTWARE\Policies\T3Tools\T3Code -Force | Out-Null
  Set-ItemProperty -Path HKLM:\SOFTWARE\Policies\T3Tools\T3Code -Name Policy -Value $json -Type String
  ```

- **File:** make it and its folder writable only by administrators.

On a managed Windows machine, the desktop app does not run a WSL environment: a server inside WSL
cannot read the Windows policy.

T3 Code refuses to start if a machine has both a native policy and a file. It reads the policy when
the server starts, so restart the app after you deploy or change it. Without a policy, every
setting belongs to the user.

## Settings

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://it.example.com/t3",
  "settings": {
    "defaultRuntimeMode": { "value": "approval-required", "locked": false },
    "enableAgentBrowserAccess": { "value": false, "locked": true },
    "storageCleanup.logsAfterDays": { "value": 30, "locked": true }
  }
}
```

Each key under `settings` names a server setting by its path in the server's `settings.json`.

- `"locked": false` sets the default. Users start there and can change it.
- `"locked": true` sets the value and stops users and agents from changing it, including in
  per-project settings. Settings shows the control as **Managed by** your organization.

Some settings are overridden by another. Lock `worktreeCleanup`, which projects can also set, along
with the `worktree` rules in `storageCleanup`; T3 Code refuses a policy that locks only the rules.
Manage `idleCompaction` rather than the older `compactIdleThreads`. A Claude instance's own idle
compaction choice still wins over `idleCompaction`.

A default changes an existing setting but cannot add an entry, such as a provider instance, because
users could never remove it. Lock the entry, or set provider fields with
[`providers.instances`](#providers). A setting that can be empty, such as `defaultModelSelection`,
is managed as a whole rather than one field inside it.

T3 Code never writes policy values into the user's own settings. If you remove the policy, users
get back the settings they had chosen.

## Limits

`limits` restricts what T3 Code may do. Leave a key out to keep T3 Code's normal behavior.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["desktop"],
    "connect": false,
    "webhookTasks": false,
    "browserCookieImport": false,
    "telemetry": false,
    "providers": {
      "allowedDrivers": ["claudeAgent", "codex"],
      "instances": {
        "claudeAgent": {
          "locked": true,
          "environment": [{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" }]
        }
      }
    },
    "updates": { "mode": "auto", "feedUrl": "https://updates.example.com/t3code/" }
  }
}
```

### Permission modes

`maxRuntimeMode` is the broadest [permission mode](./permission-modes.md) any thread may use:
`approval-required` (Supervised), `auto-accept-edits`, `auto`, or `full-access`. It applies to
threads users start, agents start, and scheduled tasks. A thread already above it cannot run
another turn until someone lowers its mode; its queued messages wait and send once it is lowered. A
user's default above the limit starts new threads at the limit instead.

With `maxRuntimeMode` set, each provider's launch settings belong to you: binary path, launch
arguments, config home, and the environment variables set on each provider come from
`providers.instances` or T3 Code's defaults, and users cannot change them. Otherwise a wrapper
script, a launch flag, or a variable such as `NODE_OPTIONS` could turn off the provider's own
approvals. Pin any variables your users need, such as a gateway URL, in `providers.instances`.
Variables in the environment that starts T3 Code itself still reach providers.

ACP agents' own mode menus have no effect under `maxRuntimeMode`, except Antigravity's, whose modes
T3 Code can place under the limit. Users still choose which ACP Registry agent runs; leave
`acpRegistry` out of `allowedDrivers` to stop that.

Providers still read their own configuration from the user's home directory, for example
`~/.claude` and `~/.codex`. Restrict those with each provider's managed configuration; see
[What a policy does not cover](#what-a-policy-does-not-cover).

### Clients and T3 Connect

`clients` lists how the server may run:

- `desktop`: as the desktop app's own server.
- `local-browser`: as a server only browsers on this machine reach, such as `npx t3`.
- `remote`: reachable from phones, other computers, and app.t3.codes over the network.

`remote` is the line that matters. A server reachable from the network also accepts browsers on
this machine, and the two local kinds differ only in how T3 Code was started. On machines with the
desktop app, keep `desktop` in the list, or the app cannot start.

Without `remote`, the server only listens on this machine, does not create pairing links, and
signs out devices that paired earlier. The desktop app starts with network access and Tailscale
Serve off, whatever the user chose. T3 Connect is a way for remote clients to reach the machine, so
it turns off too. To keep remote access but turn off only T3 Connect, set `"connect": false`.

When it starts, the server also turns off Tailscale Serve HTTPS forwarding to its port, such as one
`t3 pair --tailscale` set up. It does not start while that forwarding stays on, or while
Tailscale's answer cannot be read. It does start when Tailscale is not installed, not running, or
logged out, since nothing forwards then; a mapping Tailscale kept returns when Tailscale runs
again, so restart T3 Code after that.

### Other capabilities

- `webhookTasks: false`: scheduled tasks cannot use webhook triggers. Existing webhook tasks are
  kept but do not run, and cannot be turned back on; users can still edit or delete them.
- `browserCookieImport: false`: users cannot import cookies from another browser into T3 Code's
  browser.
- `telemetry: false`: the server and desktop app send no [product usage data](./telemetry.md) or
  relay connection traces, whatever the environment says. A policy cannot turn them on. A browser
  that opens the server, such as app.t3.codes, still sends its own relay traces.

### Providers

`providers.allowedDrivers` lists the providers that may run: `codex`, `claudeAgent`, `cursor`,
`grok`, `opencode`, `antigravity`, `pi`, `muse`, and `acpRegistry`. Threads on other providers
stay, marked unavailable, and users can still turn those providers off.

`providers.instances` sets fields on every instance of a provider, such as an environment
variable that routes Claude through Amazon Bedrock or a base URL for a company gateway.
`binaryPath` and `launchArgs` apply to providers that have those settings. With `"locked": true`
users cannot change the fields you set; with `"locked": false` they fill only fields the user left
empty. A Codex pin that is locked, or set under `maxRuntimeMode`, also rules out
[Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), whose runtime would skip it.

The policy is readable by every user on the machine, so do not put credentials in it.

### Updates

- `mode`: `auto` keeps the normal update flow. `off` stops T3 Code from checking for updates, for
  machines that receive T3 Code through device management.
- `feedUrl`: the desktop app updates from your own mirror of the release feed instead of GitHub.
  Publish only the versions you have approved. The `t3` command-line server updates through npm,
  so pin it with your package tooling.
- `allowNightly: false`: the nightly channel is unavailable.

## Check a policy

Run `t3 policy check <file>` to validate a draft before you deploy it. Run `t3 policy show` on a
machine to see the policy that applies there.

T3 Code refuses to start with a policy it cannot fully apply: a policy it cannot read or parse, a
setting it does not know, a value of the wrong type, or a key that this version does not support.
`t3 policy check` reads a JSON file; for a profile or registry value, check the same JSON first.
A policy written for a newer version can carry keys an older one cannot enforce, so upgrade
T3 Code before you deploy the policy that uses them.

## What a policy does not cover

The policy controls what T3 Code does. Agents still run through each provider's own CLI, which a
user can also run outside T3 Code. To restrict those CLIs, use their own managed configuration, such
as Claude Code's managed settings. A user with administrator rights on the machine can edit or
remove the policy.

T3 Code enforces the policy itself. A version from before managed policy, or a build a user
changed, ignores it. To control which builds can run, use your device management tool's
application controls.

Without `remote`, T3 Code does not expose the server, but a user can still forward its local port
with other tools.
