// Root-pinned deterministic replay executor for the quota policy source.
// The runner supplies read-only copies, hides its grading spec and independently
// checks these read digests. No model, network, credentials or expected answers.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const task = JSON.parse(
  fs.readFileSync(path.join(process.env.NOFUN_REPLAY_INPUT_DIR, "task.json"), "utf8"),
);
const skillReads = [];
let answer;
if (task.operation === "classify_usage") {
  const filename = path.join(process.env.NOFUN_REPLAY_SKILL_DIR, "usageHeadroom.ts");
  const bytes = fs.readFileSync(filename);
  skillReads.push({
    path: "usageHeadroom.ts",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
  const { usageHeadroom } = await import(pathToFileURL(filename).href);
  answer = JSON.stringify(usageHeadroom(task.limits, task.nowMs, task.options));
} else {
  answer = JSON.stringify({ status: "not_applicable" });
}
fs.writeFileSync(
  path.join(process.env.NOFUN_REPLAY_OUT_DIR, "result.json"),
  JSON.stringify({ completed: true, answer, skillReads }),
);
