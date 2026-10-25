# Shared Vite Task cache

The cache uses the [upstream Cloudflare Worker](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare) at the revision pinned in `manage.ts`. `upstream.patch` adds developer authentication and queues concurrent requests within the upstream memory limits; the Worker retains its GitHub OIDC authorization, storage accounting, retention, and cleanup. Deployments use dedicated R2 and D1 resources named `t3-task-cache`.

Vite+ 1.3 includes an experimental remote client even though its TypeScript configuration and CLI help omit it. The launcher supplies its `VP_REMOTE_CACHE_URL` and `VP_REMOTE_CACHE` controls. It leaves projects without `.task-cache.json` alone. Normal commands, including `vp run typecheck`, keep using the installed Vite+ binary.

## Deploy

Sign into Cloudflare with `npx wrangler login`. Set `CLOUDFLARE_ACCOUNT_ID` if that login has more than one account. An existing `CLOUDFLARE_API_TOKEN` is also supported.

```sh
node infra/task-cache/manage.ts deploy
node infra/task-cache/manage.ts add-writer julius
bash infra/task-cache/install.sh ~/.config/t3-task-cache/julius.json
```

The deploy command writes the public endpoint into `.task-cache.json`. Review and commit that file with this setup. The operator checkout and deployment state live in `~/.cache/t3-task-cache/`; writer digests and private credential files live in `~/.config/t3-task-cache/`. Preserve the latter to administer existing writers. Repeating `add-writer` rotates that writer's token; `revoke-writer <name>` removes access.

The installer adds the launcher to shell startup files after Vite+'s environment setup. Existing shells should run `source ~/.config/t3-task-cache/env` once. CI installs the launcher through `setup-ci-deps`; default-branch push jobs upload with GitHub OIDC, and PR jobs read. Deployment credentials are never needed on contributor machines or CI runners.

## Add a contributor or machine

Run `add-writer <name>` on the operator's machine. Transfer the resulting private credential file through a private channel. The recipient runs `bash infra/task-cache/install.sh <file>`. Use separate writer names for separate people so access can be revoked individually. Never commit or attach credential files to an issue or PR.

Reads are public, as in the upstream service. Trusted writers can publish artifacts that other developers and CI will consume. Only enable uploads for people trusted to supply those artifacts.

## Verify

```sh
node infra/task-cache/smoke.ts
vp run --filter @t3tools/task-cache test
vp run --filter @t3tools/task-cache typecheck
```

The smoke check publishes a unique fixture, restores its output into a cold second directory, changes its input, and confirms recomputation. It also checks that anonymous uploads are rejected. For a real task, run it once, then use another worktree with the same inputs and look for `remote cache hit`. Cacheable commands must run through `vp run`; direct `vp test` or `vp check` invocations do not use this cache.

## Current limits

- Vite Task separates operating systems and CPU architectures. macOS results do not satisfy Linux CI; Linux developer machines can populate compatible CI results.
- The current protocol retains one result for each execution key. Competing source versions can overwrite each other's entry. Inputs are validated before reuse, so this causes misses rather than stale hits. Merging to main does not promote or reset the cache.
- A local hit makes no remote request and is not uploaded retroactively. Clear only an isolated worktree's task cache when testing uploads of an already-cached task.
- The upstream defaults retain results for seven days within an 8 GB budget. Remote errors fall back to execution. `VP_REMOTE_CACHE=off vp run ...` disables the remote tier for one invocation.
