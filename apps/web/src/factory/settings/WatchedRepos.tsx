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

/** What the factory last read of each watched repo's `.dw/config.yml`, read-only. */
export function WatchedRepos({ repos }: { readonly repos: ReadonlyArray<RepoBlock> }) {
  if (repos.length === 0) return null;
  return (
    <>
      {repos.map((block) => (
        <SettingsSection key={block.repo} title={`Watched repo: ${block.repo}`}>
          {block.factory !== null ? <ProjectConfigRows factory={block.factory} /> : null}
          {block.errors !== null ? (
            <SettingsRow
              title="Errors"
              description={
                <ul>
                  {block.errors.map((error) => (
                    <li key={`${error.file}:${error.field ?? ""}:${error.message}`}>
                      {error.message}
                    </li>
                  ))}
                </ul>
              }
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
