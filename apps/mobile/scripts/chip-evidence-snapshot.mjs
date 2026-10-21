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
const archive = NodeChildProcess.execFileSync("git", ["archive", sha], {
  cwd: root,
  maxBuffer: 256 * 1024 * 1024,
});
const extracted = NodeChildProcess.spawnSync("tar", ["-x", "-C", destination], { input: archive });
if (extracted.status !== 0) throw new Error(extracted.stderr.toString());
// The exact same fixture is overlaid onto both revisions; only this adapter differs
// because main predates the inherited native project glyph rasterizer.
for (const path of [
  "apps/mobile/src/features/chip-evidence",
  "apps/mobile/index.ts",
  "apps/mobile/eas.json",
  "apps/mobile/scripts/chip-evidence-snapshot.mjs",
]) {
  NodeFS.cpSync(NodePath.resolve(root, path), NodePath.resolve(destination, path), {
    recursive: true,
  });
}
const hasRasterizer = NodeFS.existsSync(
  NodePath.resolve(destination, "apps/mobile/src/native/ProjectChipIconImages.tsx"),
);
NodeFS.writeFileSync(
  NodePath.resolve(destination, "apps/mobile/src/features/chip-evidence/rasterizer.tsx"),
  hasRasterizer
    ? 'export { ProjectChipIconRasterizer as Rasterizer } from "../../native/ProjectChipIconImages";\n'
    : "export function Rasterizer() { return null; }\n",
);
NodeFS.writeFileSync(
  NodePath.resolve(destination, "chip-evidence-source.json"),
  JSON.stringify(
    {
      sourceSha: sha,
      fixtureSha: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      hasRasterizer,
    },
    null,
    2,
  ),
);
process.stdout.write(`${sha}\n${NodePath.resolve(destination)}\n`);
