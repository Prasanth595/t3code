/**
 * GitHub's pull request template convention: the first single template found at a known path,
 * or the only Markdown file in a template directory, read from the committed base tree.
 *
 * @module source-control-github/server/gitHubChangeRequestTemplate
 */
import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  listTemplateEntries,
  readTemplateBlob,
  type ExecuteGit,
  type TemplateTreeEntry,
} from "@t3tools/source-control-core/server/changeRequestTemplate";

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const TREE_PATHS = [...TEMPLATE_PATHS, ...TEMPLATE_DIRECTORIES] as const;

type DirectoryTemplateResult =
  | { readonly _tag: "None" }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Template"; readonly template: string };

function readTemplateDirectory(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entries: ReadonlyArray<TemplateTreeEntry>;
  readonly directory: string;
}): Effect.Effect<DirectoryTemplateResult, GitCommandError> {
  return Effect.gen(function* () {
    const prefix = `${input.directory}/`;
    const candidates = input.entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) {
        return false;
      }
      const relativePath = entry.path.slice(prefix.length);
      return !relativePath.includes("/") && relativePath.toLowerCase().endsWith(".md");
    });

    const templates: string[] = [];
    for (const entry of candidates) {
      const template = yield* readTemplateBlob({ ...input, entry });
      if (Option.isSome(template)) {
        templates.push(template.value);
        if (templates.length > 1) {
          return { _tag: "Ambiguous" } as const;
        }
      }
    }

    return templates[0]
      ? ({ _tag: "Template", template: templates[0] } as const)
      : ({ _tag: "None" } as const);
  });
}

export const detect = Effect.fn("gitHubChangeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    const listed = yield* listTemplateEntries({
      cwd,
      treeish,
      executeGit,
      operation: "gitHubChangeRequestTemplate.listTemplates",
      paths: TREE_PATHS,
    });
    if (Option.isNone(listed)) {
      return Option.none();
    }

    const entries = listed.value;
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const templatePath of TEMPLATE_PATHS) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) {
        continue;
      }
      const template = yield* readTemplateBlob({ cwd, executeGit, entry });
      if (Option.isSome(template)) {
        return template;
      }
    }

    for (const directory of TEMPLATE_DIRECTORIES) {
      const directoryTemplate = yield* readTemplateDirectory({
        cwd,
        executeGit,
        entries,
        directory,
      });
      if (directoryTemplate._tag === "Template") {
        return Option.some(directoryTemplate.template);
      }
      if (directoryTemplate._tag === "Ambiguous") {
        return Option.none();
      }
    }

    return Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
});
