import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { presentRemoveEnvironmentConfirm } from "./remove-environment-confirm";

const environmentId = "environment-1" as EnvironmentId;

function setup(options: {
  readonly environment?: { environmentLabel: string; isRelayManaged: boolean };
  readonly result?: AtomCommandResult<unknown, unknown>;
}) {
  const alert = vi.fn();
  const remove = vi.fn(async () => options.result ?? AsyncResult.success(undefined));
  presentRemoveEnvironmentConfirm({
    environmentId,
    environment: options.environment,
    remove,
    openAccount: vi.fn(),
    alert,
  });
  const [title, message, buttons] = alert.mock.calls[0]!;
  const confirm = buttons.find((button: { text: string }) => button.text === "Remove");
  return { alert, remove, title, message, confirm };
}

// The failure alert is chained on the promise `remove` returned, so awaiting
// that same promise lets it run first.
const settled = (remove: { mock: { results: ReadonlyArray<{ value: unknown }> } }) =>
  remove.mock.results[0]!.value;

describe("presentRemoveEnvironmentConfirm", () => {
  it("still asks for confirmation when the environment is missing from the connected list", () => {
    const { remove, title, message, confirm } = setup({});

    expect(title).toBe("Remove from this device?");
    expect(message).toContain(environmentId);
    expect(remove).not.toHaveBeenCalled();

    confirm.onPress();
    expect(remove).toHaveBeenCalledWith(environmentId);
  });

  it("points a T3 Connect environment at its account registration", () => {
    const { message } = setup({
      environment: { environmentLabel: "Relay host", isRelayManaged: true },
    });

    expect(message).toContain("Forget Relay host");
    expect(message).toContain("Deregister it under T3 Account");
  });

  it("reports a failed removal instead of dropping it", async () => {
    const { alert, remove, confirm } = setup({
      environment: { environmentLabel: "Laptop", isRelayManaged: false },
      result: AsyncResult.failure(Cause.fail(new Error("Keychain write failed"))),
    });

    confirm.onPress();
    await settled(remove);
    expect(alert).toHaveBeenLastCalledWith("Could not remove environment", "Keychain write failed");
  });

  it("stays quiet when the removal succeeds", async () => {
    const { alert, remove, confirm } = setup({
      environment: { environmentLabel: "Laptop", isRelayManaged: false },
    });

    confirm.onPress();
    await settled(remove);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
