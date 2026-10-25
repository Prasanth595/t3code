// Dependency-free bootstrap: the launcher is needed before project installation.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const state = NodePath.join(NodeOS.homedir(), ".config/t3-task-cache");
if (process.argv[2]) {
  const credential = JSON.parse(NodeFS.readFileSync(process.argv[2], "utf8"));
  if (
    typeof credential.endpoint !== "string" ||
    typeof credential.name !== "string" ||
    typeof credential.token !== "string" ||
    credential.token.length < 32
  ) {
    throw new Error("Invalid cache credential file.");
  }
  const file = NodePath.join(state, "credentials.json");
  const credentials = NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : {};
  credentials[credential.endpoint] = { name: credential.name, token: credential.token };
  NodeFS.mkdirSync(state, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(file, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  NodeFS.chmodSync(file, 0o600);
}
const bin = NodePath.join(NodeOS.homedir(), ".local/share/t3-task-cache/bin");
NodeFS.mkdirSync(bin, { recursive: true });
const installed = NodePath.join(NodePath.dirname(bin), "vp.ts");
NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "vp.ts"), installed);
NodeFS.chmodSync(installed, 0o755);
if (!NodeFS.existsSync(NodePath.join(bin, "vp")))
  NodeFS.symlinkSync("../vp.ts", NodePath.join(bin, "vp"));
if (process.env.GITHUB_PATH) NodeFS.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
console.log("Task-cache launcher installed. It only changes projects containing .task-cache.json.");
