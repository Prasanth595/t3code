import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  branchNameMessage,
  isPlaceholderName,
  titleBranchName,
} from "@t3tools/shared/placeholderNames";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

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

/** Generates a branch name through `fromRunner` with a model that answers `branch`, capturing the logs. */
const generateBranch = (branch: string) => {
  const logs: Array<CapturedLog> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: [message].flat() });
  });
  const textGeneration = fromRunner("test", () => Effect.succeed({ branch }) as never);
  return textGeneration
    .generateBranchName({
      cwd: "/repo",
      message: "/factory Trilogy-Care/tc-supplier-portal-v2#401",
      modelSelection,
      naming: { mode: "static", prefix: "t3", instructions: "" },
    })
    .pipe(
      Effect.result,
      Effect.map((result) => ({ result, logs })),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
};

describe("isPlaceholderName", () => {
  it("matches each stand-in word, any case, numbered or wrapped", () => {
    for (const word of PLACEHOLDER_WORDS) {
      for (const raw of [word, word.toUpperCase(), `${word}-3`, `<${word}>`, `[${word}]`]) {
        assert.isTrue(isPlaceholderName(raw), raw);
      }
    }
  });

  it("passes real names", () => {
    for (const raw of ["issue-401", "placeholder-fix", "fix-branch-name", "todo-app", "name-3a"]) {
      assert.isFalse(isPlaceholderName(raw), raw);
    }
  });

  it("leaves the empty-output fallback of sanitizeBranchFragment alone", () => {
    assert.equal(sanitizeBranchFragment(""), "update");
    assert.isFalse(isPlaceholderName(""));
  });
});

describe("generated branch names", () => {
  it.effect("rejects each stand-in word, a numbered one and a wrapped one", () =>
    Effect.gen(function* () {
      for (const raw of [...PLACEHOLDER_WORDS, "placeholder-3", "<branch>", "[placeholder]"]) {
        const { result } = yield* generateBranch(raw);
        assert.isTrue(result._tag === "Failure", raw);
        if (result._tag !== "Failure") continue;
        assert.instanceOf(result.failure, TextGenerationError);
        assert.include(result.failure.message, raw);
      }
    }),
  );

  it.effect("passes a real name through unchanged", () =>
    Effect.gen(function* () {
      const { result, logs } = yield* generateBranch("issue-401");
      assert.deepEqual(result._tag === "Success" ? result.success : result.failure, {
        branch: "t3/issue-401",
      });
      assert.deepEqual(
        logs.filter((log) => log.level === "Warn"),
        [],
      );
    }),
  );

  it.effect("logs one warning with the model, the provider instance and the raw value", () =>
    Effect.gen(function* () {
      const { logs } = yield* generateBranch("<placeholder>");
      const warnings = logs.filter((log) => log.level === "Warn");
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0]!.message[1], {
        model: "claude-haiku-5-5",
        instanceId: "claudeAgent",
        branch: "<placeholder>",
      });
    }),
  );
});

describe("thread titles", () => {
  it("fall back to New thread for stand-in words", () => {
    for (const raw of ["placeholder", "Placeholder-2", "<Untitled>", "[TBD]"]) {
      assert.equal(sanitizeThreadTitle(raw), "New thread", raw);
    }
  });

  it("keep real titles", () => {
    assert.equal(sanitizeThreadTitle("Fix the branch name"), "Fix the branch name");
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

  it("puts the title before the message the model names the branch from", () => {
    assert.equal(
      branchNameMessage("Repo#401 fix: invoices", "/factory Repo#401"),
      "Repo#401 fix: invoices\n\n/factory Repo#401",
    );
    assert.equal(branchNameMessage("", "/factory Repo#401"), "/factory Repo#401");
    assert.equal(branchNameMessage("New thread", "Do it"), "Do it");
  });
});
