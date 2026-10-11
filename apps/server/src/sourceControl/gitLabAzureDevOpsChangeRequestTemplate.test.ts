import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsChangeRequestTemplate from "@t3tools/source-control-azure-devops/server/azureDevOpsChangeRequestTemplate";
import * as GitLabChangeRequestTemplate from "@t3tools/source-control-gitlab/server/gitLabChangeRequestTemplate";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-change-request-template-test-",
    }),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.execute({
      operation: "changeRequestTemplate.test.runGit",
      cwd,
      args,
    });
  });

const runWithTempDirectory = <A, E, R>(
  test: (cwd: string) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-change-request-" });
      yield* runGit(cwd, ["init", "--initial-branch=main"]);
      yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test User"]);
      return yield* test(cwd);
    }),
  ).pipe(Effect.provide(layerTest));

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const commitAll = (cwd: string) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--allow-empty", "-m", "Add templates"]);
  });

const detectGitLab = (cwd: string, treeish = "HEAD") =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return Option.getOrUndefined(
      yield* GitLabChangeRequestTemplate.detect(cwd, treeish, git.execute),
    );
  });

const detectAzureDevOps = (cwd: string, treeish = "HEAD") =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return Option.getOrUndefined(
      yield* AzureDevOpsChangeRequestTemplate.detect(cwd, treeish, git.execute),
    );
  });

const MERGE_REQUEST_TEMPLATES = ".gitlab/merge_request_templates";

it.effect.each(["Default.md", "default.md", "DEFAULT.MD"])("GitLab recognizes %s", (name) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/${name}`, "## GitLab default\n");
      yield* commitAll(cwd);

      assert.strictEqual(yield* detectGitLab(cwd), "## GitLab default");
    }),
  ),
);

it.effect("GitLab prefers Default.md over the other templates in the directory", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Bugfix.md`, "bugfix template");
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Default.md`, "default template");
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Feature.md`, "feature template");
      yield* commitAll(cwd);

      assert.strictEqual(yield* detectGitLab(cwd), "default template");
    }),
  ),
);

it.effect("GitLab does not treat a lone non-default template as the default", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Bugfix.md`, "bugfix template");
      // Another host's template location is not GitLab's.
      yield* writeFile(cwd, ".github/pull_request_template.md", "github template");
      yield* commitAll(cwd);

      assert.isUndefined(yield* detectGitLab(cwd));
    }),
  ),
);

it.effect("GitLab reads the template from the requested base tree", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, "README.md", "initial\n");
      yield* commitAll(cwd);
      yield* runGit(cwd, ["branch", "feature"]);
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Default.md`, "base template");
      yield* commitAll(cwd);
      yield* runGit(cwd, ["checkout", "feature"]);

      assert.isUndefined(yield* detectGitLab(cwd));
      assert.strictEqual(yield* detectGitLab(cwd, "main"), "base template");
    }),
  ),
);

const AZURE_DEVOPS_TEMPLATE_PATHS = [
  ".azuredevops/pull_request_template.md",
  ".azuredevops/pull_request_template.txt",
  ".vsts/pull_request_template.md",
  "docs/pull_request_template.md",
  "pull_request_template.md",
  "pull_request_template.txt",
] as const;

it.effect.each(AZURE_DEVOPS_TEMPLATE_PATHS)("Azure DevOps recognizes %s", (relativePath) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, relativePath, `template from ${relativePath}`);
      yield* commitAll(cwd);

      assert.strictEqual(yield* detectAzureDevOps(cwd), `template from ${relativePath}`);
    }),
  ),
);

it.effect("Azure DevOps uses the first location in its documented order", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, "pull_request_template.md", "root template");
      yield* writeFile(cwd, "docs/pull_request_template.md", "docs template");
      yield* writeFile(cwd, ".vsts/pull_request_template.md", "vsts template");
      yield* writeFile(cwd, ".azuredevops/pull_request_template.md", "azuredevops template");
      yield* commitAll(cwd);

      assert.strictEqual(yield* detectAzureDevOps(cwd), "azuredevops template");
    }),
  ),
);

it.effect("Azure DevOps skips a blank template and falls through to the next location", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".azuredevops/pull_request_template.md", " \n");
      yield* writeFile(cwd, "pull_request_template.md", "root template");
      yield* commitAll(cwd);

      assert.strictEqual(yield* detectAzureDevOps(cwd), "root template");
    }),
  ),
);

it.effect("Azure DevOps ignores GitHub and GitLab template locations", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, ".github/pull_request_template.md", "github template");
      yield* writeFile(cwd, `${MERGE_REQUEST_TEMPLATES}/Default.md`, "gitlab template");
      yield* commitAll(cwd);

      assert.isUndefined(yield* detectAzureDevOps(cwd));
    }),
  ),
);

it.effect("Azure DevOps reads the template from the requested base tree", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeFile(cwd, "README.md", "initial\n");
      yield* commitAll(cwd);
      yield* runGit(cwd, ["branch", "feature"]);
      yield* writeFile(cwd, ".azuredevops/pull_request_template.md", "base template");
      yield* commitAll(cwd);
      yield* runGit(cwd, ["checkout", "feature"]);

      assert.isUndefined(yield* detectAzureDevOps(cwd));
      assert.strictEqual(yield* detectAzureDevOps(cwd, "main"), "base template");
    }),
  ),
);
