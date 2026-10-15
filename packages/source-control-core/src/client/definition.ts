import {
  type PullRequestAction,
  pullRequestHostOf,
  type PullRequestReviewVerdict,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { ChangeRequestLink } from "@t3tools/shared/changeRequestUrl";
import * as Schema from "effect/Schema";

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export interface ChangeRequestUrlInput {
  /** The host below which the repository is addressed, as `pullRequestHostOf` reports it. */
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  /** The checkout's remote URL, whose origin some hosts serve their web pages from. */
  readonly remoteUrl?: string | undefined;
  readonly webUrl?: string | undefined;
}

export type ChangeRequestProjectIdentity = Pick<
  RepositoryIdentity,
  "canonicalKey" | "locator" | "webUrl" | "displayName" | "owner" | "name"
>;

export interface ChangeRequestCheckoutInput {
  readonly number: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  /** The repository's web URL, for hosts whose checkout fetches from it. */
  readonly repositoryUrl?: string | null | undefined;
}

export interface SourceControlClientDefinition {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly pickerLabel: string;
  /** Glyph key each client maps to its own icon; a key a client lacks draws the generic glyph. */
  readonly icon: string;
  readonly changeRequest: ChangeRequestTerminology;
  readonly repositoryPathHint: string;
  /**
   * The hostname a change request reference can be attributed to before any repository
   * identity is known, or null when a hostname alone does not name this host.
   */
  readonly publicHost: string | null;
  readonly publishDescription: string;
  readonly publishHost: (signedInHost: string | null) => string;
  /**
   * Who a new project's repository is published under, given the signed-in account: an owner to
   * name, `null` owner to let the host's CLI pick the signed-in user, or null when the host needs
   * a choice an account cannot make, such as Azure DevOps' project.
   */
  readonly newRepositoryOwner: (account: string | null) => { readonly owner: string | null } | null;
  readonly defaultCloneTransport: "https" | "ssh";
  readonly changeRequestUrl: (input: ChangeRequestUrlInput) => string | null;
  /**
   * The actions this host can take on a change request, the same list its server provider
   * declares in `capabilities.actions`.
   */
  readonly changeRequestActions: ReadonlySet<PullRequestAction>;
  readonly checkoutCommand: (changeRequest: ChangeRequestCheckoutInput) => string | null;
  readonly authorProfileUrl: (login: string, repositoryUrl: string) => string | null;
  /**
   * The repository URL that `#123` and commit SHAs in change request text link under, using
   * GitHub's `/issues/` and `/commit/` routes, or null where the host does not route them so.
   */
  readonly referenceAutolinkRepositoryUrl: (repositoryUrl: string) => string | null;
  readonly reviewSummaryRequired: (verdict: PullRequestReviewVerdict) => boolean;
  /**
   * The change request a pasted command names, such as `gh pr checkout 42`: its argument, which
   * is a number or a URL. Null for anything that is not this host's checkout command.
   */
  readonly checkoutCommandArgument: (input: string) => string | null;
  /**
   * Whether a pasted URL is one of this host's change request URLs. Stricter than
   * `isChangeRequestUrl`, which only tells hosts apart, because this decides what a reference
   * field accepts.
   */
  readonly isChangeRequestReference: (url: string) => boolean;
  /**
   * Whether a change request link names this project's own repository. The link's host is where
   * the repository is addressed, `link.authority` the web host and port where they differ.
   */
  readonly isChangeRequestInRepository: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  /**
   * Whether this project can read a change request on the link's host on the link's behalf, for a
   * repository nobody has checked out. False where the host's reads are scoped to the checkout.
   */
  readonly canReadChangeRequestOnHost: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  /**
   * The host a change request URL addresses its repository below, as a `PullRequestRef.host`
   * names it: the hostname, or the host and port for servers addressed by both.
   */
  readonly changeRequestUrlHost: (url: URL) => string;
  /**
   * The host a reference with none names, read from the checkout alone, or null where only the
   * server can tell, such as when an SSH remote resolves to a different web host.
   */
  readonly checkoutChangeRequestHost: (identity: ChangeRequestProjectIdentity) => string | null;
  readonly isChangeRequestUrl: (url: string) => boolean;
  /**
   * Fields carry `providerSettingsForm` annotations, as agent provider settings do; a
   * `secretSetting` is kept in the server's secret store. Omitted for a host with nothing
   * to configure.
   */
  readonly settings?: SourceControlHostSettingsSchema;
}

/** A host's settings struct. Its fields are strings, or a secret string per server host. */
export type SourceControlHostSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Decoder<object>;

/**
 * Matching the parsed path keeps a query or fragment that mentions another host's route out.
 */
export function isChangeRequestPath(url: string, route: string): boolean {
  try {
    const path = new URL(url).pathname;
    const at = path.indexOf(route);
    return at > 0 && /^\d+(?:\/|$)/u.test(path.slice(at + route.length));
  } catch {
    return false;
  }
}

export function defineSourceControlClient<const Definition extends SourceControlClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

/**
 * A link carries one only where the host and port differ from where the repository is addressed,
 * as on a Forgejo server with a port; an SSH remote says nothing about ports, so it does not
 * rule the link out.
 */
export function isChangeRequestAuthorityOfProject(
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (link.authority === undefined) return true;
  try {
    const remote = new URL(identity.locator.remoteUrl);
    if (remote.protocol === "http:" || remote.protocol === "https:") {
      return remote.host.toLowerCase() === link.authority;
    }
  } catch {
    // SSH remotes do not specify the server's HTTP port.
  }
  return true;
}

export function isChangeRequestOnProjectHost(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
  const host = pullRequestHostOf(identity, kind);
  return host === link.host.toLowerCase() || host === link.authority;
}

function projectRepositoryPath(identity: ChangeRequestProjectIdentity): string | null {
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

/**
 * `isChangeRequestInRepository` for hosts that address a repository by its full path below the
 * host, which is what nested GitLab groups need.
 */
export function isChangeRequestInProjectRepository(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  const repository = projectRepositoryPath(identity);
  return (
    repository !== null &&
    repository.toLowerCase() === link.repository.toLowerCase() &&
    isChangeRequestOnProjectHost(kind, identity, link)
  );
}

export const UNKNOWN_SOURCE_CONTROL_CLIENT: SourceControlClientDefinition = {
  kind: SourceControlProviderKind.make("unknown"),
  label: "source control",
  pickerLabel: "source control",
  icon: "change-request",
  changeRequest: { shortLabel: "change request", singular: "change request" },
  repositoryPathHint: "URL",
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: () => null,
  changeRequestActions: new Set(),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(SourceControlProviderKind.make("unknown"), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(SourceControlProviderKind.make("unknown"), identity, link),
  isChangeRequestUrl: () => false,
};

export interface SourceControlClientRegistry {
  readonly definitions: ReadonlyArray<SourceControlClientDefinition>;
  /**
   * No kind at all, before a repository reports its host, reads as the first
   * definition; a kind this client lacks, `unknown` included, reads as
   * `UNKNOWN_SOURCE_CONTROL_CLIENT`.
   */
  readonly get: (kind: string | null | undefined) => SourceControlClientDefinition;
  readonly find: (kind: string) => SourceControlClientDefinition | undefined;
  readonly findByPublicHost: (hostname: string) => SourceControlClientDefinition | undefined;
  readonly findByChangeRequestUrl: (url: string) => SourceControlClientDefinition | undefined;
  readonly hostLabelForChangeRequestUrl: (url: string) => string;
}

export function makeSourceControlClientRegistry(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
): SourceControlClientRegistry {
  const byKind = new Map<string, SourceControlClientDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Source control host '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  return {
    definitions,
    get: (kind) =>
      (kind == null ? definitions[0] : byKind.get(kind)) ?? UNKNOWN_SOURCE_CONTROL_CLIENT,
    find: (kind) => byKind.get(kind),
    findByPublicHost: (hostname) => {
      const host = hostname.toLowerCase();
      return definitions.find((definition) => definition.publicHost === host);
    },
    findByChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url)),
    hostLabelForChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url))?.label ?? "the host",
  };
}

/**
 * A blob that no longer decodes, such as one a newer build wrote, reads as the
 * schema's defaults rather than failing the host.
 */
export function readSourceControlHostSettings<S extends SourceControlHostSettingsSchema>(
  schema: S,
  saved: unknown,
): S["Type"] {
  const decode = Schema.decodeUnknownOption(schema as Schema.Decoder<S["Type"]>);
  const decoded = decode(saved ?? {});
  if (decoded._tag === "Some") return decoded.value;
  const fallback = decode({});
  if (fallback._tag === "Some") return fallback.value;
  throw new Error("A source control host settings schema must decode an empty object.");
}
