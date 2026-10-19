import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";
import * as NodeNet from "node:net";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { explicitBareRepositoryEnv } from "../vcs/VcsProcess.ts";

// These documented SSH-over-443 endpoints share their public forge's identity.
const SSH_ENDPOINT_HOSTS = new Map([
  ["ssh.github.com", "github.com"],
  ["altssh.gitlab.com", "gitlab.com"],
  ["altssh.bitbucket.org", "bitbucket.org"],
]);
const PUBLIC_SSH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
  ...SSH_ENDPOINT_HOSTS.keys(),
]);
// Remote names can reach shell-expanded %h/%r tokens in local Match exec rules.
const SSH_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const isSshName = (name: string | undefined) => name !== undefined && SSH_NAME_PATTERN.test(name);

interface SshRemote {
  readonly user: string | undefined;
  readonly host: string;
  readonly port: string | undefined;
  readonly path: string;
}

function parseSshRemote(remoteUrl: string): SshRemote | null {
  const trimmed = remoteUrl.trim();
  let remote: SshRemote | null = null;
  if (/^(?:ssh|git\+ssh|ssh\+git):\/\//i.test(trimmed)) {
    const url = URL.parse(trimmed.replace(/^[^:]+:/, "ssh:"));
    if (url && url.pathname.length > 1) {
      remote = {
        user: url.username || undefined,
        host: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
      };
    }
  } else if (!trimmed.includes("://")) {
    const [, user, host = "", path] = /^(?:([^@/\s]+)@)?([^:/\s@]+):(\S+)$/.exec(trimmed) ?? [];
    // A userless one-letter host is a Windows drive path.
    if (path && (user || host.length > 1)) remote = { user, host, port: undefined, path };
  }
  return remote && isSshName(remote.host) && (remote.user === undefined || isSshName(remote.user))
    ? remote
    : null;
}

function parseSshConfig(stdout: string): ReadonlyMap<string, string> {
  return new Map(
    stdout.split("\n").flatMap((line) => {
      const [key = "", ...value] = line.trim().split(/\s+/);
      return value.length > 0 ? [[key.toLowerCase(), value.join(" ")] as const] : [];
    }),
  );
}

const readSshConfig = Effect.fn("sshHostAlias.readSshConfig")(function* (
  remote: SshRemote,
  cwd: string,
) {
  const environment = yield* HostProcess.Environment;
  if (environment.GIT_SSH_COMMAND || environment.GIT_SSH || environment.GIT_SSH_VARIANT) return "";
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const customTransport = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cwd, "config", "--get-regexp", "^(core\\.sshcommand|ssh\\.variant)$"],
      env: explicitBareRepositoryEnv(environment, yield* HostProcess.Platform),
      timeout: Duration.seconds(5),
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  // Arbitrary Git SSH commands may use another executable or configuration.
  if (customTransport._tag === "None" || customTransport.value.code !== 1) return "";
  const result = yield* processRunner
    .run({
      command: "ssh",
      args: [
        "-G",
        ...(remote.user ? ["-l", remote.user] : []),
        ...(remote.port ? ["-p", remote.port] : []),
        remote.host,
      ],
      timeout: Duration.seconds(5),
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  return result._tag === "Some" && result.value.code === 0 ? result.value.stdout : "";
});

export const expandSshHostAlias = Effect.fn("sshHostAlias.expandSshHostAlias")(function* (
  remoteUrl: string,
  cwd: string,
) {
  const remote = parseSshRemote(remoteUrl);
  if (!remote) return remoteUrl;

  const alias = remote.host.toLowerCase();
  const config = parseSshConfig(
    PUBLIC_SSH_HOSTS.has(alias) ? "" : yield* readSshConfig(remote, cwd),
  );
  const hostName = (config.get("hostname") ?? alias).toLowerCase().replace(/\.$/, "");
  if (hostName.includes(":")) return remoteUrl;
  const resolvedHost = SSH_ENDPOINT_HOSTS.get(hostName) ?? hostName;
  const provider = detectSourceControlProviderFromGitRemoteUrl(`git@${resolvedHost}:`);
  const isForge = provider !== null && provider.kind !== "unknown";
  const aliasProvider = detectSourceControlProviderFromGitRemoteUrl(`git@${alias}:`);
  const aliasIsForge = aliasProvider !== null && aliasProvider.kind !== "unknown";
  const port = config.get("port") ?? remote.port;
  const configUser = config.get("user");
  const login = remote.user ?? configUser;
  const user = remote.user ?? (isSshName(configUser) ? configUser : undefined);
  const personalPath =
    !isForge &&
    login !== undefined &&
    login !== "git" &&
    (!remote.path.startsWith("/") || remote.path.startsWith("/~"));
  const viaProxy = ["proxyjump", "proxycommand"].some(
    (key) => (config.get(key) ?? "none") !== "none",
  );
  // Ambiguous endpoints and filesystem paths keep their literal identity.
  // Known forges retain their existing SSH/HTTPS identity.
  const host =
    NodeNet.isIP(hostName) !== 0 ||
    isLocalLoopbackHost(hostName) ||
    (aliasIsForge && !isForge) ||
    (!isForge && remote.path.startsWith("/")) ||
    (!isForge && ((port !== undefined && port !== "22") || viaProxy)) ||
    personalPath
      ? alias
      : resolvedHost;
  // A non-git login can serve either a home directory or a self-hosted forge.
  // Preserve the alias rather than inventing a repository path for either.
  if (host === alias) return remoteUrl;
  const path = remote.path;
  return path.startsWith("/")
    ? `ssh://${user ?? "git"}@${host}${path}`
    : `${user ?? "git"}@${host}:${path}`;
});
