import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { launchMessage, sessionMayExistNote } from "./messages.ts";

/** The paragraph that names the GitHub identity, for the login `rawphp` and the `gh` directory `/gh/rawphp`. */
const IDENTITY_WORDS =
  'You act on GitHub as rawphp. Your T3 server should have been started with GH_CONFIG_DIR=/gh/rawphp. Before anything else run gh api user --jq .login exactly as written, in the environment you were started with. Never set GH_CONFIG_DIR, GH_TOKEN or GH_HOST, and never use gh auth token or gh auth switch, on any command. If it prints any other login, end with FACTORY-STOP: stuck and make the first line of your message "the session\'s gh account is <x>, not rawphp".';

describe("launchMessage", () => {
  it("invokes /factory and says nobody is in the chat", () => {
    assert.strictEqual(
      launchMessage("rawphp/softfac", 10, "rawphp", "/gh/rawphp"),
      `/factory rawphp/softfac#10\n\nThe factory daemon launched this session unattended, in a worktree it created for you. Nobody is in the chat. The daemon owns the issue's labels and comments and runs its own gate after your draft PR.\n\n${IDENTITY_WORDS}`,
    );
  });

  it("names the login and the gh config dir the session acts as", () => {
    const message = launchMessage("acme/widgets", 7, "alice", "/Users/me/.config/softfac/gh-alice");
    assert.ok(
      message.endsWith(
        '\n\nYou act on GitHub as alice. Your T3 server should have been started with GH_CONFIG_DIR=/Users/me/.config/softfac/gh-alice. Before anything else run gh api user --jq .login exactly as written, in the environment you were started with. Never set GH_CONFIG_DIR, GH_TOKEN or GH_HOST, and never use gh auth token or gh auth switch, on any command. If it prints any other login, end with FACTORY-STOP: stuck and make the first line of your message "the session\'s gh account is <x>, not alice".',
      ),
      message,
    );
    assert.strictEqual(message.split("You act on GitHub as").length - 1, 1);
  });

  it("forbids every way of choosing the account and names the dir once", () => {
    const message = launchMessage("acme/widgets", 42, "rawphp", "/factory/gh");
    const paragraph = message.slice(message.lastIndexOf("\n\n") + 2);
    assert.ok(
      paragraph.includes(
        "run gh api user --jq .login exactly as written, in the environment you were started with.",
      ),
      paragraph,
    );
    assert.ok(
      paragraph.includes(
        "Never set GH_CONFIG_DIR, GH_TOKEN or GH_HOST, and never use gh auth token or gh auth switch, on any command.",
      ),
      paragraph,
    );
    assert.ok(
      paragraph.includes("Your T3 server should have been started with GH_CONFIG_DIR=/factory/gh."),
      paragraph,
    );
    // The variable's name with a value appears only in the clause for the server.
    assert.strictEqual(paragraph.split("GH_CONFIG_DIR=").length - 1, 1);
  });
});

describe("sessionMayExistNote", () => {
  it("says a launch attempt may have started a session, and names the command id", () => {
    assert.strictEqual(
      sessionMayExistNote("the run passed its time limit", "softfac:rawphp__softfac__7__1:launch"),
      "the run passed its time limit; a launch attempt may have started a session (launch command id softfac:rawphp__softfac__7__1:launch)",
    );
  });
});
