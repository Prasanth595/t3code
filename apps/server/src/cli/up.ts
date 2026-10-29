import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import {
  isTailscaleIpv4Address,
  readTailscaleStatus,
  readTailscaleWhois,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import { SERVICE_ENV_FILE } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import {
  isSupportedTailscaleVersion,
  MINIMUM_TAILSCALE_VERSION,
} from "../tailscale/TailscaleHost.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

export class TailscaleUpError extends Schema.TaggedError<TailscaleUpError>()("TailscaleUpError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const SERVICE_ENV_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;

/**
 * Sets or removes (`undefined`) entries in a `service.env` file and keeps
 * every other line, including comments, as the user wrote it.
 */
export const upsertServiceEnv = (
  contents: string,
  entries: Readonly<Record<string, string | undefined>>,
): string => {
  const written = new Set<string>();
  const lines = contents.split("\n").flatMap((line) => {
    const key = SERVICE_ENV_KEY.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(entries, key)) return [line];
    const value = entries[key];
    if (value === undefined || written.has(key)) return [];
    written.add(key);
    return [`${key}=${value}`];
  });
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && !written.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
};

interface Owner {
  readonly userId: string;
  readonly login: string | null;
}

const loginOf = (status: TailscaleStatus, userId: string | null) =>
  status.users.find((user) => user.userId === userId)?.loginName ?? null;

const ownerForLogin = (status: TailscaleStatus, login: string) => {
  const wanted = login.trim().toLowerCase();
  const user = status.users.find((candidate) => candidate.loginName?.toLowerCase() === wanted);
  return user === undefined
    ? Effect.fail(
        new TailscaleUpError({
          reason: `No Tailscale user with the login ${login.trim()} is visible from this host. Check the spelling, or sign in to Tailscale on one of that user's devices first.`,
        }),
      )
    : Effect.succeed({ userId: user.userId, login: user.loginName } satisfies Owner);
};

/** The SSH client's user, when it connects over the tailnet from one of its own devices. */
const proposeSshOwner = Effect.fn("cli.up.proposeSshOwner")(function* () {
  const env = yield* HostProcess.Environment;
  const clientAddress = env.SSH_CONNECTION?.trim().split(/\s+/u)[0];
  if (clientAddress === undefined || !isTailscaleIpv4Address(clientAddress)) {
    return Option.none<Owner>();
  }
  const node = yield* readTailscaleWhois(clientAddress).pipe(Effect.option);
  return Option.filter(
    node,
    (value) => value.tags.length === 0 && value.sharerUserId === null,
  ).pipe(Option.map((value): Owner => ({ userId: value.userId, login: value.loginName })));
});

const resolveOwner = Effect.fn("cli.up.resolveOwner")(function* (
  status: TailscaleStatus,
  ownerLogin: Option.Option<string>,
) {
  if (status.selfTags.length === 0) {
    if (status.selfUserId === null) {
      return yield* new TailscaleUpError({ reason: "Tailscale did not report this host's user." });
    }
    const own: Owner = { userId: status.selfUserId, login: loginOf(status, status.selfUserId) };
    if (Option.isSome(ownerLogin)) {
      const requested = yield* ownerForLogin(status, ownerLogin.value);
      if (requested.userId !== own.userId) {
        return yield* new TailscaleUpError({
          reason: `This host is not tagged, so its owner is its own Tailscale user (${own.login ?? own.userId}). Drop --owner, or tag the host first.`,
        });
      }
    }
    return own;
  }
  if (Option.isSome(ownerLogin)) return yield* ownerForLogin(status, ownerLogin.value);
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return yield* new TailscaleUpError({
      reason: "This host is tagged, so it has no Tailscale user. Pass --owner <login>.",
    });
  }
  const proposed = yield* proposeSshOwner();
  if (Option.isSome(proposed)) {
    const accepted = yield* Prompt.run(
      Prompt.Confirm({
        message: `This host is tagged. Make ${proposed.value.login ?? proposed.value.userId}, the user you connect from, its owner?`,
        initial: true,
      }),
    );
    if (accepted) return proposed.value;
  }
  const login = yield* Prompt.run(
    Prompt.String({ message: "This host is tagged. Tailscale login of its owner:" }),
  );
  return yield* ownerForLogin(status, login);
});

const checkTailscale = Effect.fn("cli.up.checkTailscale")(function* () {
  const status = yield* readTailscaleStatus("active").pipe(
    Effect.mapError(
      (cause) =>
        new TailscaleUpError({
          reason:
            "Tailscale did not answer. Install it and run `sudo tailscale up`, then run `t3 up` again.",
          cause,
        }),
    ),
  );
  if (status.backendState !== "Running") {
    return yield* new TailscaleUpError({
      reason: `Tailscale is ${status.backendState ?? "not running"}. Run \`sudo tailscale up\`, then run \`t3 up\` again.`,
    });
  }
  if (status.userspaceNetworking === true) {
    return yield* new TailscaleUpError({
      reason:
        "Tailscale uses userspace networking here, which is common in LXC and other containers. Tailnet connections then reach T3 Code from 127.0.0.1, so it cannot tell which device connects and Tailscale sign-in cannot work. Give the container /dev/net/tun and run tailscaled without --tun=userspace-networking.",
    });
  }
  if (!isSupportedTailscaleVersion(status.version)) {
    return yield* new TailscaleUpError({
      reason: `Tailscale ${status.version ?? "(unknown version)"} is too old for Tailscale sign-in. Update to ${MINIMUM_TAILSCALE_VERSION} or newer.`,
    });
  }
  const address = status.tailnetIpv4Addresses[0];
  if (address === undefined) {
    return yield* new TailscaleUpError({
      reason: "Tailscale reported no IPv4 address for this host.",
    });
  }
  return { status, address };
});

const TAGGING_TIP = [
  "Tip: this box is not tagged. If agents run here, tag it so they",
  "cannot sign in to your other machines. Add to your ACL:",
  '  "tagOwners": { "tag:server": ["autogroup:admin"] }',
  "then run: sudo tailscale set --advertise-tags=tag:server",
].join("\n");

/**
 * Discovery probes only the default port, so `t3 up` pins it rather than let
 * the server fall back to the next free one. A port the user set is kept.
 */
export const upPortCheck = (input: {
  readonly configuredPort: string | undefined;
  /** Whether the port the service will use, configured or default, is free. */
  readonly portFree: boolean;
  /** The live server this T3 home already runs, if any. */
  readonly running: { readonly port: number; readonly serviceManaged: boolean } | null;
}): "ok" | "taken" | "custom" | "manual" => {
  // The service cannot take this home over from a server started by hand.
  if (input.running !== null && !input.running.serviceManaged) return "manual";
  const port =
    input.configuredPort === undefined ? ServerConfig.DEFAULT_PORT : Number(input.configuredPort);
  if (!input.portFree && input.running?.port !== port) return "taken";
  return port === ServerConfig.DEFAULT_PORT ? "ok" : "custom";
};

const runUp = Effect.fn("cli.up")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly owner: Option.Option<string>;
  readonly https: boolean;
}) {
  // The service runs under `systemctl --user`, so root would set up a separate root install.
  if ((yield* HostProcess.UserId) === 0) {
    const env = yield* HostProcess.Environment;
    return yield* new TailscaleUpError({
      reason: `Run t3 up as the user who should own T3 Code, not as root:\n  sudo -iu ${env.SUDO_USER ?? "<user>"} npx t3 up`,
    });
  }
  const { status, address } = yield* checkTailscale();
  const owner = yield* resolveOwner(status, flags.owner);
  const tagged = status.selfTags.length > 0;
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serviceEnvPath = path.join(config.baseDir, SERVICE_ENV_FILE);
    const current = (yield* fs.exists(serviceEnvPath))
      ? yield* fs.readFileString(serviceEnvPath)
      : "";
    // The same parser the service launcher reads the file with.
    const serviceEnv = NodeUtil.parseEnv(current);
    const configuredPort = serviceEnv.T3CODE_PORT;
    const net = yield* NetService.NetService;
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    const running = Option.filter(runtime, (state) => isProcessAlive(state.pid));
    const port = Number(configuredPort ?? ServerConfig.DEFAULT_PORT);
    const portCheck = upPortCheck({
      configuredPort,
      portFree: yield* net.canListenOnHost(port, "0.0.0.0"),
      running: Option.match(running, {
        onNone: () => null,
        onSome: (state) => ({ port: state.port, serviceManaged: state.serviceManaged === true }),
      }),
    });
    if (portCheck === "manual") {
      return yield* new TailscaleUpError({
        reason: `A T3 Code server you started by hand is running for ${config.baseDir}. Stop it, then run t3 up again.`,
      });
    }
    if (portCheck === "taken") {
      return yield* new TailscaleUpError({
        reason: `Port ${port} is in use by another program. Free it, or set another T3CODE_PORT in ${serviceEnvPath} and add this box by name and port.`,
      });
    }
    if (portCheck === "custom") {
      yield* Console.warn(
        `${serviceEnvPath} sets T3CODE_PORT=${configuredPort}. Other devices find boxes only on port ${ServerConfig.DEFAULT_PORT}, so add this one by name and port.`,
      );
    }
    // Settings land before the service starts, so it never runs with sign-in half set up.
    yield* fs.makeDirectory(config.baseDir, { recursive: true });
    yield* fs.writeFileString(
      serviceEnvPath,
      upsertServiceEnv(current, {
        T3CODE_TAILSCALE_SIGN_IN: "1",
        T3CODE_TAILSCALE_ONLY: "1",
        T3CODE_PORT: configuredPort ?? String(ServerConfig.DEFAULT_PORT),
        // The user ID, never the login: logins can be renamed.
        T3CODE_TAILSCALE_OWNER: tagged ? owner.userId : undefined,
        ...(flags.https ? { T3CODE_TAILSCALE_SERVE: "1" } : {}),
      }),
    );
    const host = serviceEnv.T3CODE_HOST;
    if (host !== undefined && host !== "0.0.0.0") {
      yield* Console.warn(
        `${serviceEnvPath} sets T3CODE_HOST=${host}, so other tailnet devices may not reach this box.`,
      );
    }

    const service = yield* BootService.BootService;
    const result = yield* CliService.reconcileService();
    // An installed service reads service.env only when it starts.
    if (!result.changed) yield* service.restart;

    const directUrl = `http://${address}:${port}`;
    yield* Console.log(
      [
        "",
        `  Tailscale  signed in (${status.magicDnsName ?? address})`,
        `  Owner      ${owner.login ?? owner.userId}${tagged ? "" : " (the owner of this box)"}`,
        "  Network    Tailscale only, LAN closed",
        "  Sign-in    on for your own Tailscale devices",
        `  Service    installed, starts on boot`,
        ...(flags.https ? ["  HTTPS      Tailscale Serve starts with the service"] : []),
        "",
        `  Scan to add this box on your phone (${directUrl}):`,
        renderTerminalQrCode(directUrl),
        "  Your other devices find it on their own.",
        ...(tagged ? [] : ["", TAGGING_TIP]),
        "",
      ].join("\n"),
    );
  }).pipe(Effect.provide(CliService.layer(config)));
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  owner: Flag.String("owner").pipe(
    Flag.withDescription(
      "Tailscale login that owns this host when it is tagged, for scripts. Stored as the user ID.",
    ),
    Flag.optional,
  ),
  https: Flag.Boolean("https").pipe(
    Flag.withDescription("Also serve this host over HTTPS with Tailscale Serve."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Set up this host for your Tailscale devices: Tailscale sign-in, Tailscale-only network, and the background service.",
  ),
  Command.withHandler(runUp),
);
