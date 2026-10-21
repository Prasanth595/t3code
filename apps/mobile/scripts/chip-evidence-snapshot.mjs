import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const [ref, destination] = process.argv.slice(2);
if (!ref || !destination || !NodePath.resolve(destination).startsWith("/tmp/")) {
  throw new Error(
    "Usage: node apps/mobile/scripts/chip-evidence-snapshot.mjs <ref> /tmp/<snapshot>",
  );
}
const sha = NodeChildProcess.execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
NodeFS.mkdirSync(destination, { recursive: false });
const archivePath = `${destination}.tar`;
try {
  NodeChildProcess.execFileSync("git", ["archive", sha, "--output", archivePath], { cwd: root });
  NodeChildProcess.execFileSync("tar", ["-xf", archivePath, "-C", destination]);
} finally {
  NodeFS.rmSync(archivePath, { force: true });
}
// The exact same fixture is overlaid onto both revisions; only this adapter differs
// because main predates the inherited native project glyph rasterizer.
const fixtureSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const overlay = NodeChildProcess.execFileSync(
  "git",
  [
    "archive",
    fixtureSha,
    "--",
    "apps/mobile/src/features/chip-evidence",
    "apps/mobile/index.ts",
    "apps/mobile/eas.json",
    "apps/mobile/scripts/chip-evidence-snapshot.mjs",
  ],
  { cwd: root, maxBuffer: 32 * 1024 * 1024 },
);
const overlaid = NodeChildProcess.spawnSync("tar", ["-x", "-C", destination], { input: overlay });
if (overlaid.status !== 0) throw new Error(overlaid.stderr.toString());
const hasRasterizer = NodeFS.existsSync(
  NodePath.resolve(destination, "apps/mobile/src/native/ProjectChipIconImages.tsx"),
);
if (!hasRasterizer)
  NodeFS.writeFileSync(
    NodePath.resolve(destination, "apps/mobile/src/features/chip-evidence/rasterizer.tsx"),
    "export function Rasterizer() { return null; }\nexport function seedGlyphFailures() {}\n",
  );
NodeFS.writeFileSync(
  NodePath.resolve(destination, "chip-evidence-source.json"),
  JSON.stringify(
    {
      sourceSha: sha,
      fixtureSha,
      hasRasterizer,
    },
    null,
    2,
  ),
);
process.stdout.write(`${sha}\n${NodePath.resolve(destination)}\n`);
