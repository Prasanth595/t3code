import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import { assert, it } from "@effect/vitest";
import {
  ClaudeSessionAdoptInput,
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Projects from "./ProjectStore.ts";
import * as Lifecycle from "./ClaudeSessionLifecycle.ts";
import * as Host from "./ClaudeSessionHost.ts";

const decodeAdoptInput = Schema.decodeUnknownSync(ClaudeSessionAdoptInput);
const request = decodeAdoptInput(requestFixture.input);
const forbidden = () =>
  Effect.die("Handoff inspection must not start a provider or generate text.");
const snapshot = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: request.providerInstanceId,
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "synthetic",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T00:00:00.000Z",
  models: [],
  supportedRuntimeModes: ["approval-required", "full-access"],
});
const instance: ProviderInstance = {
  instanceId: request.providerInstanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: "fixture",
  },
  displayName: undefined,
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed(snapshot),
    refresh: forbidden(),
    streamChanges: Stream.empty,
    resolveMaintenance: forbidden,
    applyUsageLimits: forbidden,
  },
  orchestrationAdapter: {
    instanceId: request.providerInstanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: forbidden,
    planSelectionTransition: forbidden,
    openSession: forbidden,
  },
  textGeneration: {
    generateCommitMessage: forbidden,
    generatePrContent: forbidden,
    generateBranchName: forbidden,
    generateThreadTitle: forbidden,
    generateReviewGuide: forbidden,
  },
};
const setup = Effect.fn("ClaudeHostTest.setup")(function* (
  available = true,
  executableSource = "/bin/true",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "claude-host-owned-" });
  const cwd = path.join(root, "project");
  const config = path.join(root, "config");
  const projectStore = path.join(config, "projects", "saved-project");
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.makeDirectory(projectStore, { recursive: true });
  const executable = path.join(root, "claude-peer");
  yield* fs.copyFile(executableSource, executable);
  yield* fs.chmod(executable, 0o755);
  const transcript = path.join(projectStore, `${request.nativeId}.jsonl`);
  const bytes =
    JSON.stringify({
      type: "user",
      uuid: "10000000-0000-4000-8000-000000000010",
      parentUuid: null,
      sessionId: request.nativeId,
      cwd,
      timestamp: "2026-10-26T00:00:00.000Z",
      message: { role: "user", content: "saved exact prompt" },
    }) + "\n";
  yield* fs.writeFileString(transcript, bytes);
  const provider = {
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    environment: [
      { name: "HOME", value: root, sensitive: false },
      { name: "CLAUDE_CONFIG_DIR", value: config, sensitive: false },
    ],
    config: { binaryPath: executable, idleCompaction: "off" },
  };
  const dependencies = Layer.mergeAll(
    ServerSettings.ServerSettingsService.layerTest({
      providerInstances: { [request.providerInstanceId]: provider },
    }),
    Layer.mock(Registry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(available ? instance : undefined),
    }),
    Layer.mock(Projects.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId: request.projectId,
            title: "fixture",
            workspaceRoot: cwd,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-26T00:00:00.000Z",
            updatedAt: "2026-10-26T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(request.environmentId),
    }),
  );
  return {
    fs,
    path,
    root,
    config,
    cwd,
    executable,
    transcript,
    bytes,
    provider,
    layer: Host.layer.pipe(
      Layer.provide(Host.layerIdentity.pipe(Layer.provide(dependencies))),
      Layer.provideMerge(dependencies),
    ),
  };
});

it.live.each([
  { name: "same executable and store", executable: "selected", config: "selected", blocked: true },
  {
    name: "another Claude executable in the same store",
    executable: "claude",
    config: "selected",
    blocked: true,
  },
  { name: "physical store alias", executable: "selected", config: "alias", blocked: true },
  {
    name: "another native installed version",
    executable: "versioned",
    config: "selected",
    blocked: true,
  },
  { name: "relative config root", executable: "selected", config: "relative", blocked: true },
  { name: "unknown store", executable: "selected", config: "unknown", blocked: true },
  { name: "different store", executable: "selected", config: "other", blocked: false },
  { name: "unrelated executable", executable: "unrelated", config: "selected", blocked: false },
] as const)("checks an existing writer with $name without a UUID argument", (scenario) =>
  Effect.gen(function* () {
    const f = yield* setup(true, "/bin/cat");
    yield* Effect.gen(function* () {
      const host = yield* Lifecycle.ClaudeSessionHost;
      const plan = yield* host.resolve(request);
      const executable =
        scenario.executable === "selected"
          ? f.executable
          : scenario.executable === "claude"
            ? f.path.join(f.root, "claude-other")
            : scenario.executable === "versioned"
              ? f.path.join(f.root, "claude", "versions", "0.0.0")
              : "/bin/cat";
      if (scenario.executable === "claude" || scenario.executable === "versioned") {
        yield* f.fs.makeDirectory(f.path.dirname(executable), { recursive: true });
        yield* f.fs.copyFile("/bin/cat", executable);
        yield* f.fs.chmod(executable, 0o755);
      }
      const other = f.path.join(f.root, "other-config");
      yield* f.fs.makeDirectory(other);
      const alias = f.path.join(f.root, "config-alias");
      yield* f.fs.symlink(f.config, alias);
      const config =
        scenario.config === "selected"
          ? f.config
          : scenario.config === "alias"
            ? alias
            : scenario.config === "relative"
              ? "config"
              : other;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const owned = yield* Effect.acquireRelease(
        spawner.spawn(
          ChildProcess.make(executable, [], {
            cwd: f.root,
            env: scenario.config === "unknown" ? {} : { HOME: f.root, CLAUDE_CONFIG_DIR: config },
            extendEnv: false,
            stdin: "pipe",
            stdout: "ignore",
            stderr: "pipe",
          }),
        ),
        (child) =>
          Effect.gen(function* () {
            yield* Stream.run(Stream.empty, child.stdin);
            assert.equal(Number(yield* child.exitCode), 0);
          }).pipe(Effect.orDie),
      );
      const raw = yield* f.fs.readFileString(`/proc/${process.pid}/stat`);
      const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
      assert.isDefined(start);
      const boot = (yield* f.fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
      const terminal = yield* f.fs.stat(`/proc/${process.pid}/fd/0`);
      const input = decodeAdoptInput({
        ...request,
        sourceStopped: {
          ...request.sourceStopped,
          knownPreviousProcess: null,
          terminal: {
            ...request.sourceStopped.terminal,
            shell: { pid: process.pid, start, boot },
            boot,
            pty: { device: String(terminal.dev), inode: String(Option.getOrThrow(terminal.ino)) },
          },
        },
      });
      const observed = yield* host.validateStopped(input, plan).pipe(Effect.result);
      assert.equal(observed._tag, scenario.blocked ? "Failure" : "Success");
      if (observed._tag === "Failure") {
        assert.equal(
          observed.failure.code,
          scenario.config === "unknown" ? "identity-unavailable" : "source-not-idle",
        );
      }
      assert.isTrue(yield* owned.isRunning);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("resolves exact provider roots and immutable SDK history without starting a query", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* Effect.gen(function* () {
      const host = yield* Lifecycle.ClaudeSessionHost;
      const plan = yield* host.resolve(request);
      assert.equal(plan.home.path, f.root);
      assert.deepEqual(plan.configDir.kind === "set" ? plan.configDir.value : null, f.config);
      assert.equal(plan.cwd.path, f.cwd);
      assert.equal(plan.transcript.path, f.transcript);
      assert.deepEqual(plan.herdrLaunch.args, [
        "--resume",
        request.nativeId,
        "--model",
        request.selection.model,
        "--permission-mode",
        "default",
        "--effort",
        "high",
      ]);
      const history = yield* host.read(plan);
      assert.deepEqual(
        history.messages.map((message) => message.uuid),
        ["10000000-0000-4000-8000-000000000010"],
      );
      assert.equal(yield* f.fs.readFileString(f.transcript), f.bytes);
      yield* host.validatePlan(plan);
      yield* f.fs.writeFileString(
        f.path.join(f.config, "remote-settings.json"),
        JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }),
      );
      assert.equal(
        (yield* host
          .resolve({ ...request, selection: { ...request.selection, runtimeMode: "full-access" } })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: request.providerInstanceId,
        instance: { ...f.provider, config: { ...f.provider.config, launchArgs: "--chrome" } },
      });
      assert.equal((yield* host.validatePlan(plan).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses a configured provider that has no enabled runtime instance", () =>
  Effect.gen(function* () {
    const f = yield* setup(false);
    yield* Effect.gen(function* () {
      const host = yield* Lifecycle.ClaudeSessionHost;
      assert.equal((yield* host.resolve(request).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("honors project provider disable before accepting destination settings", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [request.projectId]: {
            providerInstances: { [request.providerInstanceId]: { enabled: false } },
          },
        },
      });
      const host = yield* Lifecycle.ClaudeSessionHost;
      assert.equal((yield* host.resolve(request).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a foreign-owned executable before issuing a return identity plan", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const uid = yield* HostProcess.UserId;
    const executable = uid === 0 ? f.executable : "/bin/true";
    if (uid === 0) yield* f.fs.chown(executable, 1, 1);
    assert.notEqual(Option.getOrThrow((yield* f.fs.stat(executable)).uid), uid);
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: request.providerInstanceId,
        instance: { ...f.provider, config: { ...f.provider.config, binaryPath: executable } },
      });
      const host = yield* Lifecycle.ClaudeSessionHost;
      assert.equal((yield* host.resolve(request).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects aliases, foreign scope, unsupported overrides and replaced physical roots", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* Effect.gen(function* () {
      const host = yield* Lifecycle.ClaudeSessionHost;
      assert.equal(
        (yield* host
          .resolve({ ...request, environmentId: EnvironmentId.make("foreign") })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* host
          .resolve({ ...request, selection: { ...request.selection, model: "sonnet" } })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const plan = yield* host.resolve(request);
      yield* f.fs.rename(f.config, f.config + "-old");
      yield* f.fs.symlink(f.config + "-old", f.config);
      assert.equal((yield* host.validatePlan(plan).pipe(Effect.result))._tag, "Failure");
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: request.providerInstanceId,
        instance: {
          ...f.provider,
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "synthetic-not-a-secret", sensitive: true },
          ],
        },
      });
      assert.equal((yield* host.resolve(request).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(f.layer), Effect.provideService(HostProcess.Platform, "linux"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
