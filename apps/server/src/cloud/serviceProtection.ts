import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { BOOT_SERVICE_UNIT_FILE } from "./bootService.ts";

const PROTECT_DROP_IN = "90-t3code-protect.conf";
const SYSTEM_UNIT_DIR = "/etc/systemd/system";
export const REMOTE_ACCESS_UNITS = ["tailscaled.service", "ssh.service", "sshd.service"];

// Covers app.slice (the server's 1536M) and init.scope (the user manager's 256M).
const USER_CHAIN_LOW = "MemoryLow=2G";
// Near the floor, but unlike -1000 the kernel can still kill it as a last resort.
const PROTECTED_OOM_SCORE = "OOMScoreAdjust=-900";

export interface DropIn {
  readonly unit: string;
  readonly path: string;
  readonly contents: string;
}

export interface ProtectionPlan {
  /** Written through sudo. */
  readonly system: ReadonlyArray<DropIn>;
  /**
   * Written before the manager's own score drops. Unset, a user manager hands
   * its services its own score plus 100: -800 once it runs at -900.
   */
  readonly managerDefaults: DropIn;
  readonly user: ReadonlyArray<DropIn>;
  /** System units whose running main process takes its configured OOM score at once. */
  readonly oomUnits: ReadonlyArray<string>;
}

const dropIn = (
  directory: string,
  unit: string,
  section: string,
  properties: ReadonlyArray<string>,
): DropIn => ({
  unit,
  path: `${directory}/${unit}.d/${PROTECT_DROP_IN}`,
  contents: [`[${section}]`, ...properties, ""].join("\n"),
});

/**
 * Memory protection only reaches the server when every ancestor cgroup grants
 * it, and only root can grant it on user.slice and the user manager.
 */
export function protectionPlan(input: {
  readonly uid: number;
  readonly userUnitDir: string;
  readonly remoteAccessUnits: ReadonlyArray<string>;
}): ProtectionPlan {
  const manager = `user@${input.uid}.service`;
  const remote = input.remoteAccessUnits;
  const system = (unit: string, section: string, properties: ReadonlyArray<string>) =>
    dropIn(SYSTEM_UNIT_DIR, unit, section, properties);
  const user = (unit: string, section: string, properties: ReadonlyArray<string>) =>
    dropIn(input.userUnitDir, unit, section, properties);
  return {
    system: [
      system("user.slice", "Slice", [USER_CHAIN_LOW]),
      system(`user-${input.uid}.slice`, "Slice", [USER_CHAIN_LOW]),
      system(manager, "Service", [USER_CHAIN_LOW, PROTECTED_OOM_SCORE]),
      ...(remote.length > 0 ? [system("system.slice", "Slice", ["MemoryLow=512M"])] : []),
      ...remote.map((unit) => system(unit, "Service", ["MemoryLow=256M", PROTECTED_OOM_SCORE])),
    ],
    managerDefaults: {
      unit: "user.conf",
      path: `${input.userUnitDir.replace(/\/user$/, "")}/user.conf.d/${PROTECT_DROP_IN}`,
      contents: "[Manager]\nDefaultOOMScoreAdjust=200\n",
    },
    user: [
      user("app.slice", "Slice", ["MemoryLow=1536M"]),
      user("init.scope", "Scope", ["MemoryLow=256M"]),
      user(BOOT_SERVICE_UNIT_FILE, "Service", [PROTECTED_OOM_SCORE]),
    ],
    oomUnits: [manager, ...remote],
  };
}

const quoteShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const directoryOf = (file: string) => file.slice(0, file.lastIndexOf("/"));

export function renderPrivilegedScript(plan: ProtectionPlan, mode: "apply" | "undo"): string {
  const lines = ["set -e"];
  for (const { path, contents } of plan.system) {
    const directory = quoteShell(directoryOf(path));
    if (mode === "apply") {
      lines.push(
        `mkdir -p ${directory}`,
        `cat >${quoteShell(path)} <<'T3CODE_PROTECT'`,
        contents.trimEnd(),
        "T3CODE_PROTECT",
      );
    } else {
      lines.push(`rm -f ${quoteShell(path)}`, `rmdir ${directory} 2>/dev/null || true`);
    }
  }
  lines.push(
    "systemctl daemon-reload",
    // OOMScoreAdjust applies at exec; this gives running main processes the configured score.
    `for unit in ${plan.oomUnits.map(quoteShell).join(" ")}; do`,
    '  pid=$(systemctl show --property=MainPID --value "$unit")',
    '  if [ "${pid:-0}" -gt 0 ]; then',
    '    systemctl show --property=OOMScoreAdjust --value "$unit" >"/proc/$pid/oom_score_adj" || true',
    "  fi",
    "done",
    "",
  );
  return lines.join("\n");
}

export class ServiceProtectionError extends Schema.TaggedError<ServiceProtectionError>()(
  "ServiceProtectionError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.step}: ${this.detail}`;
  }
}

function parseUnits(text: string): Array<Map<string, string>> {
  return text
    .split(/\n\s*\n/)
    .map(
      (block) =>
        new Map(
          block
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        ),
    )
    .filter((values) => values.size > 0);
}

/** Loaded remote-access units by canonical name, so an alias such as sshd.service counts once. */
export function loadedRemoteAccessUnits(systemctlShow: string): ReadonlyArray<string> {
  const units = parseUnits(systemctlShow)
    .filter((values) => values.get("LoadState") === "loaded")
    .map((values) => values.get("Id") ?? "")
    .filter((id) => REMOTE_ACCESS_UNITS.includes(id));
  return [...new Set(units)];
}

const run = Effect.fn("ServiceProtection.run")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({ command, args, timeout: "30 seconds" })
    .pipe(Effect.mapError((cause) => new ServiceProtectionError({ step, detail: String(cause) })));
  if (result.code !== 0) {
    return yield* new ServiceProtectionError({
      step,
      detail: result.stderr.trim() || `${command} exited with ${result.code}`,
    });
  }
  return result.stdout;
});

const userSettingsError = (cause: { readonly message: string }) =>
  new ServiceProtectionError({ step: "change systemd user settings", detail: cause.message });

/** Undefined when there is no systemd system manager to ask. */
export const detectRemoteAccessUnits = run("list remote-access services", "systemctl", [
  "show",
  "--property=Id,LoadState",
  ...REMOTE_ACCESS_UNITS,
]).pipe(
  Effect.map(loadedRemoteAccessUnits),
  Effect.option,
  Effect.map(Option.getOrUndefined),
  Effect.withSpan("ServiceProtection.detectRemoteAccessUnits"),
);

const reloadUserManager = run("reload systemd user units", "systemctl", [
  "--user",
  "daemon-reload",
]);

const writeDropIns = Effect.fn("ServiceProtection.writeDropIns")(function* (
  dropIns: ReadonlyArray<DropIn>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const { path, contents } of dropIns) {
    yield* fs.makeDirectory(directoryOf(path), { recursive: true });
    yield* fs.writeFileString(path, contents);
  }
}, Effect.mapError(userSettingsError));

const removeDropIns = Effect.fn("ServiceProtection.removeDropIns")(function* (
  dropIns: ReadonlyArray<DropIn>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const { path } of dropIns) {
    yield* fs.remove(path, { force: true });
    yield* fs.remove(directoryOf(path)).pipe(Effect.ignore);
  }
}, Effect.mapError(userSettingsError));

const runPrivileged = Effect.fn("ServiceProtection.runPrivileged")(function* (script: string) {
  const step = "change the system's service settings";
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("sudo", ["/bin/sh", "-c", script], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError((cause) => new ServiceProtectionError({ step, detail: String(cause) })));
  if (exitCode !== 0) {
    return yield* new ServiceProtectionError({ step, detail: `sudo exited with ${exitCode}` });
  }
});

export const applyProtection = Effect.fn("ServiceProtection.apply")(function* (
  plan: ProtectionPlan,
) {
  yield* writeDropIns([plan.managerDefaults]);
  yield* runPrivileged(renderPrivilegedScript(plan, "apply"));
  yield* writeDropIns(plan.user);
  yield* reloadUserManager;
});

export const removeProtection = Effect.fn("ServiceProtection.remove")(function* (
  plan: ProtectionPlan,
) {
  yield* removeDropIns(plan.user);
  yield* reloadUserManager;
  if (plan.system.length > 0) yield* runPrivileged(renderPrivilegedScript(plan, "undo"));
  yield* removeDropIns([plan.managerDefaults]);
  yield* reloadUserManager;
});

/** The plan narrowed to drop-ins that exist, for undo. */
export const installedProtection = Effect.fn("ServiceProtection.installed")(function* (
  plan: ProtectionPlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = (dropIn: DropIn) => fs.exists(dropIn.path).pipe(Effect.orElseSucceed(() => false));
  const system = yield* Effect.filter(plan.system, exists);
  const user = yield* Effect.filter(plan.user, exists);
  const managerDefaults = yield* exists(plan.managerDefaults);
  return system.length + user.length === 0 && !managerDefaults
    ? undefined
    : { ...plan, system, user };
});

export interface ServiceProtectionState {
  /** The first cgroup from the top that grants the server no memory protection. */
  readonly unprotected: string | undefined;
  readonly oomScoreAdj: number | undefined;
  readonly setByProtect: boolean;
}

/** Reads what the kernel applies to the running service, whoever configured it. */
export const readProtection = Effect.fn("ServiceProtection.read")(function* (userUnitDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shown = yield* run("read the service's cgroup", "systemctl", [
    "--user",
    "show",
    BOOT_SERVICE_UNIT_FILE,
    "--property=ControlGroup,MainPID",
  ]).pipe(Effect.option);
  if (Option.isNone(shown)) return undefined;
  const values = parseUnits(shown.value)[0] ?? new Map<string, string>();
  const controlGroup = (values.get("ControlGroup") ?? "").split("/").filter(Boolean);
  if (controlGroup.length === 0) return undefined;
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
  let unprotected: string | undefined;
  for (let depth = 1; depth <= controlGroup.length && unprotected === undefined; depth++) {
    const low = yield* read(
      path.join("/sys/fs/cgroup", ...controlGroup.slice(0, depth), "memory.low"),
    );
    if (low === "" || low === "0") unprotected = controlGroup[depth - 1];
  }
  const pid = Number(values.get("MainPID") ?? 0);
  const score = pid > 0 ? yield* read(`/proc/${pid}/oom_score_adj`) : "";
  return {
    unprotected,
    oomScoreAdj: score === "" ? undefined : Number(score),
    setByProtect: yield* fs
      .exists(path.join(userUnitDir, `${BOOT_SERVICE_UNIT_FILE}.d`, PROTECT_DROP_IN))
      .pipe(Effect.orElseSucceed(() => false)),
  } satisfies ServiceProtectionState;
});
