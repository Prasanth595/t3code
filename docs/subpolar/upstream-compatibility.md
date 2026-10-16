# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed to `e58a4857130a93cc58b45dd6ebee14cf08df04ec` on 2026-10-16. The fork had 51 commits beyond the shared July base, of which 48 were patch-equivalent to upstream. The remaining three fork commits were replayed on top of the refreshed upstream tip. The direct merge produced widespread conflicts because the fork and upstream histories had been rewritten; the patch-equivalent commits were skipped during replay.

The fork's Docker deployment and image-publish workflow remain as local commits. The old SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client compatibility constraints

This integration has not changed `apps/web`, `apps/desktop`, `apps/mobile`, or T3's client-facing contracts. Subpolar will be exposed only through existing ACP/provider capabilities and server configuration. No Subpolar-specific frontend build or protocol change is planned.

## Validation status

The upstream history merge and Subpolar package import are not a substitute for verification. Focused checks for touched server files and imported packages are pending. The Docker image and full managed execution path have not been validated, so this document does not claim those features are production-ready.

