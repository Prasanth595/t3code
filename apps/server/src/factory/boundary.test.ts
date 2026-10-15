// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

interface SourceFile {
  /** Relative to apps/server/src, with `/` separators. */
  readonly path: string;
  readonly imports: ReadonlyArray<string>;
}

const resolveRelative = (file: string, specifier: string) =>
  NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier));

const packageName = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/**
 * Factory code (except factory/t3/) may not import T3 code: neither relative paths outside
 * factory/ nor the server's workspace packages. Nothing outside factory/ may import it,
 * except server.ts.
 */
export const findBoundaryViolations = (
  files: ReadonlyArray<SourceFile>,
  workspacePackages: ReadonlySet<string>,
): Array<string> => {
  const violations: Array<string> = [];
  for (const file of files) {
    const relative = file.imports.filter((specifier) => specifier.startsWith("."));
    if (file.path.startsWith("factory/")) {
      if (file.path.startsWith("factory/t3/")) continue;
      for (const specifier of relative) {
        if (!resolveRelative(file.path, specifier).startsWith("factory/")) {
          violations.push(`${file.path} imports ${specifier} from outside factory/`);
        }
      }
      for (const specifier of file.imports) {
        if (workspacePackages.has(packageName(specifier))) {
          violations.push(`${file.path} imports ${specifier}, a T3 package`);
        }
      }
    } else if (file.path !== "server.ts") {
      for (const specifier of relative) {
        if (resolveRelative(file.path, specifier).startsWith("factory/")) {
          violations.push(`${file.path} imports ${specifier} from factory/`);
        }
      }
    }
  }
  return violations;
};

const IMPORT_PATTERNS = [
  /\bfrom\s*"([^"]+)"/g,
  /\bfrom\s*'([^']+)'/g,
  /\bimport\s*"([^"]+)"/g,
  /\bimport\s*'([^']+)'/g,
  /\bimport\(\s*"([^"]+)"\s*\)/g,
  /\bimport\(\s*'([^']+)'\s*\)/g,
];

const extractImports = (source: string): Array<string> =>
  IMPORT_PATTERNS.flatMap((pattern) => Array.from(source.matchAll(pattern), (match) => match[1]!));

const srcRoot = NodePath.resolve(import.meta.dirname, "..");

/** The server's `workspace:` dependencies, which are T3 code. */
const readWorkspacePackages = (): ReadonlySet<string> => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.resolve(srcRoot, "../package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  return new Set(
    [manifest.dependencies, manifest.devDependencies].flatMap((deps) =>
      Object.entries(deps ?? {})
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([name]) => name),
    ),
  );
};

const listSourceFiles = (dir: string): Array<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("factory boundary", () => {
  it("holds for the real tree", () => {
    const files = listSourceFiles(srcRoot).map((full) => ({
      path: NodePath.relative(srcRoot, full).split(NodePath.sep).join("/"),
      imports: extractImports(NodeFS.readFileSync(full, "utf8")),
    }));
    expect(files.some((file) => file.path === "factory/index.ts")).toBe(true);
    expect(files.find((file) => file.path === "server.ts")?.imports).toContain(
      "./factory/index.ts",
    );
    const workspacePackages = readWorkspacePackages();
    expect(workspacePackages.has("@t3tools/contracts")).toBe(true);
    expect(findBoundaryViolations(files, workspacePackages)).toEqual([]);
  });

  it("flags factory code importing from outside factory/, except under factory/t3/", () => {
    const violations = findBoundaryViolations(
      [
        { path: "factory/foo.ts", imports: ["../config.ts", "effect/Effect", "./bar.ts"] },
        { path: "factory/t3/paths.ts", imports: ["../../config.ts"] },
      ],
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("factory/foo.ts");
    expect(violations[0]).toContain("../config.ts");
  });

  it("flags factory code importing T3 workspace packages, except under factory/t3/", () => {
    const violations = findBoundaryViolations(
      [
        {
          path: "factory/domain/lifecycle.ts",
          imports: ["@t3tools/contracts", "@t3tools/shared/git", "effect/Effect", "node:fs"],
        },
        { path: "factory/t3/threads.ts", imports: ["@t3tools/contracts"] },
      ],
      new Set(["@t3tools/contracts", "@t3tools/shared"]),
    );
    expect(violations).toEqual([
      "factory/domain/lifecycle.ts imports @t3tools/contracts, a T3 package",
      "factory/domain/lifecycle.ts imports @t3tools/shared/git, a T3 package",
    ]);
  });

  it("flags code outside factory/ importing the factory, except server.ts", () => {
    const violations = findBoundaryViolations(
      [
        { path: "orchestration-v2/x.ts", imports: ["../factory/index.ts"] },
        { path: "server.ts", imports: ["./factory/index.ts"] },
      ],
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("orchestration-v2/x.ts");
  });

  it("extracts static, side-effect and dynamic imports", () => {
    expect(
      extractImports(
        `import a from "./a.ts";\nimport 'b';\nexport * from './c.ts';\nconst d = await import("./d.ts");`,
      ).toSorted(),
    ).toEqual(["./a.ts", "./c.ts", "./d.ts", "b"]);
  });
});
