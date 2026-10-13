// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
// @effect-diagnostics globalDate:off -- A plain Node child with no Effect Clock; wall time only picks the poll rate.
// Windows modifier-pair listener. Runs in a forked Node-mode child so a stuck or
// crashed FFI call cannot take the main process with it. Mirrors the macOS
// poller: sample both physical keys at 20 Hz, fire on the rising edge.
import { SNAP_SHOT_MODIFIERS, type SnapShotModifier } from "@t3tools/contracts";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

const ACTIVE_POLL_INTERVAL_MS = 50;
const IDLE_POLL_INTERVAL_MS = 500;
// Stay on the fast sampler briefly after any key activity so the pair's
// rising edge is still caught at full rate once the user starts pressing.
const ACTIVE_TAIL_MS = 2_000;

const requested = process.argv[2];
if (!(SNAP_SHOT_MODIFIERS as readonly string[]).includes(requested ?? "")) {
  process.exit(1);
}
const [left, right] = WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[requested as SnapShotModifier];

async function poll() {
  const api = await loadWindowsForegroundApi();
  let active = false;
  let lastActivity = 0;
  process.send?.("ready");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const leftDown = api.isKeyDown(left);
    const rightDown = api.isKeyDown(right);
    const pressed = leftDown && rightDown;
    if (pressed && !active) {
      try {
        process.send?.("trigger");
      } catch {}
    }
    active = pressed;
    if (leftDown || rightDown) lastActivity = Date.now();
    // Idle (no modifier down recently): sample at 2Hz instead of 20Hz. The
    // first press is seen on the next idle tick, then the fast sampler takes
    // over in time to catch the pair's rising edge.
    timer = setTimeout(
      tick,
      pressed || Date.now() - lastActivity < ACTIVE_TAIL_MS
        ? ACTIVE_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS,
    );
  };
  timer = setTimeout(tick, IDLE_POLL_INTERVAL_MS);
  const shutdown = () => {
    if (timer !== undefined) clearTimeout(timer);
    process.exit(0);
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
