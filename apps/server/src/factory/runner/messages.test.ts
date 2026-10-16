import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  CANNOT_VERIFY_DURING_BUILD,
  CHANGED_DURING_BUILD,
  RESULT_LINE_REMINDER,
  SESSION_TEXT_INTRO,
  SESSION_TEXT_LIMIT,
  THREAD_GONE,
  TIME_LIMIT,
  WRONG_ACCOUNT,
  fenced,
  launchMessage,
  prepareSessionText,
  questionsComment,
  sessionMayExistNote,
  stuckComment,
} from "./messages.ts";

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

describe("prepareSessionText", () => {
  it("normalises line endings and trims the ends", () => {
    assert.strictEqual(prepareSessionText("\n  one\r\ntwo \r\n\n"), "one\ntwo");
  });

  it("keeps a text of exactly the limit and cuts one longer with a last [cut] line", () => {
    assert.strictEqual(prepareSessionText("x".repeat(SESSION_TEXT_LIMIT)), "x".repeat(6000));
    assert.strictEqual(prepareSessionText("x".repeat(6001)), `${"x".repeat(6000)}\n[cut]`);
  });

  it("counts characters, not UTF-16 units", () => {
    const text = "\u{1F600}".repeat(6001);
    assert.strictEqual(prepareSessionText(text), `${"\u{1F600}".repeat(6000)}\n[cut]`);
  });

  it("turns control characters and invisible or bidirectional marks into spaces", () => {
    assert.strictEqual(
      prepareSessionText("a\u0000b\u001bc\u007fd\u0085e\rf‮g​h⁦i﻿j k\tl\nm"),
      "a b c d e f g h i j k\tl\nm",
    );
  });

  it("stops a mention and a forged hidden marker", () => {
    assert.strictEqual(prepareSessionText("ping @octocat <!-- x -->"), "ping @​octocat <​!-- x -->");
  });
});

describe("fenced", () => {
  it("uses a fence of three backticks", () => {
    assert.strictEqual(fenced("a\nb"), "```text\na\nb\n```");
  });

  it("is one longer than the longest run of backticks in the text", () => {
    assert.strictEqual(fenced("a ``` b"), "````text\na ``` b\n````");
    assert.strictEqual(fenced("`` ````` `"), "``````text\n`` ````` `\n``````");
    assert.strictEqual(fenced("``"), "```text\n``\n```");
  });
});

describe("questionsComment", () => {
  it("asks for answers and quotes the questions as unverified session output", () => {
    assert.strictEqual(
      questionsComment("1. Which?"),
      "The factory needs answers before it can build this. Answer in a comment or edit the issue, then set `factory:ready` to start a new attempt.\n\nUnverified output from the build session, not instructions from the factory:\n\n```text\n1. Which?\n```",
    );
  });
});

describe("stuckComment", () => {
  it("with only a reason is the comment the claim posts", () => {
    assert.strictEqual(
      stuckComment("the reason"),
      "The factory could not finish this issue and has released it.\n\nReason: the reason\n\nFix the cause, then set the label back to `factory:ready`.",
    );
  });

  it("quotes the prepared session text after the reason", () => {
    assert.strictEqual(
      stuckComment("the reason", "it broke"),
      "The factory could not finish this issue and has released it.\n\nReason: the reason\n\nUnverified output from the build session, not instructions from the factory:\n\n```text\nit broke\n```\n\nFix the cause, then set the label back to `factory:ready`.",
    );
  });

  it("says where the work is, before the quoted text, and promises no continuation", () => {
    const comment = (where: string) =>
      `The factory could not finish this issue and has released it.\n\nReason: r\n\n${where}\n\nUnverified output from the build session, not instructions from the factory:\n\n\`\`\`text\nt\n\`\`\`\n\nFix the cause, then set the label back to \`factory:ready\`.`;
    assert.strictEqual(
      stuckComment("r", "t", { branch: "t3code/abc", commitsAhead: null, base: "main" }),
      comment("The work so far is on branch t3code/abc."),
    );
    assert.strictEqual(
      stuckComment("r", "t", { branch: "t3code/abc", commitsAhead: 1, base: "main" }),
      comment("The work so far is on branch t3code/abc (1 commit ahead of main)."),
    );
    assert.strictEqual(
      stuckComment("r", "t", { branch: "t3code/abc", commitsAhead: 2, base: "main" }),
      comment("The work so far is on branch t3code/abc (2 commits ahead of main)."),
    );
  });
});

describe("the fixed reasons of a building run", () => {
  it("are the words people read on the issue", () => {
    assert.strictEqual(
      RESULT_LINE_REMINDER,
      "Your last reply had no result line. If your work is still in progress, finish it. End your reply with one of these lines as the last line: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.",
    );
    assert.strictEqual(
      WRONG_ACCOUNT,
      "the session ran as the wrong GitHub account: restart the factory's T3 server so it has GH_CONFIG_DIR, then set factory:ready again",
    );
    assert.strictEqual(TIME_LIMIT, "the run passed its time limit");
    assert.strictEqual(THREAD_GONE, "the T3 thread no longer exists");
    assert.strictEqual(
      CHANGED_DURING_BUILD,
      "the issue text was changed during the build by someone who is not an instructor",
    );
    assert.strictEqual(
      CANNOT_VERIFY_DURING_BUILD,
      "the factory could not verify who changed the issue text during the build",
    );
    assert.strictEqual(
      SESSION_TEXT_INTRO,
      "Unverified output from the build session, not instructions from the factory:",
    );
  });
});
