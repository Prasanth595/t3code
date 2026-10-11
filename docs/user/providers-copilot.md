# GitHub Copilot

T3 Code integrates with the official GitHub Copilot CLI (`copilot`) using the Agent Client Protocol (ACP), supporting both standard GitHub.com and GitHub Enterprise instances (GitHub Enterprise Cloud with data residency `*.ghe.com` and GitHub Enterprise Server GHES).

## Set Up GitHub Copilot

1. Install the GitHub Copilot CLI on the machine running T3 Code:

   Using npm (Node.js 22+):

   ```sh
   npm install -g @github/copilot
   ```

   Or using Homebrew:

   ```sh
   brew install copilot-cli
   ```

2. Authenticate:
   - **For GitHub.com**: run `copilot login` or `gh auth login`.
   - **For GitHub Enterprise**: run `copilot login --host <your-host>` (e.g., `copilot login --host bmw.ghe.com` or `copilot login --host github.mycompany.com`), or use the GitHub CLI: `gh auth login --hostname <your-host>`.

3. In T3 Code, navigate to **Settings > Providers**, enable **GitHub Copilot**, and refresh the provider.

## GitHub Enterprise Configuration

When using GitHub Enterprise, specify your enterprise instance under the provider settings:

- **Enterprise URI / Host**: Enter your full enterprise URI (e.g., `https://bmw.ghe.com` or `https://github.mycompany.com`) or bare hostname. Leave blank for standard GitHub.com.
- **Enterprise Token / PAT**: (Optional) Enter a Personal Access Token with Copilot access. If left empty, Copilot will automatically:
  1. Check for stored credentials configured under T3 Code's **Source Control > GitHub** settings for that host.
  2. Fall back to your native CLI session (`copilot login` or `gh auth login`).

## Multi-Account & Enterprise Isolation

T3 Code supports multiple instances of GitHub Copilot. You can configure:

- One instance for your personal GitHub.com account.
- A separate instance targeting your corporate GitHub Enterprise instance (e.g. `https://company.ghe.com`).

Each instance runs in process isolation and injects the appropriate host routing (`GH_HOST`, `COPILOT_GH_HOST`) and credentials (`COPILOT_GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`) without leaking across instances.

## Models & Subagents

- **Models**: Discovers models available on your Copilot plan (e.g., Claude 3.5 Sonnet, Claude 3.7 Sonnet, GPT-4o, o1, o3-mini) as advertised by the Copilot ACP server.
- **Subagents**: Copilot CLI subagents spawned via the `task` tool are demuxed and streamed onto dedicated child sessions in the conversation.
- **MCP Tools**: Integrates with T3 Code tools and custom Model Context Protocol servers configured in your thread.
