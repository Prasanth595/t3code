import { assert, describe, it } from "@effect/vitest";

import { makeCloseGuard } from "./CloseGuard.ts";

function makeGuard(input: { readonly rendererAvailable?: boolean } = {}) {
  const requestIds: number[] = [];
  const guard = makeCloseGuard({
    requestConfirmation: (requestId) => {
      requestIds.push(requestId);
      return input.rendererAvailable ?? true;
    },
  });
  return {
    guard,
    requests: () => requestIds.length,
    lastRequestId: () => requestIds.at(-1) ?? -1,
  };
}

describe("CloseGuard", () => {
  it("closes without asking while no thread is busy", async () => {
    const { guard, requests, lastRequestId } = makeGuard();

    assert.isTrue(guard.canExit());
    assert.isTrue(await guard.confirm());
    assert.equal(requests(), 0);
  });

  it("asks while threads are busy and stays confirmed once the user confirms", async () => {
    const { guard, requests, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(2);

    assert.isFalse(guard.canExit());
    const confirmation = guard.confirm();
    assert.equal(requests(), 1);
    guard.resolve(lastRequestId(), true);

    assert.isTrue(await confirmation);
    // The window close and the quit it causes must not ask twice.
    assert.isTrue(guard.canExit());
    assert.isTrue(await guard.confirm());
    assert.equal(requests(), 1);
  });

  it("keeps guarding after the user cancels", async () => {
    const { guard, requests, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(1);

    const confirmation = guard.confirm();
    guard.resolve(lastRequestId(), false);

    assert.isFalse(await confirmation);
    assert.isFalse(guard.canExit());
    void guard.confirm();
    assert.equal(requests(), 2);
  });

  it("shares one prompt between repeated close requests", async () => {
    const { guard, requests, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(1);

    const first = guard.confirm();
    const second = guard.confirm();
    assert.equal(requests(), 1);
    guard.resolve(lastRequestId(), true);

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  });

  it("closes when no renderer can answer", async () => {
    const { guard } = makeGuard({ rendererAvailable: false });
    guard.setBusyThreadCount(1);

    assert.isTrue(await guard.confirm());
  });

  it("cancels the pending prompt and forgets the count when the renderer goes away", async () => {
    const { guard, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(1);

    const confirmation = guard.confirm();
    guard.reset();

    assert.isFalse(await confirmation);
    assert.isTrue(guard.canExit());
  });

  it("ignores a late answer to a prompt that was cancelled", async () => {
    const { guard, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(1);

    void guard.confirm();
    const staleRequestId = lastRequestId();
    guard.reset();
    guard.setBusyThreadCount(1);
    const current = guard.confirm();

    guard.resolve(staleRequestId, true);
    assert.isFalse(guard.canExit());
    guard.resolve(lastRequestId(), false);
    assert.isFalse(await current);
  });

  it("ignores an answer that arrives with no prompt pending", () => {
    const { guard, lastRequestId } = makeGuard();
    guard.setBusyThreadCount(1);

    guard.resolve(lastRequestId(), true);

    assert.isFalse(guard.canExit());
  });
});
