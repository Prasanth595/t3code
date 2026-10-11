/**
 * Azure Repos' default pull request template convention: the first `pull_request_template`
 * (`.md` or `.txt`) found in `.azuredevops`, `.vsts`, `docs`, then the repository root, read from
 * the committed base tree. Branch-specific and additional templates are not consulted.
 *
 * @module source-control-azure-devops/server/azureDevOpsChangeRequestTemplate
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  listTemplateEntries,
  readTemplateBlob,
  type ExecuteGit,
} from "@t3tools/source-control-core/server/changeRequestTemplate";

const TEMPLATE_PATHS = [
  ".azuredevops/pull_request_template.md",
  ".azuredevops/pull_request_template.txt",
  ".vsts/pull_request_template.md",
  ".vsts/pull_request_template.txt",
  "docs/pull_request_template.md",
  "docs/pull_request_template.txt",
  "pull_request_template.md",
  "pull_request_template.txt",
] as const;

export const detect = Effect.fn("azureDevOpsChangeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    const listed = yield* listTemplateEntries({
      cwd,
      treeish,
      executeGit,
      operation: "azureDevOpsChangeRequestTemplate.listTemplates",
      paths: TEMPLATE_PATHS,
    });
    if (Option.isNone(listed)) {
      return Option.none();
    }

    const entriesByPath = new Map(listed.value.map((entry) => [entry.path, entry]));
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
    return Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});
