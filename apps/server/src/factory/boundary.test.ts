// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vite-plus/test";

interface SourceFile {
  /** Relative to apps/server/src, with `/` separators. */
  readonly path: string;
  readonly imports: ReadonlyArray<string>;
}

const resolveRelative = (file: string, specifier: string) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));

/**
 * Factory code (except factory/t3/) may only import relative paths inside factory/.
 * Nothing outside factory/ may import it, except server.ts.
 */
export const findBoundaryViolations = (files: ReadonlyArray<SourceFile>): Array<string> => {
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

const srcRoot = path.resolve(import.meta.dirname, "..");

const listSourceFiles = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("factory boundary", () => {
  it("holds for the real tree", () => {
    const files = listSourceFiles(srcRoot).map((full) => ({
      path: path.relative(srcRoot, full).split(path.sep).join("/"),
      imports: extractImports(fs.readFileSync(full, "utf8")),
    }));
    expect(files.some((file) => file.path === "factory/index.ts")).toBe(true);
    expect(findBoundaryViolations(files)).toEqual([]);
  });

  it("flags factory code importing from outside factory/, except under factory/t3/", () => {
    const violations = findBoundaryViolations([
      { path: "factory/foo.ts", imports: ["../config.ts", "effect/Effect", "./bar.ts"] },
      { path: "factory/t3/paths.ts", imports: ["../../config.ts"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("factory/foo.ts");
    expect(violations[0]).toContain("../config.ts");
  });

  it("flags code outside factory/ importing the factory, except server.ts", () => {
    const violations = findBoundaryViolations([
      { path: "orchestration-v2/x.ts", imports: ["../factory/index.ts"] },
      { path: "server.ts", imports: ["./factory/index.ts"] },
    ]);
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
