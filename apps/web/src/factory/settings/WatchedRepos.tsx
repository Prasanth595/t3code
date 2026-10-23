import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import type { RepoBlock } from "./api";
import { TouchLink } from "../TouchLink";

const list = (items: ReadonlyArray<string>) => (items.length === 0 ? "None" : items.join(", "));

function ProjectConfigRows({ factory }: { readonly factory: NonNullable<RepoBlock["factory"]> }) {
  const { limits } = factory;
  return (
    <>
      <SettingsRow title="Instructors" description={list(factory.instructors)} />
      <SettingsRow title="Base branch" description={factory.base} />
      <SettingsRow title="Provision" description={list(factory.provision)} />
      <SettingsRow title="Gate" description={list(factory.gate)} />
      <SettingsRow title="Required checks" description={list(factory.required_checks)} />
      <SettingsRow
        title="Limits"
        description={`${limits.minutes} minutes, ${limits.gate_retries} gate retries, ${limits.regates} regates, ${limits.checks_minutes} check minutes, ${limits.interruption_resumes} interruption resumes`}
      />
      <SettingsRow title="Autonomy" description={factory.autonomy} />
    </>
  );
}

/**
 * The watched T3 projects and what the factory last read of each one's `.dw/config.yml`, read-only.
 * A list the factory could not make, or checkouts it could not settle, are said as such: the
 * "none yet" hint is only for a list that really is empty.
 */
export function WatchedRepos({
  repos,
  unresolved,
  watchError,
}: {
  readonly repos: ReadonlyArray<RepoBlock>;
  readonly unresolved: ReadonlyArray<string>;
  readonly watchError: string | null;
}) {
  const none = repos.length === 0 && unresolved.length === 0 && watchError === null;
  return (
    <>
      <SettingsSection title="Watched repos">
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Repos are added as T3 projects: the factory watches every project on this environment
          whose checkout has a .dw/config.yml with a factory block.
          {none ? " No T3 project on this environment has one yet." : null}
        </p>
        {watchError !== null ? (
          <SettingsRow title="T3 projects not listed" description={watchError} />
        ) : null}
        {unresolved.length > 0 ? (
          <SettingsRow
            title="Not settled on the last read"
            description={
              <>
                {unresolved.map((path) => (
                  <span key={path} className="block">
                    <code className="break-all">{path}</code>
                  </span>
                ))}
                <span className="block">
                  The factory could not tell whether these checkouts are watched: a .dw/config.yml
                  that could not be read or parsed, an origin that could not be identified, or a git
                  that would not run. Nothing is dropped for them; their attention items stay, and
                  the next pass reads them again.
                </span>
              </>
            }
          />
        ) : null}
      </SettingsSection>
      {repos.map((block) => (
        <SettingsSection key={`${block.repo} ${block.path}`} title={`Watched repo: ${block.title}`}>
          <SettingsRow title="Repository" description={block.repo} />
          <SettingsRow
            title="Workspace root"
            description={<code className="break-all">{block.path}</code>}
          />
          {block.factory !== null ? <ProjectConfigRows factory={block.factory} /> : null}
          {block.errors !== null ? (
            <SettingsRow
              title="Errors"
              description={block.errors.map((error) => (
                // The description sits in a paragraph, which a list cannot.
                <span key={`${error.file}:${error.field ?? ""}:${error.message}`} className="block">
                  {error.message}
                </span>
              ))}
            />
          ) : null}
          {block.factory === null && block.errors === null ? (
            <SettingsRow
              title="Project config"
              description="Not read yet (the factory reads it on its next pass)"
            />
          ) : null}
          <SettingsRow
            title="Project config on GitHub"
            control={
              <TouchLink
                render={
                  <a
                    href={`https://github.com/${block.repo}/blob/${block.factory?.base ?? "HEAD"}/.dw/config.yml`}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                View .dw/config.yml on GitHub
              </TouchLink>
            }
          />
        </SettingsSection>
      ))}
    </>
  );
}
