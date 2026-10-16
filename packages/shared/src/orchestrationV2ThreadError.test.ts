import { assert, it } from "@effect/vitest";
import { isProviderEventStreamFailure } from "./orchestrationV2ThreadError.ts";

it("uses legacy stream text only when no explicit failure code was recorded", () => {
  const message = "The provider event stream closed unexpectedly.";
  assert.isTrue(isProviderEventStreamFailure({ code: null, message }));
  assert.isTrue(isProviderEventStreamFailure({ code: "event_stream_closed", message }));
  assert.isFalse(
    isProviderEventStreamFailure({ code: "event_stream_closed_unacknowledged", message }),
  );
  assert.isFalse(isProviderEventStreamFailure({ code: "provider_rejected", message }));
});
