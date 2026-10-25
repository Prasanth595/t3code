# Shared Vite Task cache

[Alchemy](https://alchemy.run) manages the `T3TaskCache` stack: the `t3-task-cache` Worker, its D1 index, private R2 bucket, rate limits, and cleanup schedule. The production stack adopts the existing resources and preserves their data and repository authorization policy. D1 and R2 have a retain removal policy.

The Worker uses Effect services for request handling, developer authentication, bounded concurrency, deadlines, and cleanup. The pinned [upstream protocol package](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare/tree/5b06c2c10d84ea441735ba07c46f6d1b7cb2ff3b) supplies the experimental wire format, streaming upload, GitHub OIDC validation, and atomic D1 publication. Keeping that adapter preserves compatibility with existing cache entries.

Vite+ 1.3 includes an experimental remote client even though its TypeScript configuration and CLI help omit it. The small dependency-free launcher supplies `VP_REMOTE_CACHE_URL` and `VP_REMOTE_CACHE`. It leaves projects without `.task-cache.json` alone. Commands keep using the project's installed Vite+ binary.

## Deploy

Install dependencies with `vp install`, then authenticate with Alchemy's Cloudflare profile. Alternatively, provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through your environment. Alchemy stores deployment state remotely with `Cloudflare.state()`.

```sh
node infra/task-cache/manage.ts deploy
```

The management CLI reads writer digests from `~/.config/t3-task-cache/writers.json` and supplies them as a redacted Worker secret. Preserve that file to administer existing writers. Deployment uses the `prod` stage and the existing endpoint in `.task-cache.json`. The CLI loads the pinned TypeScript protocol dependency through `tsx` for Alchemy's deployment-time evaluation.

The production database's existing `scopes` and `deployment` records control repository access, quotas, and retention. Adopting it does not overwrite those policies. Provisioning a separate cache requires its own repository policy; a new empty database does not grant uploads.

## Add a contributor or machine

```sh
node infra/task-cache/manage.ts add-writer maria
```

This redeploys the secret, then writes `~/.config/t3-task-cache/maria.json`. Transfer that file through a private channel. The recipient runs:

```sh
bash infra/task-cache/install.sh /path/to/maria.json
```

The installer adds the launcher to shell startup files after Vite+'s environment setup. Existing shells should run `source ~/.config/t3-task-cache/env` once. Use separate writer names for separate people. Repeating `add-writer` rotates the token; `revoke-writer <name>` redeploys without that writer. Never commit or attach credential files to an issue or PR.

CI installs the launcher through `setup-ci-deps`; default-branch push jobs upload with GitHub OIDC, and PR jobs read. Deployment credentials are never needed on contributor machines or CI runners. Reads are public, as in the upstream service. Trusted writers can publish artifacts that developers and CI consume.

## Verify

```sh
node infra/task-cache/smoke.ts
vp run --filter @t3tools/task-cache test
vp run --filter @t3tools/task-cache typecheck
```

The smoke check uploads a unique fixture, restores its output into a cold second directory, changes its input, and confirms recomputation. It also checks that anonymous uploads are rejected. Cacheable commands must run through `vp run`; direct `vp test` or `vp check` invocations do not use this cache.

## Current limits

- Vite Task separates operating systems and CPU architectures. macOS results do not satisfy Linux CI; Linux developer machines can populate compatible CI results.
- The current protocol retains one result for each execution key. Competing source versions can overwrite each other's entry. Inputs are validated before reuse, so this causes misses rather than stale hits. Merging to main does not promote or reset the cache.
- A local hit makes no remote request and is not uploaded retroactively. Clear only an isolated worktree's task cache when testing uploads of an already-cached task.
- Production retains results for seven days within an 8 GB budget. Remote errors fall back to execution. `VP_REMOTE_CACHE=off vp run ...` disables the remote tier for one invocation.
