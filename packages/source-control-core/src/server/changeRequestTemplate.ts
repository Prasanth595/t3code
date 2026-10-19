import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "./SourceControlHost.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

interface TreeEntry {
  readonly type: "tree" | "blob";
  readonly objectId: string;
  readonly path: string;
}

function parseTreeEntries(output: string): ReadonlyArray<TreeEntry> {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }

    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    if (
      !(
        (type === "blob" && (mode === "100644" || mode === "100755")) ||
        (type === "tree" && mode === "040000")
      ) ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }

    entries.push({ type, objectId, path: record.slice(separator + 1) });
  }
  return entries;
}

function readTemplateBlob(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entry: TreeEntry;
}): Effect.Effect<Option.Option<string>, GitCommandError> {
  return input
    .executeGit({
      operation: "changeRequestTemplate.readTemplateBlob",
      cwd: input.cwd,
      args: ["cat-file", "blob", input.entry.objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => {
        const template = result.stdout.trim();
        if (template.length === 0) {
          return Option.none();
        }
        return Option.some(
          result.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
            ? `${template}\n\n${TRUNCATION_MARKER}`
            : template,
        );
      }),
    );
}

type DirectoryTemplateResult =
  | { readonly _tag: "None" }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Template"; readonly template: string };

function readTemplateDirectory(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entries: ReadonlyArray<TreeEntry>;
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

export const detect = Effect.fn("changeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
  locations: { readonly paths: ReadonlyArray<string> } & (
    | { readonly caseInsensitive: true }
    | { readonly caseInsensitive: false; readonly directories: ReadonlyArray<string> }
  ),
) {
  return yield* Effect.gen(function* () {
    // Read committed regular blobs so worktree edits and repository symlinks cannot
    // substitute host files for the base template.
    if (locations.caseInsensitive) {
      // ls-tree does not support case-insensitive pathspecs. Walk only candidate
      // parents, sharing their bounded listings across template paths.
      const trees = new Map<string, ReadonlyArray<TreeEntry>>();
      for (const templatePath of locations.paths) {
        let directory = "";
        const components = templatePath.split("/");
        for (const [index, component] of components.entries()) {
          let children = trees.get(directory);
          if (!children) {
            const listing = yield* executeGit({
              operation: "changeRequestTemplate.listDirectory",
              cwd,
              args: ["ls-tree", "-z", "--full-tree", `${treeish}:${directory}`],
              maxOutputBytes: TREE_LIST_MAX_BYTES,
              appendTruncationMarker: true,
            });
            if (listing.stdoutTruncated) return Option.none();
            children = parseTreeEntries(listing.stdout);
            trees.set(directory, children);
          }
          const type = index === components.length - 1 ? "blob" : "tree";
          const candidates = children.filter((entry) => entry.type === type);
          const entry =
            candidates.find((entry) => entry.path === component) ??
            candidates.find((entry) => entry.path.toLowerCase() === component.toLowerCase());
          if (!entry) break;
          if (entry.type === "blob") {
            const template = yield* readTemplateBlob({ cwd, executeGit, entry });
            if (Option.isSome(template)) return template;
          } else {
            directory = directory ? `${directory}/${entry.path}` : entry.path;
          }
        }
      }
      return Option.none();
    }
    const result = yield* executeGit({
      operation: "changeRequestTemplate.listTemplates",
      cwd,
      args: [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        treeish,
        "--",
        ...locations.paths,
        ...locations.directories,
      ],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (result.stdoutTruncated) return Option.none();
    const entries = parseTreeEntries(result.stdout);
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const templatePath of locations.paths) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) {
        continue;
      }
      const template = yield* readTemplateBlob({ cwd, executeGit, entry });
      if (Option.isSome(template)) {
        return template;
      }
    }

    for (const directory of locations.directories) {
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
