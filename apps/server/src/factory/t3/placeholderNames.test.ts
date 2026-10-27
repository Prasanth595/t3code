import { assert, describe, it } from "@effect/vitest";
import { type BranchNamingMode, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  branchNameMessage,
  isPlaceholderName,
  titleBranchName,
  withLaunchTitleFallback,
} from "@t3tools/shared/placeholderNames";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};
const TITLE = "Repo#401 fix: invoices";

const PLACEHOLDER_WORDS = [
  "placeholder",
  "example",
  "branch",
  "string",
  "new-branch",
  "untitled",
  "tbd",
  "todo",
  "name",
];

interface CapturedLog {
  readonly level: string;
  readonly message: ReadonlyArray<unknown>;
}

/**
 * Names a launch branch through `fromRunner` with a model that answers `answer`
 * (or fails when it is an error), as the launch does, capturing the logs.
 */
const nameLaunchBranch = (
  answer: string | TextGenerationError,
  options: { readonly title?: string; readonly mode?: BranchNamingMode } = {},
) => {
  const logs: Array<CapturedLog> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: [message].flat() });
  });
  const mode = options.mode ?? "static";
  const textGeneration = fromRunner("test", () =>
    typeof answer === "string"
      ? (Effect.succeed({ branch: answer }) as never)
      : Effect.fail(answer),
  );
  return textGeneration
    .generateBranchName({
      cwd: "/repo",
      message: "/factory Trilogy-Care/tc-supplier-portal-v2#401",
      modelSelection,
      naming: { mode, prefix: "t3", instructions: "" },
    })
    .pipe(
      Effect.map((result) => ({ branch: result.branch, exactName: mode === "custom" })),
      withLaunchTitleFallback(
        options.title ?? "",
        { branchNamingMode: mode, branchNamePrefix: "t3" },
        modelSelection,
      ),
      Effect.result,
      Effect.map((result) => ({
        result,
        warnings: logs.filter((log) => log.level === "Warn").map((log) => log.message),
      })),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
};

describe("isPlaceholderName", () => {
  it("matches each stand-in word, any case, numbered, wrapped or after a prefix", () => {
    for (const word of PLACEHOLDER_WORDS) {
      for (const raw of [
        word,
        word.toUpperCase(),
        `${word}-3`,
        `<${word}>`,
        `[${word}]`,
        `feat/${word}`,
        `t3/${word}-2`,
      ]) {
        assert.isTrue(isPlaceholderName(raw), raw);
      }
    }
  });

  it("passes real names", () => {
    for (const raw of [
      "issue-401",
      "placeholder-fix",
      "fix-branch-name",
      "todo-app",
      "name-3a",
      "placeholder/fix-invoices",
    ]) {
      assert.isFalse(isPlaceholderName(raw), raw);
    }
  });

  it("leaves the empty-output fallback of sanitizeBranchFragment alone", () => {
    assert.equal(sanitizeBranchFragment(""), "update");
    assert.isFalse(isPlaceholderName(""));
  });
});

describe("generated launch branch names", () => {
  it.effect("reject each stand-in word, a numbered one and a wrapped one", () =>
    Effect.gen(function* () {
      for (const raw of [...PLACEHOLDER_WORDS, "placeholder-3", "<branch>", "[placeholder]"]) {
        const { result } = yield* nameLaunchBranch(raw);
        assert.isTrue(result._tag === "Failure", raw);
        if (result._tag !== "Failure") continue;
        assert.instanceOf(result.failure, TextGenerationError);
        assert.include(result.failure.message, `'t3/${sanitizeBranchFragment(raw)}'`);
      }
    }),
  );

  it.effect("reject a stand-in word behind a semantic prefix", () =>
    Effect.gen(function* () {
      const { result } = yield* nameLaunchBranch("feat/placeholder", { mode: "semantic" });
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("pass a real name through unchanged", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* nameLaunchBranch("issue-401", { title: TITLE });
      assert.deepEqual(result._tag === "Success" ? result.success : result.failure, {
        branch: "t3/issue-401",
        exactName: false,
      });
      assert.deepEqual(warnings, []);
    }),
  );

  it.effect("log one warning with the model, the provider instance and the rejected value", () =>
    Effect.gen(function* () {
      const { warnings } = yield* nameLaunchBranch("<placeholder>");
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0]![1], {
        model: "claude-haiku-5-5",
        instanceId: "claudeAgent",
        branch: "t3/placeholder",
        fallback: null,
      });
    }),
  );

  it.effect("come from the title, with that one warning, when the model answers a stand-in", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* nameLaunchBranch("placeholder", { title: TITLE });
      assert.deepEqual(result._tag === "Success" ? result.success : result.failure, {
        branch: "t3/repo-401-fix-invoices",
        exactName: false,
      });
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0]![1], {
        model: "claude-haiku-5-5",
        instanceId: "claudeAgent",
        branch: "t3/placeholder",
        fallback: "t3/repo-401-fix-invoices",
      });
    }),
  );

  it.effect("come from the title when generation fails, warning with the model and cause", () =>
    Effect.gen(function* () {
      const failure = new TextGenerationError({
        operation: "generateBranchName",
        detail: "CLI exited 1",
      });
      const { result, warnings } = yield* nameLaunchBranch(failure, { title: TITLE });
      assert.deepEqual(result._tag === "Success" ? result.success : result.failure, {
        branch: "t3/repo-401-fix-invoices",
        exactName: false,
      });
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0]![1], {
        model: "claude-haiku-5-5",
        instanceId: "claudeAgent",
        branch: "t3/repo-401-fix-invoices",
        cause: failure,
      });
    }),
  );

  it.effect("keep the failure under custom naming, whose convention a title slug breaks", () =>
    Effect.gen(function* () {
      const failure = new TextGenerationError({
        operation: "generateBranchName",
        detail: "CLI exited 1",
      });
      const failed = yield* nameLaunchBranch(failure, { title: TITLE, mode: "custom" });
      assert.deepEqual(failed.result._tag === "Failure" ? failed.result.failure : null, failure);
      const rejected = yield* nameLaunchBranch("JIRA-1/placeholder", {
        title: TITLE,
        mode: "custom",
      });
      assert.isTrue(rejected.result._tag === "Failure");
    }),
  );
});

describe("thread titles", () => {
  it("fall back to New thread for stand-in words", () => {
    for (const raw of ["placeholder", "Placeholder-2", "<Untitled>", "[TBD]", "new-branch"]) {
      assert.equal(sanitizeThreadTitle(raw), "New thread", raw);
    }
  });

  it("keep real titles, including ones that would slug to a stand-in word", () => {
    for (const raw of ["Fix the branch name", "New branch", "Todo list", "Name: Tom"]) {
      assert.equal(sanitizeThreadTitle(raw), raw);
    }
  });
});

describe("branch names from a launch title", () => {
  const naming = { branchNamingMode: "static", branchNamePrefix: "t3" } as const;

  it("slugs the title under the configured prefix", () => {
    assert.equal(
      titleBranchName(
        "Trilogy-Care/tc-supplier-portal-v2#401 fix: supplier invoices lose their GST line",
        naming,
      ),
      "t3/trilogy-care-tc-supplier-portal-v2-401-fix-suppl",
    );
    assert.equal(titleBranchName("Fix it --", naming), "t3/fix-it");
    assert.equal(
      titleBranchName("Fix it", { branchNamingMode: "semantic", branchNamePrefix: "t3" }),
      "fix-it",
    );
  });

  it("trims a dash the 48-character cut leaves", () => {
    assert.equal(titleBranchName(`${"a".repeat(47)} b`, naming), `t3/${"a".repeat(47)}`);
  });

  it("gives none for no title, a default one, a stand-in one or one that slugs to empty", () => {
    for (const title of ["", "  ", "New thread", "placeholder", "#!?"]) {
      assert.isUndefined(titleBranchName(title, naming), title);
    }
  });

  it("gives none under custom naming", () => {
    assert.isUndefined(
      titleBranchName(TITLE, { branchNamingMode: "custom", branchNamePrefix: "t3" }),
    );
  });

  it("puts the title before the message the model names the branch from", () => {
    assert.equal(
      branchNameMessage("Repo#401 fix: invoices", "/factory Repo#401"),
      "Repo#401 fix: invoices\n\n/factory Repo#401",
    );
    assert.equal(branchNameMessage("", "/factory Repo#401"), "/factory Repo#401");
    assert.equal(branchNameMessage("New thread", "Do it"), "Do it");
  });
});
