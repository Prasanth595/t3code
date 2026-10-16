# Dev Container support

The environment manager can use a repository's image-based Dev Container configuration when it provisions a worker. It discovers `.devcontainer.json`, `.devcontainer/devcontainer.json`, and `.devcontainer/<name>/devcontainer.json`. If the worktree has no configuration, it uses `SUBPOLAR_WORKER_IMAGE` as the default image.

When a worktree contains one configuration, the manager selects it automatically. When it contains several, set `SUBPOLAR_DEFAULT_DEVCONTAINER_CONFIG` on the manager to the selected repository-relative path, for example `.devcontainer/api/devcontainer.json`. In the Compose deployment, pass it through the same-named environment variable. The selection applies to each managed worktree handled by that manager.

The supported configuration is deliberately limited to the literal `image` field, with optional `name` and `$schema` metadata. JSONC comments and trailing commas are accepted. The manager continues to apply its configured CPU, memory, and process limits, an unprivileged user, a read-only container root, no network, dropped capabilities, and only the verified worktree and optional Git metadata mounts.

The manager rejects other Dev Container properties. Dockerfile builds, Features, Compose, lifecycle commands, environment overrides, forwarded ports, custom mounts, and privilege requests need additional lifecycle and policy handling before they can be honored safely. A rejected configuration fails provisioning with a specific error; the manager does not silently switch to the default image.

This is image-based configuration discovery, not full Dev Container CLI compatibility. The project image must already exist on the Docker host and must work with the manager's fixed worker user, filesystem, and network settings. No real Docker daemon validation has been performed for this support path yet.
