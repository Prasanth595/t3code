# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use any address that computer reaches
  the environment at: a LAN or Tailscale address, T3 Connect, or `localhost` on
  the host. See [remote access](./remote-access.md).
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment as an administrator can approve
without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Grok Bot

Grok Bot can coordinate your existing T3 projects and coding threads through MCP.
Chat with your Bot in Grok Bot; T3 runs the coding agents on your environment and
keeps their threads, approvals, worktrees, and results there. This connection is
separate from the Grok Build coding provider in **Settings → Providers**.

In **Settings → Connections**, open the environment's menu and choose **Connect
Grok Bot**. On mobile, open the environment's details. The setup uses the T3
Connect address, or a saved public HTTPS route, rather than this device's local
connection. Enable T3 Connect first if no cloud-reachable address is available.

Copy the setup prompt into your existing Bot's chat. Alternatively, add a custom
Remote HTTPS MCP server in Grok Bot using the copied configuration. Leave headers
and optional OAuth client credentials empty, then authenticate the connector.
Grok Bot discovers T3's OAuth sign-in settings; you do not need to copy a T3
pairing token into the MCP URL or configuration.

Approve the T3 sign-in in your signed-in browser or with a Connections pairing
code. Grok Bot may identify itself as **Cursor** on the approval page. Choose
**Read only** to inspect projects and threads, or **Supervised** or above to let
the Bot launch, message, and stop coding threads.

After connecting, ask the Bot to list your T3 projects and providers. For coding
work, ask it to use a specific T3 project, keep the returned thread ID, and check
that thread for progress and results. The Bot's cloud computer has its own
filesystem; your T3 project and worktree stay on the T3 environment. Keep that
environment online while the Bot uses it.

If sign-in works but tool calls fail, update the T3 environment. Hosted MCP
sign-in and Grok Bot protocol compatibility require a current server. Your
organization's Grok Bot MCP policy can also restrict custom connectors. See
[Grok Bot's MCP setup](https://docs.x.ai/grok-bot/team-bots) for connector setup and
organization policies.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
