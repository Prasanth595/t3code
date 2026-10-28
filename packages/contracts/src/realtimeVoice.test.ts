import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RealtimeVoiceStartInput } from "./realtimeVoice.ts";

const decode = Schema.decodeUnknownSync(RealtimeVoiceStartInput);

describe("RealtimeVoiceStartInput", () => {
  it("keeps the CRLF that ends an SDP offer", () => {
    const sdp = "v=0\r\ns=-\r\n";
    const input = decode({ instanceId: "codex", sdp });
    expect(input.sdp).toBe(sdp);
  });
});
