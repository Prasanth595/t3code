/** How long the normal shutdown gets before `process.exit(0)` ends the process regardless. */
const EXIT_FALLBACK_MS = 10_000;

/**
 * Ends the process the way `t3 serve` handles a stop: SIGTERM to itself, which `runMain` turns
 * into an interrupt, so the scope closes as for `launchctl stop`. The `exit` listener turns
 * runMain's 130 into 0 (a requested restart is clean to launchd) and leaves other codes alone. A
 * hung shutdown is cut short by `process.exit(0)` after `fallbackMs`, with a line on stderr.
 */
export const exitProcess = (fallbackMs = EXIT_FALLBACK_MS): void => {
  process.once("exit", (code) => {
    if (code === 130) process.exitCode = 0;
  });
  // @effect-diagnostics-next-line globalTimers:off - must fire while the Effect runtime is shutting down or stuck.
  setTimeout(() => {
    process.stderr.write(`factory restart: shutdown did not finish in ${fallbackMs}ms, exiting\n`);
    process.exit(0);
  }, fallbackMs).unref();
  process.kill(process.pid, "SIGTERM");
};
