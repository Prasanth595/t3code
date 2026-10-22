// Starts and stops one worktree's `vp run dev`, tracking only the process group it spawned.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export async function stopServer(pidFile) {
  if (!existsSync(pidFile)) return;
  const pgid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pgid, 0);
    } catch {
      break;
    }
    await sleep(250);
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
  rmSync(pidFile);
}

export async function startServer({ worktree, pidFile, logFile }) {
  const out = openSync(logFile, "w");
  const child = spawn("vp", ["run", "dev"], {
    cwd: worktree,
    detached: true,
    stdio: ["ignore", out, out],
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  for (let i = 0; i < 240; i++) {
    const log = readFileSync(logFile, "utf8");
    if (
      /Listening on http/.test(log) &&
      /webPort=\d+/.test(log) &&
      /VITE|ready in|Local:/i.test(log)
    )
      break;
    if (/Listening on http/.test(log) && i > 20) break;
    await sleep(500);
  }
  // Vite and provider snapshots settle a little after the server listens.
  await sleep(4000);
}
