import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  EnvironmentIdentity,
  EnvironmentProcessBackend,
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentInteractiveProcessRequest,
  EnvironmentInteractiveSession,
  EnvironmentStatus,
  ManagedEnvironment,
} from "./index.ts";

const MANAGED_BY = "io.subpolar.environment-manager";
const ID_LABEL = "io.subpolar.environment-id";
const OWNER_LABEL = "io.subpolar.owner-sha256";
const WORKSPACE_LABEL = "io.subpolar.workspace-sha256";
const WORKTREE_LABEL = "io.subpolar.worktree-sha256";
const LABELS = [MANAGED_BY, ID_LABEL, OWNER_LABEL, WORKSPACE_LABEL, WORKTREE_LABEL] as const;

export class DockerEnvironmentError extends Error {
  constructor(
    readonly code:
      | "INVALID_DOCKER_CONFIG"
      | "WORKSPACE_MAPPING_INVALID"
      | "WORKTREE_MAPPING_INVALID"
      | "GIT_METADATA_MAPPING_INVALID"
      | "UNSUPPORTED_GIT_LAYOUT"
      | "DOCKER_IDENTITY_MISMATCH"
      | "DOCKER_CONFIGURATION_MISMATCH"
      | "DEV_CONTAINER_CONFIGURATION_INVALID"
      | "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED"
      | "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED"
      | "PROCESS_EXECUTION_UNAVAILABLE"
      | "PROCESS_REQUEST_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DockerEnvironmentError";
  }
}

export interface DockerEnvironmentConfig {
  /** Path visible to the gateway process and recorded in EnvironmentIdentity. */
  readonly gatewayStorageRoot: string;
  /** Absolute path resolved by the Docker daemon, supplied by the operator. */
  readonly hostStorageRoot: string;
  /** Absolute path inside every worker container. */
  readonly containerStorageRoot: string;
  /** Optional paired roots used to map T3's shared Git metadata directory. */
  readonly gatewayGitRoot?: string;
  readonly hostGitRoot?: string;
  /** Image reference selected by the operator. */
  readonly image: string;
  /** Relative config path, such as `.devcontainer/node/devcontainer.json`, for multi-config worktrees. */
  readonly defaultDevContainerConfiguration?: string;
  readonly memoryBytes?: number;
  readonly nanoCpus?: number;
  readonly pidsLimit?: number;
}

export interface DockerBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly readOnly: false;
}

export interface DockerContainerCreateOptions {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: "1000:1000";
  readonly privileged: false;
  readonly readOnlyRootfs: true;
  readonly networkMode: "none";
  readonly capDrop: readonly ["ALL"];
  readonly securityOpt: readonly ["no-new-privileges:true"];
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly mounts: readonly DockerBindMount[];
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface DockerContainerProcessRequest {
  readonly command: readonly string[];
  readonly worktreeDirectory: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onOutput?: EnvironmentProcessRequest["onOutput"];
}

export interface DockerContainerInteractiveRequest extends EnvironmentInteractiveProcessRequest {
  readonly command: readonly string[];
  readonly worktreeDirectory: string;
  readonly workingDirectory: string;
  /** Manager generated token used only by the Docker Engine adapter for cleanup. */
  readonly controlToken?: string;
}

export type DockerContainerState = "created" | "running" | "paused" | "restarting" | "exited" | "dead";

/** Normalized, read-only information the adapter requires from a Docker client. */
export interface DockerContainerInspection {
  readonly id: string;
  readonly name: string;
  readonly state: DockerContainerState;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly config: {
    readonly image: string;
    readonly user: string;
    readonly privileged: boolean;
    readonly readOnlyRootfs: boolean;
    readonly networkMode: string;
    readonly capDrop: readonly string[];
    readonly securityOpt: readonly string[];
    readonly memoryBytes: number;
    readonly nanoCpus: number;
    readonly pidsLimit: number;
    readonly mounts: readonly DockerBindMount[];
    readonly tmpfs: Readonly<Record<string, string>>;
    readonly environment: Readonly<Record<string, string>>;
  };
}

/**
 * Inject a narrowly scoped Docker client from a manager process. This adapter
 * never imports an SDK and must not be wired to an unrestricted daemon socket
 * in the T3 gateway. Implementations should expose only the methods below.
 */
export interface DockerClient {
  inspectContainer(name: string): Promise<DockerContainerInspection | null>;
  createContainer(options: DockerContainerCreateOptions): Promise<{ readonly id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, options: { readonly timeoutSeconds: 10 }): Promise<void>;
  removeContainer(id: string, options: { readonly force: false; readonly removeVolumes: false }): Promise<void>;
  /** Must preserve argv boundaries, stream both output channels, and terminate the owned process on abort. */
  executeContainer?(id: string, request: DockerContainerProcessRequest): Promise<EnvironmentProcessResult>;
  startInteractiveContainer?(id: string, request: DockerContainerInteractiveRequest): Promise<EnvironmentInteractiveSession>;
}

export const DOCKER_RESOURCE_DEFAULTS = Object.freeze({
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
});

const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,size=64m",
  "/run": "rw,nosuid,nodev,size=16m",
});
const ENVIRONMENT = Object.freeze({ HOME: "/tmp/home", TMPDIR: "/tmp" });

interface ResolvedDevContainerConfiguration {
  readonly image: string;
}

function parseJsonc(source: string): unknown {
  // Dev Container files are JSONC. Remove comments and trailing commas while
  // respecting quoted strings, then let JSON.parse validate the structure.
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (inString) {
      withoutComments += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      withoutComments += current;
    } else if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      withoutComments += "\n";
    } else if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index >= source.length) throw new Error("Unterminated comment");
      index += 1;
      withoutComments += " ";
    } else {
      withoutComments += current;
    }
  }
  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const current = withoutComments[index]!;
    if (inString) {
      normalized += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
      normalized += current;
    } else if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead += 1;
      if (withoutComments[lookahead] !== "}" && withoutComments[lookahead] !== "]") normalized += current;
    } else {
      normalized += current;
    }
  }
  return JSON.parse(normalized) as unknown;
}

async function resolveDevContainerConfiguration(
  identity: EnvironmentIdentity,
  config: DockerEnvironmentConfig,
): Promise<ResolvedDevContainerConfiguration> {
  const root = identity.worktreePath;
  const candidates: string[] = [];
  for (const relative of [".devcontainer.json", ".devcontainer/devcontainer.json"]) {
    try {
      if ((await lstat(path.join(root, relative))).isFile()) candidates.push(relative);
    } catch { /* Missing conventional config. */ }
  }
  try {
    const entries = await readdir(path.join(root, ".devcontainer"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(".devcontainer", entry.name, "devcontainer.json");
      try {
        if ((await lstat(path.join(root, relative))).isFile()) candidates.push(relative);
      } catch { /* This directory is not a configuration. */ }
    }
  } catch { /* No .devcontainer directory. */ }

  if (candidates.length === 0) return { image: config.image };
  const selected = config.defaultDevContainerConfiguration
    ? candidates.find((candidate) => candidate === config.defaultDevContainerConfiguration)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED",
      `Worktree has multiple Dev Container configurations; set defaultDevContainerConfiguration to one of: ${candidates.join(", ")}`,
    );
  }
  let realConfiguration: string;
  try {
    realConfiguration = await realpath(path.join(root, selected));
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Selected Dev Container configuration cannot be resolved", { cause });
  }
  if (!within(root, realConfiguration) || !(await lstat(realConfiguration)).isFile()) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container configuration must be a regular file inside the worktree");
  }

  let parsed: unknown;
  try {
    const source = await readFile(realConfiguration, "utf8");
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error("Configuration exceeds 64 KiB");
    parsed = parseJsonc(source);
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `Could not parse ${selected} as a Dev Container JSONC file`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must contain a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  const unsupported = Object.keys(value).filter((key) => !["$schema", "name", "image"].includes(key));
  if (unsupported.length > 0) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      `${selected} uses unsupported Dev Container options: ${unsupported.join(", ")}`,
    );
  }
  if (value.image !== undefined && (typeof value.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(value.image))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must specify a literal Docker image reference`);
  }
  return { image: typeof value.image === "string" ? value.image : config.image };
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containerName(environmentId: string): string {
  return `subpolar-${environmentId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function containerPath(root: string, relative: string): string {
  const resolved = path.posix.resolve(root, relative.split(path.sep).join(path.posix.sep));
  if (resolved !== root && !resolved.startsWith(`${root.replace(/\/$/, "")}/`)) {
    throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped container worktree escapes its configured root");
  }
  return resolved;
}

function status(state: DockerContainerState): EnvironmentStatus {
  switch (state) {
    case "running": return "ready";
    case "created":
    case "exited": return "stopped";
    case "paused":
    case "restarting":
    case "dead": return "failed";
  }
}

function validateLimits(config: DockerEnvironmentConfig): Required<Pick<DockerEnvironmentConfig, "memoryBytes" | "nanoCpus" | "pidsLimit">> {
  const limits = {
    memoryBytes: config.memoryBytes ?? DOCKER_RESOURCE_DEFAULTS.memoryBytes,
    nanoCpus: config.nanoCpus ?? DOCKER_RESOURCE_DEFAULTS.nanoCpus,
    pidsLimit: config.pidsLimit ?? DOCKER_RESOURCE_DEFAULTS.pidsLimit,
  };
  if (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024 * 1024 || limits.memoryBytes > 16 * 1024 ** 3 ||
      !Number.isSafeInteger(limits.nanoCpus) || limits.nanoCpus < 100_000_000 || limits.nanoCpus > 16_000_000_000 ||
      !Number.isSafeInteger(limits.pidsLimit) || limits.pidsLimit < 16 || limits.pidsLimit > 4096) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Docker resource limits must be positive bounded integers");
  }
  return limits;
}

/**
 * Creates a Docker backend around an injected, restricted client contract.
 * A linked worktree gets a second bind mount for its canonical common Git
 * directory, but only when that directory is within a separately configured
 * gateway/host root pair. The mount target preserves Git's absolute gitdir
 * pointer, and no parent repository directory is mounted.
 */
export function createDockerEnvironmentBackend(
  client: DockerClient,
  config: DockerEnvironmentConfig,
): EnvironmentProcessBackend {
  if (!config.image.trim()) throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "A Docker image is required");
  if (Boolean(config.gatewayGitRoot) !== Boolean(config.hostGitRoot)) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway and Docker-host Git metadata roots must be configured together");
  }
  if (config.gatewayGitRoot && (!path.isAbsolute(config.gatewayGitRoot) || !path.isAbsolute(config.hostGitRoot!))) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway and Docker-host Git metadata roots must be absolute paths");
  }
  if (!path.isAbsolute(config.gatewayStorageRoot) || !path.isAbsolute(config.hostStorageRoot) || !path.posix.isAbsolute(config.containerStorageRoot)) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway, host, and container storage roots must be absolute");
  }
  const containerStorageRoot = path.posix.resolve(config.containerStorageRoot);
  if (containerStorageRoot === "/") {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Container storage root must be a dedicated subdirectory");
  }
  const limits = validateLimits(config);
  const backendId = "docker-manager-v1";

  const resolveMounts = async (identity: EnvironmentIdentity): Promise<readonly DockerBindMount[]> => {
    let gatewayRoot: string;
    let gatewayWorktree: string;
    let hostRoot: string;
    try {
      [gatewayRoot, gatewayWorktree, hostRoot] = await Promise.all([
        realpath(config.gatewayStorageRoot),
        realpath(identity.worktreePath),
        realpath(config.hostStorageRoot),
      ]);
    } catch (cause) {
      throw new DockerEnvironmentError("WORKSPACE_MAPPING_INVALID", "Configured workspace roots and gateway worktree must exist", { cause });
    }
    if (gatewayRoot === "/" || hostRoot === "/") {
      throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Workspace storage roots must be dedicated directories, not filesystem roots");
    }
    if (identity.storageRoot !== gatewayRoot || !within(gatewayRoot, gatewayWorktree)) {
      throw new DockerEnvironmentError("WORKSPACE_MAPPING_INVALID", "Environment identity is outside the configured gateway storage root");
    }

    const relative = path.relative(gatewayRoot, gatewayWorktree);
    const expectedHostPath = path.resolve(hostRoot, relative);
    if (!within(hostRoot, expectedHostPath)) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree escapes the configured host storage root");
    }
    let hostWorktree: string;
    try {
      hostWorktree = await realpath(expectedHostPath);
    } catch (cause) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree does not exist on the Docker host", { cause });
    }
    if (!within(hostRoot, hostWorktree) || !(await lstat(hostWorktree)).isDirectory()) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree resolves outside the configured host storage root");
    }

    const gatewayGitPath = path.join(gatewayWorktree, ".git");
    const hostGitPath = path.join(hostWorktree, ".git");
    let gitMetadataMount: DockerBindMount | undefined;
    try {
      const [gatewayGitStat, hostGitStat] = await Promise.all([lstat(gatewayGitPath), lstat(hostGitPath)]);
      if (gatewayGitStat.isDirectory() && hostGitStat.isDirectory()) {
        const [gatewayGitReal, hostGitReal] = await Promise.all([realpath(gatewayGitPath), realpath(hostGitPath)]);
        if (!within(gatewayWorktree, gatewayGitReal) || !within(hostWorktree, hostGitReal)) {
          throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", ".git metadata resolves outside the worktree");
        }
      } else if (gatewayGitStat.isFile() && hostGitStat.isFile()) {
        if (!config.gatewayGitRoot || !config.hostGitRoot) {
          throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Linked worktrees require explicit gateway and Docker-host Git metadata roots");
        }
        const [gatewayRoot, hostGitRoot] = await Promise.all([
          realpath(config.gatewayGitRoot),
          realpath(config.hostGitRoot),
        ]);
        if (gatewayRoot === "/" || hostGitRoot === "/" ||
            !(await lstat(gatewayRoot)).isDirectory() || !(await lstat(hostGitRoot)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Git metadata roots must be dedicated directories");
        }
        const [gatewayPointer, hostPointer] = await Promise.all([
          readFile(gatewayGitPath, "utf8"),
          readFile(hostGitPath, "utf8"),
        ]);
        const parseGitDir = (pointer: string, worktree: string): string => {
          const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
          if (!match?.[1]) throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Linked worktree has an invalid .git pointer");
          return path.resolve(worktree, match[1]);
        };
        const gatewayGitDir = await realpath(parseGitDir(gatewayPointer, gatewayWorktree));
        const hostGitDir = await realpath(parseGitDir(hostPointer, hostWorktree));
        if (!within(gatewayRoot, gatewayGitDir) || !within(hostGitRoot, hostGitDir) ||
            !(await lstat(gatewayGitDir)).isDirectory() || !(await lstat(hostGitDir)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Linked worktree metadata is outside the configured Git roots");
        }
        const gitDirRelative = path.relative(gatewayRoot, gatewayGitDir);
        const expectedHostGitDir = path.resolve(hostGitRoot, gitDirRelative);
        if (await realpath(expectedHostGitDir) !== hostGitDir) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Gateway and Docker-host linked Git metadata do not map to the same relative path");
        }
        const [gatewayCommonPointer, hostCommonPointer] = await Promise.all([
          readFile(path.join(gatewayGitDir, "commondir"), "utf8"),
          readFile(path.join(hostGitDir, "commondir"), "utf8"),
        ]);
        const gatewayCommonPath = path.resolve(gatewayGitDir, gatewayCommonPointer.trim());
        const hostCommonPath = path.resolve(hostGitDir, hostCommonPointer.trim());
        const [gatewayCommonDir, hostCommonDir] = await Promise.all([
          realpath(gatewayCommonPath),
          realpath(hostCommonPath),
        ]);
        if (!within(gatewayRoot, gatewayCommonDir) || !within(hostGitRoot, hostCommonDir) ||
            !(await lstat(gatewayCommonDir)).isDirectory() || !(await lstat(hostCommonDir)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Shared Git metadata is outside the configured Git roots");
        }
        const commonRelative = path.relative(gatewayRoot, gatewayCommonDir);
        const expectedHostCommonDir = path.resolve(hostGitRoot, commonRelative);
        if (await realpath(expectedHostCommonDir) !== hostCommonDir || gatewayCommonPath !== gatewayCommonDir) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Gateway and Docker-host common Git directories do not map canonically");
        }
        gitMetadataMount = {
          type: "bind",
          source: hostCommonDir,
          // Preserve the absolute path referenced by the worktree's .git file.
          target: gatewayCommonDir,
          readOnly: false,
        };
      } else {
        throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Gateway and Docker-host worktrees must use matching .git layouts");
      }
    } catch (cause) {
      if (cause instanceof DockerEnvironmentError) throw cause;
      throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "The worktree Git metadata could not be resolved safely", { cause });
    }

    const target = containerPath(containerStorageRoot, relative);
    return [
      { type: "bind", source: hostWorktree, target, readOnly: false },
      ...(gitMetadataMount ? [gitMetadataMount] : []),
    ];
  };

  const labelsFor = (identity: EnvironmentIdentity): Readonly<Record<string, string>> => ({
    [MANAGED_BY]: "subpolar",
    [ID_LABEL]: identity.id,
    [OWNER_LABEL]: hash(identity.ownerId),
    [WORKSPACE_LABEL]: hash(identity.workspaceId),
    [WORKTREE_LABEL]: hash(identity.worktreePath),
  });

  const createOptions = async (identity: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): Promise<DockerContainerCreateOptions> => ({
    name: containerName(identity.id),
    image: resolved.image,
    labels: labelsFor(identity),
    user: "1000:1000",
    privileged: false,
    readOnlyRootfs: true,
    networkMode: "none",
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    ...limits,
    mounts: await resolveMounts(identity),
    tmpfs: TMPFS,
    environment: ENVIRONMENT,
  });

  const recordFor = (identity: EnvironmentIdentity, inspection: DockerContainerInspection, mounts: readonly DockerBindMount[], image: string): ManagedEnvironment => {
    const expectedLabels = labelsFor(identity);
    if (inspection.name !== containerName(identity.id) || LABELS.some((label) => inspection.labels[label] !== expectedLabels[label])) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container identity or owner labels do not match the requested environment");
    }
    const observed = inspection.config;
    const observedMounts = observed.mounts;
    const safeConfiguration =
      observed.image === image && observed.user === "1000:1000" && observed.privileged === false &&
      observed.readOnlyRootfs === true && observed.networkMode === "none" &&
      observed.capDrop.length === 1 && observed.capDrop[0] === "ALL" &&
      observed.securityOpt.length === 1 && observed.securityOpt[0] === "no-new-privileges:true" &&
      observed.memoryBytes === limits.memoryBytes && observed.nanoCpus === limits.nanoCpus && observed.pidsLimit === limits.pidsLimit &&
      observedMounts.length === mounts.length && mounts.every((mount, index) => {
        const observedMount = observedMounts[index];
        return observedMount?.type === "bind" && observedMount.source === mount.source &&
          observedMount.target === mount.target && observedMount.readOnly === false;
      }) &&
      sameRecord(observed.tmpfs, TMPFS) && sameRecord(observed.environment, ENVIRONMENT) && inspection.id.length > 0;
    if (!safeConfiguration) {
      throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Docker container configuration does not match the required isolation settings");
    }
    return { ...identity, backendId, resourceId: inspection.id, status: status(inspection.state) };
  };

  const inspectVerified = async (identity: EnvironmentIdentity): Promise<{ record: ManagedEnvironment; inspection: DockerContainerInspection } | null> => {
    const [mounts, resolved] = await Promise.all([resolveMounts(identity), resolveDevContainerConfiguration(identity, config)]);
    const inspection = await client.inspectContainer(containerName(identity.id));
    if (!inspection) return null;
    return { record: recordFor(identity, inspection, mounts, resolved.image), inspection };
  };

  return {
    id: backendId,
    async inspect(identity) {
      return (await inspectVerified(identity))?.record ?? null;
    },
    async create(identity) {
      const existing = await inspectVerified(identity);
      if (existing) return existing.record;
      const resolved = await resolveDevContainerConfiguration(identity, config);
      const options = await createOptions(identity, resolved);
      let createdId: string;
      try {
        ({ id: createdId } = await client.createContainer(options));
      } catch (cause) {
        // Another manager may have won the stable-name race. Adopt only after
        // re-reading and verifying every ownership and isolation field.
        const raced = await inspectVerified(identity);
        if (raced) return raced.record;
        throw cause;
      }
      const created = await inspectVerified(identity);
      if (!created || created.record.resourceId !== createdId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Created Docker container could not be verified by its stable identity");
      }
      return created.record;
    },
    async start(environment) {
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before start");
      }
      if (current.record.status !== "ready") await client.startContainer(current.inspection.id);
      const started = await inspectVerified(environment);
      if (!started || started.record.resourceId !== environment.resourceId || started.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container did not reach the verified running state");
      }
      return started.record;
    },
    async stop(environment) {
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before stop");
      }
      if (current.record.status !== "stopped") await client.stopContainer(current.inspection.id, { timeoutSeconds: 10 });
      const stopped = await inspectVerified(environment);
      if (!stopped || stopped.record.resourceId !== environment.resourceId || stopped.record.status !== "stopped") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container did not reach the verified stopped state");
      }
      return stopped.record;
    },
    async remove(environment) {
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before removal");
      }
      if (current.record.status !== "stopped") {
        await client.stopContainer(current.inspection.id, { timeoutSeconds: 10 });
        const afterStop = await inspectVerified(environment);
        if (!afterStop || afterStop.record.resourceId !== environment.resourceId || afterStop.record.status !== "stopped") {
          throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container could not be verified stopped before removal");
        }
      }
      await client.removeContainer(current.inspection.id, { force: false, removeVolumes: false });
    },
    async execute(environment, command, request) {
      if (!client.executeContainer) {
        throw new DockerEnvironmentError("PROCESS_EXECUTION_UNAVAILABLE", "Docker client does not support managed process execution");
      }
      if (!command.length || command.some((part) => !part || part.includes("\0"))) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process command must be a non-empty argv array without NUL bytes");
      }
      const relativeCwd = request.cwd ?? ".";
      if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\0")) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd must be relative to the worktree");
      }
      const worktreeRelativePath = path.relative(environment.storageRoot, environment.worktreePath);
      if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Environment worktree cannot be mapped inside the container");
      }
      const worktreeTarget = containerPath(containerStorageRoot, worktreeRelativePath);
      const workingDirectory = path.posix.resolve(worktreeTarget, relativeCwd);
      if (workingDirectory !== worktreeTarget && !workingDirectory.startsWith(`${worktreeTarget}/`)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd escapes the mounted worktree");
      }
      const environmentVariables = request.environment ?? {};
      for (const [key, value] of Object.entries(environmentVariables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0") || value.length > 16_384) {
          throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process environment contains an invalid key or value");
        }
      }
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId || current.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker environment is unavailable or changed identity before process execution");
      }
      if (request.signal?.aborted) return { exitCode: null, cancelled: true };
      return client.executeContainer(current.inspection.id, {
        command: [...command],
        worktreeDirectory: worktreeTarget,
        workingDirectory,
        environment: { ...environmentVariables },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
      });
    },
    async startInteractive(environment, command, request) {
      if (!client.startInteractiveContainer) {
        throw new DockerEnvironmentError("PROCESS_EXECUTION_UNAVAILABLE", "Docker client does not support interactive process execution");
      }
      if (!command.length || command.some((part) => !part || part.includes("\0"))) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process command must be a non-empty argv array without NUL bytes");
      }
      const relativeCwd = request.cwd ?? ".";
      if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\0")) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd must be relative to the worktree");
      }
      const worktreeRelativePath = path.relative(environment.storageRoot, environment.worktreePath);
      if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Environment worktree cannot be mapped inside the container");
      }
      const worktreeTarget = containerPath(containerStorageRoot, worktreeRelativePath);
      const workingDirectory = path.posix.resolve(worktreeTarget, relativeCwd);
      if (workingDirectory !== worktreeTarget && !workingDirectory.startsWith(`${worktreeTarget}/`)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd escapes the mounted worktree");
      }
      const environmentVariables = request.environment ?? {};
      for (const [key, value] of Object.entries(environmentVariables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0") || value.length > 16_384) {
          throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process environment contains an invalid key or value");
        }
      }
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId || current.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker environment is unavailable or changed identity before interactive process start");
      }
      return client.startInteractiveContainer(current.inspection.id, {
        command: [...command], worktreeDirectory: worktreeTarget, workingDirectory,
        ...(request.environment === undefined ? {} : { environment: { ...request.environment } }),
      });
    },
  };
}
