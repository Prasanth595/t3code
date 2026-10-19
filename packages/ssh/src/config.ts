import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { SshHostDiscoveryError } from "./errors.ts";

const NO_HOSTS: ReadonlyArray<string> = [] as const;

function parseSshConfigLine(line: string) {
  const match = /^\s*([a-z]+)(?:\s*=\s*|\s+|$)(.*)$/iu.exec(line);
  if (!match) return null;

  const directive = match[1]!.toLowerCase();
  const args: Array<string> = [];
  let rest = match[2]!.trim();
  while (rest.length > 0 && !rest.startsWith("#")) {
    const token = /^(?:"([^"\\]*)"|'([^'\\]*)'|([^\s"'\\]+))(?=\s|$)/u.exec(rest);
    // Unsupported escaping or partial quoting must not produce a guessed hostname.
    if (!token) return { directive, args: null };
    args.push(token[1] ?? token[2] ?? token[3]!);
    rest = rest.slice(token[0].length).trimStart();
  }
  return { directive, args };
}

function expandHomePath(input: string, homeDir: string): string {
  return input.replace(/^~(?=$|\/|\\)/u, homeDir);
}

export const resolveSshConfigIncludePattern = Effect.fnUntraced(function* (
  includePattern: string,
  _directory: string,
  homeDir: string,
) {
  const path = yield* Path.Path;
  const expandedPattern = expandHomePath(includePattern, homeDir);
  return path.isAbsolute(expandedPattern)
    ? expandedPattern
    : path.resolve(path.join(homeDir, ".ssh"), expandedPattern);
});

function hasSshPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/gu, ".*").replace(/\\\?/gu, ".")}$`,
    "u",
  );
}

const expandGlob = Effect.fnUntraced(function* (pattern: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return (yield* fs.exists(pattern)) ? [pattern] : NO_HOSTS;
  }

  const directory = path.dirname(pattern);
  const basePattern = path.basename(pattern);
  if (!(yield* fs.exists(directory))) {
    return NO_HOSTS;
  }

  const matcher = globToRegExp(basePattern);
  const entries = yield* fs.readDirectory(directory);
  const matchedPaths: string[] = [];
  for (const entry of entries) {
    if (!matcher.test(entry)) {
      continue;
    }
    const entryPath = path.join(directory, entry);
    if (yield* fs.exists(entryPath)) {
      matchedPaths.push(entryPath);
    }
  }
  return matchedPaths.toSorted();
});

type HostCondition = ReadonlyArray<string> | null;

interface HostNameRule {
  readonly conditions: ReadonlyArray<HostCondition>;
  readonly hostname: string | null;
}

function matchesHostPatterns(alias: string, patterns: ReadonlyArray<string>): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const hostPattern = negated ? pattern.slice(1) : pattern;
    const matches =
      hostPattern === "*" ||
      (hasSshPattern(hostPattern) ? globToRegExp(hostPattern).test(alias) : hostPattern === alias);
    if (!matches) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function resolveConfiguredHostname(alias: string, rules: ReadonlyArray<HostNameRule>) {
  for (const { conditions, hostname } of rules) {
    if (
      conditions.some((condition) => condition !== null && !matchesHostPatterns(alias, condition))
    ) {
      continue;
    }
    // SSH takes the first value; an uncertain earlier value blocks later fallbacks.
    if (conditions.includes(null) || hostname === null) return null;
    if (/%(?!h)/u.test(hostname) || hostname.includes("$")) return null;
    return hostname.replaceAll("%h", alias);
  }
  return null;
}

const collectSshConfigAliasesFromFile = Effect.fnUntraced(function* (
  filePath: string,
  visited: Set<string>,
  homeDir: string,
  aliases: Set<string>,
  hostNameRules: Array<HostNameRule>,
  inheritedConditions: ReadonlyArray<HostCondition>,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedPath = path.resolve(filePath);
  if (visited.has(resolvedPath)) {
    // Read each file once, but never reuse its rules under a different Include context.
    hostNameRules.push({ conditions: inheritedConditions, hostname: null });
    return;
  }
  if (!(yield* fs.exists(resolvedPath))) return;
  visited.add(resolvedPath);

  const directory = path.dirname(resolvedPath);
  const raw = yield* fs.readFileString(resolvedPath);
  let condition: HostCondition = ["*"];

  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseSshConfigLine(line);
    if (!parsed) continue;
    const { directive, args } = parsed;
    const conditions = [...inheritedConditions, condition];

    if (directive === "host") {
      condition = args;
      for (const alias of args ?? []) {
        if (alias.length > 0 && !hasSshPattern(alias)) aliases.add(alias);
      }
    } else if (directive === "match") {
      condition = null;
    } else if (directive === "hostname") {
      hostNameRules.push({ conditions, hostname: args?.length === 1 ? args[0]! : null });
    } else if (directive === "include") {
      if (args === null) {
        hostNameRules.push({ conditions, hostname: null });
        continue;
      }
      for (const includePattern of args) {
        const resolvedPattern = yield* resolveSshConfigIncludePattern(
          includePattern,
          directory,
          homeDir,
        );
        if (
          /%|\$\{|\[/u.test(includePattern) ||
          (includePattern.startsWith("~") && !/^~(?=$|\/|\\)/u.test(includePattern)) ||
          hasSshPattern(path.dirname(resolvedPattern))
        ) {
          hostNameRules.push({ conditions, hostname: null });
          continue;
        }
        const includedPaths = yield* expandGlob(resolvedPattern);
        for (const includedPath of includedPaths) {
          yield* collectSshConfigAliasesFromFile(
            includedPath,
            visited,
            homeDir,
            aliases,
            hostNameRules,
            conditions,
          );
        }
      }
    }
  }
});

function normalizeKnownHostsHostname(rawHost: string): string {
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(rawHost);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }

  if (!rawHost.includes(":")) {
    return rawHost;
  }

  const firstColonIndex = rawHost.indexOf(":");
  const lastColonIndex = rawHost.lastIndexOf(":");
  return firstColonIndex === lastColonIndex ? rawHost.slice(0, lastColonIndex) : rawHost;
}

export function parseKnownHostsHostnames(raw: string): ReadonlyArray<string> {
  const hostnames = new Set<string>();

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const withoutMarker = trimmed.startsWith("@")
      ? trimmed.split(/\s+/u).slice(1).join(" ")
      : trimmed;
    const [hostField = ""] = withoutMarker.split(/\s+/u);
    if (hostField.length === 0 || hostField.startsWith("|")) {
      continue;
    }

    for (const rawHost of hostField.split(",")) {
      const host = normalizeKnownHostsHostname(rawHost).trim();
      if (host.length === 0 || hasSshPattern(host)) {
        continue;
      }
      hostnames.add(host);
    }
  }

  return [...hostnames].toSorted((left, right) => left.localeCompare(right));
}

const readKnownHostsHostnames = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) {
    return NO_HOSTS;
  }
  return parseKnownHostsHostnames(yield* fs.readFileString(filePath));
});

export const discoverSshHosts = Effect.fnUntraced(
  function* (input: { readonly homeDir?: string }) {
    const path = yield* Path.Path;
    const env = yield* Config.all({
      home: Config.String("HOME").pipe(Config.option),
      userProfile: Config.String("USERPROFILE").pipe(Config.option),
    });
    const homeDir =
      input?.homeDir ??
      Option.getOrUndefined(env.home) ??
      Option.getOrUndefined(env.userProfile) ??
      "";
    if (homeDir.trim().length === 0) {
      return [];
    }

    const sshDirectory = path.join(homeDir, ".ssh");
    const configAliases = new Set<string>();
    const hostNameRules: Array<HostNameRule> = [];
    yield* collectSshConfigAliasesFromFile(
      path.join(sshDirectory, "config"),
      new Set<string>(),
      homeDir,
      configAliases,
      hostNameRules,
      [],
    );
    const knownHosts = yield* readKnownHostsHostnames(path.join(sshDirectory, "known_hosts"));
    const discovered = new Map<string, DesktopDiscoveredSshHost>();

    const configuredHostnames = new Set<string>();
    for (const alias of configAliases) {
      const hostname = resolveConfiguredHostname(alias, hostNameRules);
      if (hostname !== null) configuredHostnames.add(hostname.toLowerCase());
      discovered.set(alias, {
        alias,
        hostname: hostname ?? alias,
        username: null,
        port: null,
        source: "ssh-config",
      });
    }

    for (const hostname of knownHosts) {
      if (discovered.has(hostname) || configuredHostnames.has(hostname.toLowerCase())) {
        continue;
      }
      discovered.set(hostname, {
        alias: hostname,
        hostname,
        username: null,
        port: null,
        source: "known-hosts",
      });
    }

    return [...discovered.values()].toSorted((left, right) =>
      left.alias.localeCompare(right.alias),
    );
  },
  Effect.mapError(
    (cause) =>
      new SshHostDiscoveryError({
        message: "Failed to discover SSH hosts.",
        cause,
      }),
  ),
);
