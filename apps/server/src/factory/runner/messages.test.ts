import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  CANNOT_VERIFY_DURING_BUILD,
  CHANGED_DURING_BUILD,
  RESULT_LINE_REMINDER,
  SESSION_TEXT_INTRO,
  SESSION_TEXT_LIMIT,
  STOPPED_BY_HAND,
  THREAD_GONE,
  TIME_LIMIT,
  WRONG_ACCOUNT,
  bodyEditMessage,
  commentMessage,
  failureMessage,
  fenced,
  launchMessage,
  mergeConflictMessage,
  prepareOutputTail,
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
    assert.strictEqual(STOPPED_BY_HAND, "stopped by hand");
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

describe("mergeConflictMessage", () => {
  it("is softfac's fixed wording for the base, then the conflicted paths", () => {
    assert.strictEqual(
      mergeConflictMessage("main", ["src/a.rs"]),
      "The factory gate could not run: this branch conflicts with the base branch main. Merge origin/main into the branch, resolve the conflicts, push, and finish again.\nConflicted paths:\n  src/a.rs",
    );
    assert.ok(!mergeConflictMessage("main", []).includes("Conflicted paths"));
  });

  it("lists at most ten paths, counts the rest, cuts a long path and cleans each one", () => {
    const long = `${"x".repeat(250)}.rs`;
    const paths = [
      ...Array.from({ length: 10 }, (_, i) => `src/${i}.rs`),
      long,
      "src/a\u0007b\u202e.rs",
    ];
    const lines = mergeConflictMessage("main", paths).split("\n");
    assert.strictEqual(lines[1], "Conflicted paths:");
    assert.deepStrictEqual(
      lines.slice(2, 12),
      Array.from({ length: 10 }, (_, i) => `  src/${i}.rs`),
    );
    assert.deepStrictEqual(lines.slice(12), ["  and 2 more"]);
    // The long path and the one with control characters are in the count, not shown; each
    // shown path would be cut at 200 characters and cleaned the same way.
    const shown = mergeConflictMessage("main", [long, "src/a\u0007b\u202e.rs"]).split("\n");
    assert.strictEqual(shown[2], `  ${"x".repeat(200)}\u2026`);
    assert.strictEqual(shown[3], "  src/a b .rs");
  });
});

describe("prepareOutputTail", () => {
  it("keeps the end of output over the limit, under a first line [cut]", () => {
    const output = `${"a".repeat(SESSION_TEXT_LIMIT)}\nerror: the last line`;
    const prepared = prepareOutputTail(output);
    assert.ok(prepared.startsWith("[cut]\n"), prepared.slice(0, 20));
    assert.ok(prepared.endsWith("\nerror: the last line"));
    assert.strictEqual(Array.from(prepared).length, "[cut]\n".length + SESSION_TEXT_LIMIT);
  });

  it("leaves output within the limit whole and escapes it like session text", () => {
    assert.strictEqual(
      prepareOutputTail("  ping @tom <!-- x -->\r\n"),
      "ping @\u200Btom <\u200B!-- x -->",
    );
    const atLimit = "b".repeat(SESSION_TEXT_LIMIT);
    assert.strictEqual(prepareOutputTail(atLimit), atLimit);
  });
});

describe("failureMessage", () => {
  const failed = {
    command: "cargo test",
    exitCode: -1,
    durationMs: 30_000,
    timedOut: true,
    output: "slow\n",
  };

  it("says how long the command ran before it timed out, and that the output was cut", () => {
    const message = failureMessage({ ...failed, timeoutMs: 1_800_000, truncated: true });
    assert.include(message, "\nResult: timed out after 1800 s\n");
    assert.include(message, "(last 5 bytes, truncated)");
  });

  it("says neither when it does not know them", () => {
    const message = failureMessage(failed);
    assert.include(message, "\nResult: timed out\n");
    assert.include(message, "(last 5 bytes)");
    assert.include(
      failureMessage({ ...failed, timedOut: false, exitCode: 101 }),
      "\nResult: exit code 101\n",
    );
  });
});

describe("forwarded instructor text", () => {
  const REPO = "rawphp/softfac";
  const comment = (body: string, author = "tom", repo = REPO, issue = 11) =>
    commentMessage(repo, issue, author, body);
  const edit = (body: string, editor = "tom", repo = REPO, issue = 11) =>
    bodyEditMessage(repo, issue, editor, body);
  const COMMENT_HEAD =
    "Forwarded instructor comment on rawphp/softfac#11 from tom. Apply it at your next step boundary.\n\n";
  const EDIT_HEAD =
    "The body of rawphp/softfac#11 was edited by tom. Go back to your Contract step and work from the new body:\n\n";

  it("names the repo, the issue and the author of a comment", () => {
    assert.strictEqual(
      commentMessage("rawphp/softfac", 11, "tomkaczocha", "Use serde here.\nThanks."),
      "Forwarded instructor comment on rawphp/softfac#11 from tomkaczocha. Apply it at your next step boundary.\n\nUse serde here.\nThanks.",
    );
  });

  it("sends a body edit back to the contract step", () => {
    assert.strictEqual(
      bodyEditMessage("rawphp/softfac", 11, "tomkaczocha", "## Outcome\nnew"),
      "The body of rawphp/softfac#11 was edited by tomkaczocha. Go back to your Contract step and work from the new body:\n\n## Outcome\nnew",
    );
  });

  it("loses control and invisible characters but keeps newline and tab", () => {
    const text =
      "a\u0000b\u0007c\u001b[31m\u0085d\u007fe\tf\u2028g\u2029h\u202ai\u202ej\u2066k\u2069l\rm\u200bn\u200fo\ufeffp\nq";
    const clean = "a b c [31m d e\tf g h i j k l m n o p\nq";
    assert.strictEqual(comment(text), `${COMMENT_HEAD}${clean}`);
    assert.strictEqual(edit(text), `${EDIT_HEAD}${clean}`);
  });

  it("has its line endings normalised", () => {
    assert.ok(comment("one\r\ntwo\r\n\r\nthree").endsWith("\n\none\ntwo\n\nthree"));
  });

  it("is not escaped, because it is an instruction", () => {
    const body = "ping @someone and <!-- softfac --> and `code`";
    assert.ok(comment(body).endsWith(`\n\n${body}`));
  });

  it("over 20000 characters ends with a line that says where to read the rest", () => {
    const cut =
      "[The factory cut this text at 20000 characters. Read the full text with: gh issue view 11 --repo rawphp/softfac --comments]";
    const long = "a".repeat(25_000);
    assert.ok(comment(long).endsWith(`\n\n${"a".repeat(20_000)}\n${cut}`));
    const exact = "b".repeat(20_000);
    assert.ok(comment(exact).endsWith(`\n\n${exact}`));
    assert.ok(!comment(exact).includes("factory cut"));
    // Characters are counted as code points, not UTF-16 units.
    assert.ok(edit("é".repeat(20_001)).endsWith(`\n\n${"é".repeat(20_000)}\n${cut}`));
    assert.ok(edit("😀".repeat(20_001)).endsWith(`\n\n${"😀".repeat(20_000)}\n${cut}`));
    assert.ok(!edit("😀".repeat(20_000)).includes("factory cut"));
    // Another repo and issue name themselves.
    assert.ok(
      comment(long, "tom", "acme/widgets", 7).endsWith(
        "\n[The factory cut this text at 20000 characters. Read the full text with: gh issue view 7 --repo acme/widgets --comments]",
      ),
    );
  });

  it("cleans a login to one line and cuts it at 100 characters, in both messages", () => {
    const messages = [
      {
        build: commentMessage,
        before: "Forwarded instructor comment on rawphp/softfac#11 from ",
        after: ". Apply it at your next step boundary.",
      },
      {
        build: bodyEditMessage,
        before: "The body of rawphp/softfac#11 was edited by ",
        after: ". Go back to your Contract step",
      },
    ];
    for (const { build, before, after } of messages) {
      const messy = build(REPO, 11, "to\u202em\nx\u001by\tz", "body");
      assert.ok(messy.startsWith(`${before}to m x y z${after}`), messy);
      const long = build(REPO, 11, "l".repeat(150), "body");
      assert.ok(long.startsWith(`${before}${"l".repeat(100)}${after}`), long);
      // No cut line for a login: it is cut, not marked.
      assert.ok(!long.includes("cut"));
    }
  });

  it("keeps the head of a long text and drops the tail", () => {
    const text = `H${"a".repeat(24_998)}\u03a9`;
    for (const message of [comment(text), edit(text)]) {
      const body = message.slice(message.indexOf("\n\n") + 2);
      assert.ok(body.startsWith(`H${"a".repeat(19_999)}`), "head");
      assert.ok(!message.includes("\u03a9"), "tail");
      assert.ok(body.includes("\n[The factory cut this text at 20000 characters."));
    }
  });
});
