/**
 * Files uploaded into a GitLab merge request body or comment. GitLab writes them as
 * project-relative `/uploads/<secret>/<name>` links, and a private project serves them only to a
 * signed-in request, so the server fetches them through the upload API with the `glab` credential.
 */

const UPLOAD_PATH_PATTERN =
  /^\/(?:-\/project\/(\d+)|((?:[\w.-]+\/)*[\w.-]+))\/uploads\/([0-9a-f]{32})\/([^/]+)$/iu;
/** A link destination, an HTML `src`/`href`, or a reference definition pointing at an upload. */
const RELATIVE_UPLOAD_PATTERN =
  /(\]\(\s*<?|\b(?:src|href)\s*=\s*["']?|^ {0,3}\[[^\]\n]+\]:\s*<?)\/uploads\/(?=[0-9a-f]{32}\/)/gimu;

export interface GitLabUpload {
  readonly origin: string;
  readonly host: string;
  /** A numeric project id or the full project path, as the API's `:id` accepts either. */
  readonly project: string;
  readonly secret: string;
  /** The file name segment, still percent-encoded. */
  readonly fileSegment: string;
}

export function parseGitLabUpload(source: string): GitLabUpload | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const match = UPLOAD_PATH_PATTERN.exec(url.pathname);
  if (match === null) return null;
  const [, projectId, projectPath, secret, fileSegment] = match;
  // `-` separates a project path from its routes, so it is never part of one.
  if (projectPath?.split("/").includes("-")) return null;
  return {
    origin: url.origin,
    host: url.host.toLowerCase(),
    project: projectId ?? projectPath!,
    secret: secret!,
    fileSegment: fileSegment!,
  };
}

/** The canonical upload URL for `source`, or null when it is not a GitLab upload. */
export function gitlabMediaFetchUrl(source: string): string | null {
  const upload = parseGitLabUpload(source);
  return upload === null ? null : new URL(new URL(source).pathname, upload.origin).toString();
}

/** The API route that serves the upload to any project member (GitLab 17.4+). */
export function gitlabUploadApiUrl(upload: GitLabUpload): string {
  return `${upload.origin}/api/v4/projects/${encodeURIComponent(upload.project)}/uploads/${upload.secret}/${upload.fileSegment}`;
}

export function gitlabMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "gitlab-upload";
}

/** Rewrites GitLab's project-relative upload links against the project's web URL. */
export function resolveGitLabUploadLinks(markdown: string, projectUrl: string): string {
  const base = projectUrl.replace(/\/+$/u, "");
  return markdown.replace(
    RELATIVE_UPLOAD_PATTERN,
    (_, prefix: string) => `${prefix}${base}/uploads/`,
  );
}
