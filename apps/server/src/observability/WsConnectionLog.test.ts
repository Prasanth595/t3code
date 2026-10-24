import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";

import * as WsConnectionLog from "./WsConnectionLog.ts";

const connectedAtMs = Date.UTC(2026, 9, 23, 12, 21, 0);

describe("WsConnectionLog", () => {
  it("tells a dropped connection from a close frame, invalidation and shutdown", () => {
    const describeClose = (
      observation: Partial<WsConnectionLog.WsConnectionObservation>,
      exit: Exit.Exit<unknown, unknown> = Exit.void,
    ) =>
      WsConnectionLog.wsCloseAttributes({
        observation: { ...WsConnectionLog.makeObservation(), ...observation },
        exit,
        connectedAtMs,
        closedAtMs: connectedAtMs + 60_000,
      });

    assert.deepStrictEqual(
      describeClose({ closeCode: 1006, lastInboundAtMs: connectedAtMs + 44_000 }),
      {
        endedBy: "connection_lost",
        closeCode: 1006,
        durationMs: 60_000,
        lastInboundAgeMs: 16_000,
      },
    );
    assert.strictEqual(describeClose({ closeCode: 1000 }).endedBy, "close_frame");
    // Invalidation interrupts the socket, so no close code reaches the reader.
    assert.strictEqual(describeClose({ invalidated: true }).endedBy, "session_invalidated");
    assert.strictEqual(describeClose({}, Exit.interrupt()).endedBy, "server_interrupted");
    assert.strictEqual(describeClose({}, Exit.die("boom")).endedBy, "server_error");
  });
});
