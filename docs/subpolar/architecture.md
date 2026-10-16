# Subpolar integration architecture

## Source baseline

- T3 Code upstream: `e58a4857130a93cc58b45dd6ebee14cf08df04ec` (`upstream/main`, 2026-10-16).
- Subpolar: `2ddbce819d4a364de075f5d2541eeecb37ac00e8` (`automations`, 2026-10-11).
- No root `LICENSE` file was present in the supplied Subpolar checkout; provenance is recorded here and in the migration matrix.
- T3 is the primary repository and pnpm workspace. Subpolar remains an optional server-side runtime.

## Ownership

T3 owns threads, conversation history, orchestration events, provider lifecycle, project worktrees, Git operations, checkpoints, terminals, previews, and client protocol. Subpolar may supply runtime composition, Pi execution, tools, policies, and approvals. A Subpolar runtime session is referenced by a T3 provider session; it does not replace T3's thread or event state.

The first migration increments import the runtime contracts, policy gateway, transient Pi adapter, tool registry, ACP bridge, and a backend-neutral environment manager contract under `packages/subpolar-*`. They do not add client UI, RPC methods, event schemas, a new provider kind, or a competing persistence store. T3's native Pi provider remains available. Managed execution must be opt-in and fail closed if its runtime is unavailable.

## Integration boundary

T3's refreshed server uses the `provider-acp` and `provider-acp-registry` packages and orchestration-v2. Its existing ACP registry provider already accepts a local executable path and arguments, so `@subpolar/acp` can use that path without a new provider kind or driver registration. The bridge keeps session routing in process memory and delegates prompts through the Subpolar runtime and Pi adapter. It currently accepts text/resource-link prompts and returns text responses only; Pi tools are disabled, so it does not yet expose tool calls, approvals, or filesystem operations. It must keep the existing ACP wire contract and T3 provider-session lifecycle. The execution target must be explicit; an unavailable managed runtime must not fall back to a host process.

`@subpolar/environments` currently provides stable owner/workspace/worktree identities, canonical path containment checks, same-process lifecycle request coalescing, and an injected backend contract. It has no Docker driver, persistent registration store, manager service, container reconciliation, or process execution API implementation. T3 terminals and Git currently use server-side host process services. Container execution, terminal routing, worktree sharing, previews, and cleanup need separate implementation and tests before being enabled. These packages do not claim those capabilities.

## Source disposition

Subpolar's existing frontend and `@subpolar/client` are not imported. Its application backend is not copied wholesale because it combines Bun APIs, PocketBase, profile/session routing, tools, Git, and old UI concerns. Persistence, automations, browser services, and external-agent adapters remain deferred until they can be adapted without duplicating T3-owned state.

