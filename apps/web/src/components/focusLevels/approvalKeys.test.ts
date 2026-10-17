import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { assert, describe, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../../keybindings";

const COMMAND_Y = {
  key: "y",
  code: "KeyY",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

function resolveWith(context: Record<string, boolean>) {
  return resolveShortcutCommand(COMMAND_Y, DEFAULT_RESOLVED_KEYBINDINGS, {
    platform: "MacIntel",
    context: { approvalPending: true, ...context },
  });
}

describe("approval keys", () => {
  it("approve outside text fields and terminals", () => {
    assert.strictEqual(resolveWith({}), "approval.approve");
  });

  it("leave mod+y to redo in the composer and to the shell in a terminal", () => {
    assert.notStrictEqual(
      resolveWith({ composerFocus: true, editableFocus: true }),
      "approval.approve",
    );
    assert.notStrictEqual(resolveWith({ terminalFocus: true }), "approval.approve");
  });
});
