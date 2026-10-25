#!/usr/bin/env node
// @effect-diagnostics globalConsole:off - standalone CLI output.
// @effect-diagnostics globalFetch:off - standalone Cloudflare deployment CLI.
// @effect-diagnostics nodeBuiltinImport:off - standalone deployment and installation tooling uses Node before project dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const revision = "5b06c2c10d84ea441735ba07c46f6d1b7cb2ff3b";
const source = import.meta.dirname;
const project = NodePath.resolve(source, "../..");
const state = NodePath.join(NodeOS.homedir(), ".config/t3-task-cache");
const checkout = NodePath.join(NodeOS.homedir(), ".cache/t3-task-cache", revision);
const wrangler = NodePath.join(checkout, "node_modules/wrangler/bin/wrangler.js");

function run(command: string, args: string[], cwd = checkout, capture = false, input?: string) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: process.env,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status}).`);
  return result.stdout?.trim() ?? "";
}

function save(path: string, value: unknown) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  NodeFS.chmodSync(path, 0o600);
}

async function prepare() {
  if (!NodeFS.existsSync(NodePath.join(checkout, ".git"))) {
    NodeFS.mkdirSync(NodePath.dirname(checkout), { recursive: true });
    run(
      "git",
      [
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        "https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare.git",
        checkout,
      ],
      project,
    );
    run("git", ["checkout", revision]);
  }
  // Reapply our small overlay to the pinned source, without resetting operator state.
  for (const file of ["src/index.ts", "wrangler.jsonc"]) {
    NodeFS.writeFileSync(
      NodePath.join(checkout, file),
      run("git", ["show", `${revision}:${file}`], checkout, true) + "\n",
    );
  }
  run("git", ["apply", NodePath.join(source, "upstream.patch")]);
  for (const file of ["developer-auth.ts", "queued-admission.ts"]) {
    NodeFS.copyFileSync(NodePath.join(source, file), NodePath.join(checkout, "src", file));
  }
  if (!NodeFS.existsSync(wrangler)) run("vp", ["install", "--frozen-lockfile"]);
}

async function cloudflare() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    let auth;
    try {
      auth = JSON.parse(
        run(process.execPath, [wrangler, "auth", "token", "--json"], checkout, true),
      );
    } catch {
      throw new Error("Cloudflare login is unavailable or expired. Run npx wrangler login first.");
    }
    if (!auth.token) throw new Error("Run npx wrangler login first.");
    process.env.CLOUDFLARE_API_TOKEN = auth.token;
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    });
    const data = (await response.json()) as { result?: Array<{ id: string }> };
    if (!response.ok || data.result?.length !== 1) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID to select the cache's Cloudflare account.");
    }
    process.env.CLOUDFLARE_ACCOUNT_ID = data.result[0]!.id;
  }
}

function endpoint() {
  return (
    JSON.parse(NodeFS.readFileSync(NodePath.join(project, ".task-cache.json"), "utf8")) as {
      endpoint: string;
    }
  ).endpoint;
}

function install() {
  const bin = NodePath.join(NodeOS.homedir(), ".local/share/t3-task-cache/bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  const installed = NodePath.join(NodePath.dirname(bin), "vp.ts");
  NodeFS.copyFileSync(NodePath.join(source, "vp.ts"), installed);
  NodeFS.chmodSync(installed, 0o755);
  if (!NodeFS.existsSync(NodePath.join(bin, "vp")))
    NodeFS.symlinkSync("../vp.ts", NodePath.join(bin, "vp"));
  if (process.env.GITHUB_PATH) {
    NodeFS.writeFileSync(process.env.GITHUB_PATH, `${bin}\n`, { flag: "a" });
  } else {
    console.log(`Add this after Vite+'s shell setup: export PATH="${bin}:$PATH"`);
  }
  console.log(
    "Task-cache launcher installed. It only changes projects containing .task-cache.json.",
  );
}

const command = process.argv[2];
if (command === "install") {
  install();
} else if (command === "import") {
  const file = process.argv[3];
  if (!file) throw new Error("Usage: manage.ts import <private credential file>");
  const credential = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const path = NodePath.join(state, "credentials.json");
  const credentials = NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : {};
  credentials[credential.endpoint] = { name: credential.name, token: credential.token };
  save(path, credentials);
  install();
} else if (command === "prepare") {
  await prepare();
  console.log(checkout);
} else if (command === "deploy" || command === "add-writer" || command === "revoke-writer") {
  await prepare();
  await cloudflare();
  if (command === "deploy") {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
      {
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      },
    );
    const data = (await response.json()) as { result?: { subdomain: string } };
    if (!response.ok || !data.result?.subdomain)
      throw new Error("Cloudflare Workers subdomain unavailable.");
    const origin = `https://t3-task-cache.${data.result.subdomain}.workers.dev`;
    run(process.execPath, [
      "--import",
      "tsx",
      "scripts/operator.ts",
      "setup",
      "--name",
      "t3-task-cache",
      "--namespace",
      "t3code",
      "--repo",
      "pingdotgg/t3code",
      "--origin",
      origin,
    ]);
    save(NodePath.join(project, ".task-cache.json"), { endpoint: `${origin}/projects/t3code` });
    console.log(`Cache endpoint: ${origin}/projects/t3code`);
  } else {
    const name = process.argv[3];
    if (!name || !/^[a-z0-9-]{1,64}$/.test(name))
      throw new Error("Supply a writer name using lowercase letters, digits, or hyphens.");
    const path = NodePath.join(state, "writers.json");
    const writers: Record<string, string> = NodeFS.existsSync(path)
      ? JSON.parse(NodeFS.readFileSync(path, "utf8"))
      : {};
    if (command === "revoke-writer") {
      delete writers[name];
    } else {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      writers[name] = NodeCrypto.createHash("sha256").update(token).digest("hex");
      save(NodePath.join(state, `${name}.json`), { endpoint: endpoint(), name, token });
    }
    run(
      process.execPath,
      [wrangler, "secret", "put", "DEVELOPER_KEYS", "--config", "wrangler.operator.json"],
      checkout,
      true,
      JSON.stringify(writers),
    );
    save(path, writers);
    console.log(
      command === "add-writer"
        ? `Private credential written to ${NodePath.join(state, `${name}.json`)}. Import it on the writer's machine.`
        : `Revoked ${name}.`,
    );
  }
} else {
  throw new Error(
    "Usage: manage.ts prepare | deploy | add-writer <name> | revoke-writer <name> | import <file> | install",
  );
}
