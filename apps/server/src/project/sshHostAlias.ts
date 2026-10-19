import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

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

const readSshConfig = Effect.fn("sshHostAlias.readSshConfig")(function* (remote: SshRemote) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
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

function homeQualifiedPath(path: string, user: string | undefined): string {
  if (!user || user === "git") return path;
  const inOwnHome = path.replace(/^\/?~\//, "");
  if (inOwnHome === path && /^[/~]/.test(path)) return path;
  return `~${user}/${inOwnHome}`;
}

export const expandSshHostAlias = Effect.fn("sshHostAlias.expandSshHostAlias")(function* (
  remoteUrl: string,
) {
  const remote = parseSshRemote(remoteUrl);
  if (!remote) return remoteUrl;

  const alias = remote.host.toLowerCase();
  const config = parseSshConfig(PUBLIC_SSH_HOSTS.has(alias) ? "" : yield* readSshConfig(remote));
  const hostName = (config.get("hostname") ?? alias).toLowerCase().replace(/\.$/, "");
  if (hostName.includes(":")) return remoteUrl;
  const resolvedHost = SSH_ENDPOINT_HOSTS.get(hostName) ?? hostName;
  const provider = detectSourceControlProviderFromGitRemoteUrl(`git@${resolvedHost}:`);
  const isForge = provider !== null && provider.kind !== "unknown";
  const port = config.get("port") ?? remote.port;
  // Known forges keep their existing SSH/HTTPS identity. Other non-default
  // ports may serve distinct repositories, so their aliases stay distinct.
  const host =
    isLocalLoopbackHost(hostName) || (!isForge && port !== undefined && port !== "22")
      ? alias
      : resolvedHost;
  const configUser = config.get("user");
  const user = remote.user ?? (isSshName(configUser) ? configUser : undefined);
  // Relative paths on plain servers belong to the effective login's home;
  // forges and the shared git login interpret them as repository names.
  const path = isForge ? remote.path : homeQualifiedPath(remote.path, user);
  if (host === alias && path === remote.path) return remoteUrl;
  return path.startsWith("/")
    ? `ssh://${user ?? "git"}@${host}${path}`
    : `${user ?? "git"}@${host}:${path}`;
});
