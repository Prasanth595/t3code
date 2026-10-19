import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  clearPushRegistrationFailure,
  readPushRegistrationFailure,
  startPushRegistration,
} from "./forkWebPushRegistration";

afterEach(() => {
  vi.useRealTimers();
  clearPushRegistrationFailure();
});

it.each(["key", "subscribe", "save"])(
  "continues after a %s failure, retries only failures, and clears the warning on recovery",
  async (stage) => {
    vi.useFakeTimers();
    const first = EnvironmentId.make("first");
    const second = EnvironmentId.make("second");
    const register = vi.fn().mockResolvedValue({ _tag: "Success" });
    if (stage === "subscribe") register.mockRejectedValueOnce(new Error("subscription failed"));
    else register.mockResolvedValueOnce({ _tag: "Failure" });
    const stop = startPushRegistration([first, second], register);
    await vi.advanceTimersByTimeAsync(0);
    expect(register.mock.calls.map(([id]) => id)).toEqual([first, second]);
    expect(readPushRegistrationFailure()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(register.mock.calls.map(([id]) => id)).toEqual([first, second, first]);
    expect(readPushRegistrationFailure()).toBeNull();
    stop();
  },
);

it("bounds retries and cancels pending work on cleanup", async () => {
  vi.useFakeTimers();
  const register = vi.fn().mockRejectedValue(new Error("save failed"));
  const stop = startPushRegistration([EnvironmentId.make("first")], register);
  await vi.runAllTimersAsync();
  expect(register).toHaveBeenCalledTimes(6);
  expect(readPushRegistrationFailure()).toBe("failed");
  stop();
  const stopNext = startPushRegistration([EnvironmentId.make("first")], register);
  await vi.advanceTimersByTimeAsync(0);
  stopNext();
  await vi.runAllTimersAsync();
  expect(register).toHaveBeenCalledTimes(7);
});
