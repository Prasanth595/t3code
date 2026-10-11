import * as Schema from "effect/Schema";

export class ServerCliCommandExitError extends Schema.TaggedError<ServerCliCommandExitError>()(
  "ServerCliCommandExitError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerCliDevelopmentIconSourceMissingError extends Schema.TaggedError<ServerCliDevelopmentIconSourceMissingError>()(
  "ServerCliDevelopmentIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerCliDevelopmentIconTargetMissingError extends Schema.TaggedError<ServerCliDevelopmentIconTargetMissingError>()(
  "ServerCliDevelopmentIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}

export class ServerCliBuildAssetMissingError extends Schema.TaggedError<ServerCliBuildAssetMissingError>()(
  "ServerCliBuildAssetMissingError",
  {
    assetPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Missing build asset: ${this.assetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliPlatformManifestInvalidError extends Schema.TaggedError<ServerCliPlatformManifestInvalidError>()(
  "ServerCliPlatformManifestInvalidError",
  {
    assetPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid platform package manifest: ${this.assetPath}`;
  }
}

export class ServerCliNpmPackageNotReadyError extends Schema.TaggedError<ServerCliNpmPackageNotReadyError>()(
  "ServerCliNpmPackageNotReadyError",
  {
    packageSpec: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.packageSpec} is not installable yet: ${this.reason}`;
  }
}

export class ServerCliNpmPackagesNotInstallableError extends Schema.TaggedError<ServerCliNpmPackagesNotInstallableError>()(
  "ServerCliNpmPackagesNotInstallableError",
  {
    pending: Schema.Array(Schema.String),
    launcherTarball: Schema.String,
  },
) {
  override get message(): string {
    const launcher = this.launcherTarball.split(/[\\/]/).at(-1);
    return `npm did not serve these platform packages within 10 minutes: ${this.pending.join("; ")}. ${launcher} was not published. The platform versions are already live and cannot be republished, so once each listed tarball downloads, publish ${launcher} by hand with the same --access and --tag.`;
  }
}

export class ServerCliExecutableImportError extends Schema.TaggedError<ServerCliExecutableImportError>()(
  "ServerCliExecutableImportError",
  {
    bundlePath: Schema.String,
    specifiers: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `${this.bundlePath} imports file-backed packages that a single-executable cannot resolve: ${this.specifiers.join(", ")}. Load them through createRequire instead.`;
  }
}
