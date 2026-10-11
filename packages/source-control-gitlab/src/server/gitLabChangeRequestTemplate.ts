/**
 * GitLab's merge request template convention: `Default.md` (case-insensitive) in
 * `.gitlab/merge_request_templates`, read from the committed base tree. The other files in that
 * directory are templates a user picks by hand, so they are never the default.
 *
 * @module source-control-gitlab/server/gitLabChangeRequestTemplate
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  listTemplateEntries,
  readTemplateBlob,
  type ExecuteGit,
} from "@t3tools/source-control-core/server/changeRequestTemplate";

const TEMPLATE_DIRECTORY = ".gitlab/merge_request_templates";
const DEFAULT_TEMPLATE_NAME = "default.md";

export const detect = Effect.fn("gitLabChangeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    const listed = yield* listTemplateEntries({
      cwd,
      treeish,
      executeGit,
      operation: "gitLabChangeRequestTemplate.listTemplates",
      paths: [TEMPLATE_DIRECTORY],
    });
    if (Option.isNone(listed)) {
      return Option.none();
    }

    const entry = listed.value.find(
      (candidate) =>
        candidate.path.toLowerCase() === `${TEMPLATE_DIRECTORY}/${DEFAULT_TEMPLATE_NAME}`,
    );
    return entry ? yield* readTemplateBlob({ cwd, executeGit, entry }) : Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});
