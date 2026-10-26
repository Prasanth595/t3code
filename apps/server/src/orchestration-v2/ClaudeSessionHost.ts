// @effect-diagnostics nodeBuiltinImport:off -- canonical filesystem and Linux generation identities are checked without starting Claude.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  ClaudeSettings,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type ClaudeSessionAdoptInput,
  type ClaudeSessionIdentityPlan,
  type ClaudeSessionFileIdentity,
  type ClaudeSessionProcess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Settings from "../serverSettings.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  ClaudeSnapshot,
  ClaudeSnapshotError,
  captureClaudeSessionSnapshot,
} from "../claudeSessionSnapshot.ts";
import {
  claudeRuntimeQueryPolicyForRuntimePolicy,
  makeClaudeQueryOptions,
} from "./Adapters/ClaudeAdapterV2.ts";
import * as Projects from "./ProjectStore.ts";
import { ClaudeSessionHost } from "./ClaudeSessionLifecycle.ts";
import { ClaudeJournalError, claudePayloadHash } from "./ClaudeSessionJournal.ts";

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(ClaudeJournalError)(cause)
        ? cause
        : new ClaudeJournalError({
            code: Schema.is(ClaudeSnapshotError)(cause) ? cause.code : "identity-unavailable",
            cause,
          }),
    ),
  );
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) =>
      Schema.is(ClaudeJournalError)(cause)
        ? cause
        : new ClaudeJournalError({
            code: Schema.is(ClaudeSnapshotError)(cause) ? cause.code : "identity-unavailable",
            cause,
          }),
  });
const encodeWorkerOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const claudeFileIdentity = async (
  path: string,
  directory: boolean,
): Promise<ClaudeSessionFileIdentity> => {
  const canonical = await NodeFSP.realpath(path);
  const stat = await NodeFSP.lstat(canonical, { bigint: true });
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== BigInt(process.getuid?.() ?? -1)
  )
    throw new ClaudeJournalError({ code: "identity-unavailable" });
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino) };
};
const readExecutable = async (path: string) => {
  const file = await claudeFileIdentity(path, false);
  const descriptor = await NodeFSP.open(
    file.path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o111n) === 0n ||
      before.size > 536_870_912n ||
      String(before.dev) !== file.device ||
      String(before.ino) !== file.inode
    )
      throw new ClaudeJournalError({ code: "unsupported-profile" });
    const magic = Buffer.alloc(4);
    await descriptor.read(magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      throw new ClaudeJournalError({ code: "unsupported-profile" });
    const hash = NodeCrypto.createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (true) {
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > 536_870_912) throw new ClaudeJournalError({ code: "identity-changed" });
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await descriptor.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      claudePayloadHash(await claudeFileIdentity(file.path, false)) !== claudePayloadHash(file)
    )
      throw new ClaudeJournalError({ code: "identity-changed" });
    return { file, sha256: hash.digest("hex") };
  } finally {
    await descriptor.close();
  }
};
const claudeProcessIdentity = async (pid: number): Promise<ClaudeSessionProcess | null> => {
  const boot = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  let raw;
  try {
    raw = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const start = fields[19];
  if (start === undefined || !/^\d+$/.test(start))
    throw new ClaudeJournalError({ code: "runtime-state-unknown" });
  return { pid, start, boot };
};

export class ClaudeSessionIdentity extends Context.Service<
  ClaudeSessionIdentity,
  ClaudeSessionHost["Service"]
>()("t3/orchestration-v2/ClaudeSessionHost/ClaudeSessionIdentity") {}

export const layerIdentity = Layer.effect(
  ClaudeSessionIdentity,
  Effect.gen(function* () {
    const settingsService = yield* Settings.ServerSettingsService;
    const projects = yield* Projects.ProjectStoreV2;
    const environmentId = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
    const environment = yield* HostProcess.Environment;
    const hostHome = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const resolver = yield* SpawnExecutableResolution;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = yield* HostProcess.ExecutablePath;
    const packaged = yield* HostProcess.IsExecutable;
    const runWorker = Effect.fn("ClaudeSessionHost.runWorker")(function* (
      method: "captureSession" | "resolveHandoffPolicy",
      nativeId: string,
      cwd: string,
      projectsRoot: string,
      home: string,
      configDir: string | undefined,
    ) {
      const fromSource = import.meta.url.endsWith(".ts");
      const worker = packaged
        ? ["__claude-history"]
        : [
            ...(fromSource ? ["--experimental-strip-types"] : []),
            yield* path.fromFileUrl(
              new URL(
                fromSource ? "../claude-history-worker.ts" : "./claude-history-worker.mjs",
                import.meta.url,
              ),
            ),
          ];
      const result = yield* spawnAndCollect(
        executable,
        ChildProcess.make(
          executable,
          [...worker, method, nativeId, encodeWorkerOptions({ dir: cwd, projectsRoot })],
          {
            env: {
              ...environment,
              HOME: home,
              CLAUDE_CONFIG_DIR: configDir,
              ELECTRON_RUN_AS_NODE: "1",
            },
          },
        ),
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      if (result.code !== 0)
        return yield* new ClaudeJournalError({
          code: method === "captureSession" ? "history-incomplete" : "unsupported-profile",
        });
      return result.stdout;
    }, failure);
    const read = Effect.fn("ClaudeSessionHost.read")(function* (plan: ClaudeSessionIdentityPlan) {
      const result = yield* runWorker(
        "captureSession",
        plan.nativeId,
        plan.cwd.path,
        plan.projectsRoot.path,
        plan.home.path,
        plan.configDir.kind === "set" ? plan.configDir.value : undefined,
      );
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSnapshot))(result);
    }, failure);
    const resolve = Effect.fn("ClaudeSessionHost.resolve")(function* (
      input: Pick<
        ClaudeSessionAdoptInput,
        "environmentId" | "projectId" | "threadId" | "providerInstanceId" | "nativeId" | "selection"
      >,
    ) {
      if (platform !== "linux")
        return yield* new ClaudeJournalError({ code: "unsupported-platform" });
      if (input.environmentId !== environmentId)
        return yield* new ClaudeJournalError({ code: "scope-mismatch" });
      const settings = yield* settingsService.getSettings;
      const instance = settings.providerInstances[input.providerInstanceId];
      if (
        instance === undefined ||
        instance.driver !== "claudeAgent" ||
        instance.enabled === false ||
        !resolveProjectProviderInstanceEnabled(settings, input.projectId, input.providerInstanceId)
      )
        return yield* new ClaudeJournalError({ code: "provider-unavailable" });
      const config = yield* Schema.decodeUnknownEffect(ClaudeSettings)(instance.config);
      if (!config.enabled) return yield* new ClaudeJournalError({ code: "provider-unavailable" });
      if (
        config.launchArgs.trim() !== "" ||
        config.autoCompactWindow !== "" ||
        resolveIdleCompaction(settings, input.providerInstanceId) !== "off" ||
        instance.environment?.some(
          (entry) => entry.name !== "HOME" && entry.name !== "CLAUDE_CONFIG_DIR",
        )
      )
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      const project = yield* projects.get(input.projectId);
      if (Option.isNone(project)) return yield* new ClaudeJournalError({ code: "scope-mismatch" });
      const base = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
      const env = yield* makeClaudeEnvironment(config, base).pipe(
        Effect.provideService(Path.Path, path),
      );
      const homePath = env.HOME ?? hostHome;
      if (
        !NodePath.isAbsolute(homePath) ||
        (env.CLAUDE_CONFIG_DIR !== undefined && !NodePath.isAbsolute(env.CLAUDE_CONFIG_DIR))
      )
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, config.customModels);
      const entry = catalog.models.find((entry) => entry.model.slug === input.selection.model);
      if (entry === undefined)
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      const selection = {
        instanceId: input.providerInstanceId,
        model: input.selection.model,
        ...(input.selection.effort === undefined
          ? {}
          : { options: [{ id: "effort", value: input.selection.effort }] }),
      };
      const compiled = compileClaudeModelSelection(selection, catalog);
      if (
        compiled.apiModelId !== input.selection.model ||
        compiled.promptEffort !== undefined ||
        (input.selection.effort !== undefined && compiled.effort !== input.selection.effort) ||
        Object.values(compiled.settings).some(Boolean)
      )
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      const resolvedBinary = resolver(expandHomePath(config.binaryPath, hostHome), platform, env);
      if (resolvedBinary === undefined)
        return yield* new ClaudeJournalError({ code: "identity-unavailable" });
      const home = yield* io(() => claudeFileIdentity(homePath, true));
      const root = yield* io(() =>
        claudeFileIdentity(env.CLAUDE_CONFIG_DIR ?? NodePath.join(home.path, ".claude"), true),
      );
      const cwd = yield* io(() => claudeFileIdentity(project.value.workspaceRoot, true));
      const executableIdentity = yield* io(() => readExecutable(resolvedBinary));
      const binary = executableIdentity.file;
      const policy = claudeRuntimeQueryPolicyForRuntimePolicy({
        runtimeMode: input.selection.runtimeMode,
        interactionMode: "default",
        cwd: cwd.path,
      });
      const options = makeClaudeQueryOptions({
        modelSelection: selection,
        nativeThreadId: input.nativeId,
        resume: true,
        cwd: cwd.path,
        settings: { ...config, binaryPath: binary.path },
        environment: env,
        permissionMode: policy.permissionMode,
      });
      const permission =
        input.selection.runtimeMode === "full-access" ? "bypassPermissions" : "default";
      const policyResult = yield* runWorker(
        "resolveHandoffPolicy",
        input.nativeId,
        cwd.path,
        NodePath.join(root.path, "projects"),
        home.path,
        env.CLAUDE_CONFIG_DIR,
      );
      const managedPolicy = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ bypassDisabled: Schema.Boolean })),
      )(policyResult);
      if (permission === "bypassPermissions" && managedPolicy.bypassDisabled)
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      if (
        options.permissionMode !== permission ||
        options.model !== input.selection.model ||
        (input.selection.effort !== undefined && options.effort !== input.selection.effort)
      )
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      const snapshot = yield* io(() =>
        captureClaudeSessionSnapshot({
          nativeId: input.nativeId,
          cwd: cwd.path,
          projectsRoot: NodePath.join(root.path, "projects"),
        }),
      );
      const args = [
        "--resume",
        input.nativeId,
        "--model",
        input.selection.model,
        "--permission-mode",
        permission,
        ...(input.selection.effort === undefined ? [] : ["--effort", input.selection.effort]),
      ];
      const plan: Omit<ClaudeSessionIdentityPlan, "planDigest"> = {
        planVersion: 1,
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        nativeId: input.nativeId,
        home,
        configDir:
          env.CLAUDE_CONFIG_DIR === undefined
            ? { kind: "unset" as const, effectiveRoot: root }
            : { kind: "set" as const, value: env.CLAUDE_CONFIG_DIR, effectiveRoot: root },
        projectsRoot: snapshot.projectsRoot,
        transcript: snapshot.transcript,
        cwd,
        executable: executableIdentity,
        selection: input.selection,
        sdkPermissionMode: permission,
        configurationDigest: claudePayloadHash({
          profileVersion: 1,
          config,
          environment: instance.environment ?? [],
          cwd: cwd.path,
          selection: input.selection,
          managedPolicy,
          idleCompaction: resolveIdleCompaction(settings, input.providerInstanceId),
        }),
        herdrLaunch: {
          executable: binary.path,
          args,
          cwd: cwd.path,
          environment: { HOME: home.path, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null },
        },
      };
      return { ...plan, planDigest: claudePayloadHash(plan) };
    }, failure);
    const validatePlan = Effect.fn("ClaudeSessionHost.validatePlan")(function* (
      plan: ClaudeSessionIdentityPlan,
    ) {
      const current = yield* resolve({
        environmentId: plan.environmentId,
        projectId: plan.projectId,
        threadId: plan.threadId,
        providerInstanceId: plan.providerInstanceId,
        nativeId: plan.nativeId,
        selection: plan.selection,
      }).pipe(
        Effect.catch(() => Effect.fail(new ClaudeJournalError({ code: "settings-changed" }))),
      );
      if (current.configurationDigest !== plan.configurationDigest)
        return yield* new ClaudeJournalError({ code: "settings-changed" });
      if (current.planDigest !== plan.planDigest)
        return yield* new ClaudeJournalError({ code: "identity-changed" });
    });
    const validateStopped = Effect.fn("ClaudeSessionHost.validateStopped")(function* (
      input: ClaudeSessionAdoptInput,
      plan: ClaudeSessionIdentityPlan,
    ) {
      const terminal = input.sourceStopped.terminal;
      const shell = yield* io(() => claudeProcessIdentity(terminal.shell.pid));
      if (
        shell === null ||
        claudePayloadHash(shell) !== claudePayloadHash(terminal.shell) ||
        shell.boot !== terminal.boot
      )
        return yield* new ClaudeJournalError({ code: "terminal-changed" });
      const previous = input.sourceStopped.knownPreviousProcess;
      if (previous !== null) {
        const live = yield* io(() => claudeProcessIdentity(previous.pid));
        if (live !== null && claudePayloadHash(live) === claudePayloadHash(previous))
          return yield* new ClaudeJournalError({ code: "source-not-idle" });
        if (previous.boot !== shell.boot)
          return yield* new ClaudeJournalError({ code: "source-not-idle" });
      }
      const shellStat = yield* io(() => NodeFSP.stat(`/proc/${shell.pid}/fd/0`, { bigint: true }));
      if (
        String(shellStat.dev) !== terminal.pty.device ||
        String(shellStat.ino) !== terminal.pty.inode
      )
        return yield* new ClaudeJournalError({ code: "terminal-changed" });
      const processes = yield* io(() => NodeFSP.readdir("/proc"));
      for (const pid of processes.filter((value) => /^\d+$/.test(value))) {
        const competing = yield* io(async () => {
          try {
            const owner = await NodeFSP.stat(`/proc/${pid}`);
            if (owner.uid !== process.getuid?.()) return false;
            const before = await claudeProcessIdentity(Number(pid));
            if (before === null) return false;
            const command = (await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
            if (command[0] === "") return false;
            const selectedUuid = command.some(
              (arg) => arg === plan.nativeId || arg === `--resume=${plan.nativeId}`,
            );
            const claudeName = (path: string) =>
              /^claude(?:[-_.].*)?$/.test(NodePath.basename(path)) ||
              /(?:^|\/)claude\/versions\//.test(path) ||
              /(?:^|\/)@anthropic-ai\/claude-code\//.test(path);
            let executable;
            let executablePath;
            try {
              executable = await NodeFSP.stat(`/proc/${pid}/exe`, { bigint: true });
              executablePath = await NodeFSP.readlink(`/proc/${pid}/exe`);
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                (error.code === "EACCES" || error.code === "EPERM")
              ) {
                const name = (await NodeFSP.readFile(`/proc/${pid}/comm`, "utf8")).trim();
                const selectedName = NodePath.basename(plan.executable.file.path).slice(0, 15);
                if (
                  !selectedUuid &&
                  !claudeName(command[0] ?? "") &&
                  !claudeName(name) &&
                  name !== selectedName
                )
                  return false;
              }
              throw error;
            }
            const selectedExecutable =
              String(executable.dev) === plan.executable.file.device &&
              String(executable.ino) === plan.executable.file.inode;
            const namedClaude = [executablePath, command[0] ?? ""].some(claudeName);
            if (!selectedExecutable && !namedClaude && !selectedUuid) return false;
            const environment = new Map<string, string>();
            for (const entry of (await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8")).split(
              "\0",
            )) {
              const equals = entry.indexOf("=");
              const name = entry.slice(0, equals);
              if (name !== "HOME" && name !== "CLAUDE_CONFIG_DIR") continue;
              if (environment.has(name))
                throw new ClaudeJournalError({ code: "identity-unavailable" });
              environment.set(name, entry.slice(equals + 1));
            }
            const configured = environment.get("CLAUDE_CONFIG_DIR");
            const home = environment.get("HOME");
            if (configured === "" || (configured === undefined && !home))
              throw new ClaudeJournalError({ code: "identity-unavailable" });
            const root = configured ?? NodePath.join(home ?? "", ".claude");
            const path = NodePath.isAbsolute(root)
              ? root
              : NodePath.resolve(await NodeFSP.readlink(`/proc/${pid}/cwd`), root);
            const store = await NodeFSP.stat(path, { bigint: true });
            const after = await claudeProcessIdentity(Number(pid));
            if (after === null) return false;
            if (claudePayloadHash(before) !== claudePayloadHash(after))
              throw new ClaudeJournalError({ code: "identity-unavailable" });
            return (
              String(store.dev) === plan.configDir.effectiveRoot.device &&
              String(store.ino) === plan.configDir.effectiveRoot.inode
            );
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ESRCH") &&
              (await claudeProcessIdentity(Number(pid))) === null
            )
              return false;
            throw error;
          }
        });
        if (competing) return yield* new ClaudeJournalError({ code: "source-not-idle" });
      }
    }, failure);
    return ClaudeSessionIdentity.of({ resolve, read, validatePlan, validateStopped });
  }),
);

export const layer = Layer.effect(
  ClaudeSessionHost,
  Effect.gen(function* () {
    const identity = yield* ClaudeSessionIdentity;
    const registry = yield* Registry.ProviderInstanceRegistry;
    const resolve = Effect.fn("ClaudeSessionHost.resolveAvailable")(function* (
      input: ClaudeSessionAdoptInput,
    ) {
      const live = yield* registry.getInstance(input.providerInstanceId);
      if (live === undefined || !live.enabled || live.driverKind !== "claudeAgent")
        return yield* new ClaudeJournalError({ code: "provider-unavailable" });
      const provider = yield* live.snapshot.getSnapshot;
      if (
        provider.supportedRuntimeModes !== undefined &&
        !provider.supportedRuntimeModes.includes(input.selection.runtimeMode)
      )
        return yield* new ClaudeJournalError({ code: "unsupported-profile" });
      return yield* identity.resolve(input);
    });
    return ClaudeSessionHost.of({ ...identity, resolve });
  }),
);
