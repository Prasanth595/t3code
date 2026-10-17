import { AuthSettingsWriteScope } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjects } from "~/state/entities";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import {
  fetchFactoryConfig,
  saveFactoryConfig,
  type ConfigError,
  type MachineConfigReport,
  type MachineConfigValues,
} from "./api";
import { WatchedRepos } from "./WatchedRepos";

/** The form keeps numbers as typed, so an empty or half-typed field is not coerced under the cursor. */
interface FormState {
  readonly gh_config_dir: string;
  readonly poll_seconds: string;
  readonly max_concurrent_runs: string;
  readonly max_concurrent_gates: string;
  readonly repos: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
}

const EMPTY_FORM: FormState = {
  gh_config_dir: "",
  poll_seconds: "",
  max_concurrent_runs: "",
  max_concurrent_gates: "",
  repos: [],
};

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** The file's values, or when it does not load the defaults under whatever the file does hold. */
const formOf = (report: MachineConfigReport): FormState => {
  const source = report.config ?? { ...report.defaults, ...report.draft };
  return {
    gh_config_dir: text(source.gh_config_dir),
    poll_seconds: text(source.poll_seconds),
    max_concurrent_runs: text(source.max_concurrent_runs),
    max_concurrent_gates: text(source.max_concurrent_gates),
    repos: (source.repos ?? []).map((row) => ({ repo: text(row.repo), path: text(row.path) })),
  };
};

const toNumber = (text: string) => (text.trim() === "" ? null : Number(text));

const valuesOf = (form: FormState): MachineConfigValues => ({
  gh_config_dir: form.gh_config_dir,
  poll_seconds: toNumber(form.poll_seconds),
  max_concurrent_runs: toNumber(form.max_concurrent_runs),
  max_concurrent_gates: toNumber(form.max_concurrent_gates),
  repos: form.repos.map(({ repo, path }) => ({ repo, path })),
});

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly report: MachineConfigReport };

type SaveStatus = "idle" | "saving" | "saved";

/** `repos[2].path` and `poll_seconds` are the field names the server reports; the wrapper's key. */
const fieldKey = (error: ConfigError) => error.field?.replace(/\s/g, "");

function FieldErrors({
  name,
  errors,
}: {
  readonly name: string;
  readonly errors: ReadonlyArray<ConfigError>;
}) {
  return errors
    .filter((error) => fieldKey(error) === name)
    .map((error) => (
      <p key={error.message} role="alert" className="text-xs text-destructive-foreground">
        {error.message}
      </p>
    ));
}

/** A machine config field is a fixed width; a repo row's field shares the row's width with its sibling. */
function Field({
  name,
  errors,
  children,
  grow = false,
}: {
  readonly name: string;
  readonly errors: ReadonlyArray<ConfigError>;
  readonly children: React.ReactNode;
  readonly grow?: boolean;
}) {
  return (
    <div
      data-field={name}
      className={`flex w-full min-w-0 flex-col gap-1 ${grow ? "sm:flex-1 sm:basis-0" : "sm:w-144"}`}
    >
      {children}
      <FieldErrors name={name} errors={errors} />
    </div>
  );
}

/** A saved path that no T3 project on the environment has as its root. */
const unknownPath = (path: string, projects: ReadonlyArray<{ readonly workspaceRoot: string }>) =>
  path !== "" && !projects.some((project) => project.workspaceRoot === path);

/** A repo's inputs and Remove stack on a phone and sit in a row from `sm`. */
const REPO_ROW =
  "flex flex-col items-stretch gap-2 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-start sm:px-4";

export function FactorySettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<ReadonlyArray<ConfigError>>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  // The connection object is replaced when a credential renews; a reload then would drop edits.
  const preparedRef = useRef(prepared);
  preparedRef.current = prepared;
  const hasConnection = prepared !== null;

  const show = (report: MachineConfigReport) => {
    setLoad({ status: "ready", report });
    setForm(formOf(report));
    setErrors(report.errors);
  };

  useEffect(() => {
    const connection = preparedRef.current;
    if (connection === null) return;
    let current = true;
    setLoad({ status: "loading" });
    void fetchFactoryConfig(connection).then((result) => {
      if (!current) return;
      if (result.kind === "ok") {
        show(result.report);
      } else {
        setLoad({
          status: "error",
          message:
            result.kind === "error"
              ? result.message
              : result.kind === "forbidden"
                ? "This session is not allowed to read the factory config."
                : "The factory config could not be read.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [environmentId, hasConnection, attempt]);

  const edit = (change: (form: FormState) => FormState) => {
    setForm(change);
    setSaveStatus("idle");
  };
  const setText =
    (key: Exclude<keyof FormState, "repos">) => (event: { target: { value: string } }) =>
      edit((current) => ({ ...current, [key]: event.target.value }));
  const editRepo = (index: number, key: "repo" | "path", value: string) =>
    edit((current) => ({
      ...current,
      repos: current.repos.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    }));
  const setRepo = (index: number, key: "repo" | "path") => (event: { target: { value: string } }) =>
    editRepo(index, key, event.target.value);
  // Removing or adding a row moves every index after it, so field errors by index no longer line up.
  const reshapeRepos = (change: (repos: FormState["repos"]) => FormState["repos"]) => {
    edit((current) => ({ ...current, repos: change(current.repos) }));
    setErrors((current) => current.filter((error) => !error.field?.startsWith("repos")));
  };

  const save = async () => {
    const connection = preparedRef.current;
    if (connection === null || !canWrite) return;
    setSaveStatus("saving");
    setSaveFailure(null);
    const result = await saveFactoryConfig(connection, valuesOf(form));
    if (result.kind === "ok") {
      show(result.report);
      setSaveStatus("saved");
      return;
    }
    setSaveStatus("idle");
    if (result.kind === "invalid") {
      setErrors(result.errors);
    } else {
      setSaveFailure(
        result.kind === "forbidden"
          ? "This session is not allowed to change settings."
          : result.message,
      );
    }
  };

  if (environmentId === null || !hasConnection) {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Select an environment to edit its factory settings.
        </p>
      </SettingsPageContainer>
    );
  }

  if (load.status === "loading") {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">Loading the machine config</p>
      </SettingsPageContainer>
    );
  }

  if (load.status === "error") {
    return (
      <SettingsPageContainer>
        <div className="flex flex-wrap items-center gap-3 px-3 text-sm sm:px-4">
          <p role="alert" className="text-destructive-foreground">
            {load.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      </SettingsPageContainer>
    );
  }

  const { report } = load;
  // An error that names no rendered input would otherwise show nowhere.
  const inputNames = new Set<string>([
    "gh_config_dir",
    "poll_seconds",
    "max_concurrent_runs",
    "max_concurrent_gates",
    ...form.repos.flatMap((_, index) => [`repos[${index}].repo`, `repos[${index}].path`]),
  ]);
  const topErrors = errors.filter((error) => !inputNames.has(fieldKey(error) ?? ""));
  const saving = saveStatus === "saving";

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-2 px-3 text-sm sm:px-4">
        {!report.exists ? (
          <p className="min-w-0 text-muted-foreground">
            No config file exists at <code className="break-all">{report.file}</code>. Saving
            creates it.
          </p>
        ) : null}
        {!canWrite ? (
          <p className="text-muted-foreground">
            This session is read-only: it cannot change the factory settings.
          </p>
        ) : null}
        {topErrors.length > 0 ? (
          <ul data-testid="form-errors" className="list-disc pl-5 text-destructive-foreground">
            {topErrors.map((error) => (
              <li key={`${error.field ?? ""}:${error.message}`}>{error.message}</li>
            ))}
          </ul>
        ) : null}
        {saveFailure !== null ? (
          <p role="alert" className="text-destructive-foreground">
            {saveFailure}
          </p>
        ) : null}
      </div>

      <SettingsSection title="Machine config">
        <SettingsRow
          title="GitHub config directory"
          description="Where the factory's gh credentials live."
          control={
            <Field name="gh_config_dir" errors={errors}>
              <Input
                size="touch"
                font="mono"
                aria-label="GitHub config directory"
                value={form.gh_config_dir}
                onChange={setText("gh_config_dir")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Poll seconds"
          description="How often the factory looks at GitHub."
          control={
            <Field name="poll_seconds" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Poll seconds"
                value={form.poll_seconds}
                onChange={setText("poll_seconds")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Max concurrent runs"
          control={
            <Field name="max_concurrent_runs" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Max concurrent runs"
                value={form.max_concurrent_runs}
                onChange={setText("max_concurrent_runs")}
              />
            </Field>
          }
        />
        <SettingsRow
          title="Max concurrent gates"
          control={
            <Field name="max_concurrent_gates" errors={errors}>
              <Input
                size="touch"
                type="number"
                aria-label="Max concurrent gates"
                value={form.max_concurrent_gates}
                onChange={setText("max_concurrent_gates")}
              />
            </Field>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Repos"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={() => reshapeRepos((repos) => [...repos, { repo: "", path: "" }])}
          >
            Add repo
          </Button>
        }
      >
        {form.repos.map((row, index) => (
          // Rows have no identity beyond their position, which is also how the server names them.
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className={REPO_ROW}>
            <Field name={`repos[${index}].repo`} errors={errors} grow>
              <Input
                size="touch"
                placeholder="owner/name"
                aria-label={`Repository ${index + 1}`}
                value={row.repo}
                onChange={setRepo(index, "repo")}
              />
            </Field>
            <Field name={`repos[${index}].path`} errors={errors} grow>
              <Select
                value={row.path === "" ? null : row.path}
                onValueChange={(value) => editRepo(index, "path", value ?? "")}
              >
                <SelectTrigger aria-label={`Project ${index + 1}`}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === null
                        ? "Choose a project"
                        : (projects.find((project) => project.workspaceRoot === value)?.title ??
                          `${value} (not a T3 project)`)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.workspaceRoot}>
                      {project.title}{" "}
                      <span className="text-muted-foreground">{project.workspaceRoot}</span>
                    </SelectItem>
                  ))}
                  {unknownPath(row.path, projects) ? (
                    <SelectItem value={row.path} disabled>
                      {row.path} (not a T3 project)
                    </SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
              {unknownPath(row.path, projects) ? (
                <p className="text-xs text-muted-foreground">
                  Not a T3 project on this environment, so the factory cannot launch there.
                </p>
              ) : null}
            </Field>
            <Button
              size="xs"
              variant="ghost-destructive"
              aria-label={`Remove repo ${index + 1}`}
              onClick={() => reshapeRepos((repos) => repos.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        {form.repos.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">No repos are watched.</p>
        ) : null}
      </SettingsSection>

      <div className="flex items-center gap-3 px-3 sm:px-4">
        <Button size="sm" disabled={!canWrite || saving} onClick={() => void save()}>
          Save
        </Button>
        {saveStatus === "saved" ? (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>

      <WatchedRepos repos={report.repos} />
    </SettingsPageContainer>
  );
}
