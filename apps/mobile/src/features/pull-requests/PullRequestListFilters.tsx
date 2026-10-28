import { sortProjectsByGroupOrder } from "@t3tools/client-runtime/state/project-grouping";
import { useMemo } from "react";
import { Platform, ScrollView } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { usePublishPullRequestFilterMenu } from "./PullRequestFilterMenuContext";
import { useProjects, useThreadShells } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "../home/homeThreadList";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";

const STATES = {
  open: "Deschise",
  closed: "Închise",
  merged: "Îmbinate",
  all: "Toate stările",
} as const;
const INVOLVEMENT = {
  all: "Toate PR-urile",
  reviewing: "Revizuirea ta",
  authored: "De tine",
} as const;
const DRAFTS = { all: "Toate ciornele", only: "Doar ciorne", hide: "Ascunde ciornele" } as const;
const REVIEWS = {
  all: "Toate revizuirile",
  approved: "Aprobate",
  "changes-requested": "Modificări cerute",
  "review-required": "Revizuire necesară",
  none: "Fără revizuiri",
} as const;
const CHECKS = { all: "Toate verificările", passing: "Trec", failing: "Eșuează" } as const;
const SORTS = {
  updated: "Actualizate recent",
  created: "Create recent",
  oldest: "Actualizate cel mai demult",
} as const;
// A 12dp inset keeps 16dp chips concentric with Android's 28dp ScreenContent corner.
const ROW_STYLE =
  Platform.OS === "android"
    ? { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, gap: 8 }
    : { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 };
const id = (field: string, value: string) => JSON.stringify([field, value]);
function choices(field: string, options: Readonly<Record<string, string>>, selected: string) {
  return Object.entries(options).map(([value, title]) => ({
    id: id(field, value),
    title,
    state: value === selected ? ("on" as const) : ("off" as const),
  }));
}

function useProjectsInSidebarOrder<Project extends { id: string; environmentId: string }>(
  projects: readonly Project[],
) {
  const allProjects = useProjects();
  const threads = useThreadShells();
  const { sidebarProjectGroupingMode } = useMobileProjectGroupingSettings();
  const scopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects: allProjects,
          environmentId: null,
          projectGroupingMode: sidebarProjectGroupingMode,
        }),
        threads,
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }).map((scope) => ({ memberProjectRefs: scope.projectRefs })),
    [allProjects, sidebarProjectGroupingMode, threads],
  );
  return useMemo(() => sortProjectsByGroupOrder(projects, scopes), [projects, scopes]);
}

export function PullRequestListFilters(props: {
  /** Android sidebar rows sit further in than full-width rows; the pills follow them. */
  readonly sidebar?: boolean;
  readonly environments: readonly { id: string; label: string }[];
  readonly environmentId: string | null;
  readonly onEnvironmentChange: (id: string | null) => void;
  readonly value: PullRequestListControls;
  readonly onChange: (value: PullRequestListControls) => void;
  readonly authors: readonly string[];
  readonly labels: readonly string[];
  /** Dot colors by lowercased label name, for the labels that have one. */
  readonly labelColors: Readonly<Record<string, string>>;
  readonly projects: readonly { id: string; title: string; environmentId: string }[];
  /** Opens a picker that searches the host, for a label or author no loaded row carries. */
  readonly onSearch: (kind: "labels" | "authors") => void;
}) {
  const { value } = props;
  const projects = useProjectsInSidebarOrder(props.projects);
  const selectedLabels = value.filters.labels?.flat() ?? [];
  const selectedLabelSet = new Set(selectedLabels);
  const author = value.filters.author;
  const select = (event: string) => {
    let selection: unknown;
    try {
      selection = JSON.parse(event);
    } catch {
      return;
    }
    if (
      !Array.isArray(selection) ||
      selection.length !== 2 ||
      typeof selection[0] !== "string" ||
      typeof selection[1] !== "string"
    )
      return;
    const [field, next] = selection;
    switch (field) {
      case "environment":
        if (next === "") props.onEnvironmentChange(null);
        else if (props.environments.some((environment) => environment.id === next))
          props.onEnvironmentChange(next);
        break;
      case "reset":
        props.onChange(DEFAULT_PR_LIST_CONTROLS);
        // The Android header menu also holds the environment, so its reset clears that too.
        if (next === "environment") props.onEnvironmentChange(null);
        break;
      case "state":
        props.onChange({ ...value, state: next as PullRequestListControls["state"] });
        break;
      case "involvement":
        props.onChange({ ...value, involvement: next as PullRequestListControls["involvement"] });
        break;
      case "sort":
        props.onChange({ ...value, sort: next as PullRequestListControls["sort"] });
        break;
      case "project": {
        const project = projects.find(
          (project) => JSON.stringify([project.environmentId, project.id]) === next,
        );
        props.onChange({
          ...value,
          projectId: project?.id,
          projectEnvironmentId: project?.environmentId,
        });
        break;
      }
      case "label": {
        const labels = selectedLabels.includes(next)
          ? selectedLabels.filter((label) => label !== next)
          : [...selectedLabels, next].slice(0, 10);
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            labels: labels.length ? labels.map((label) => [label]) : undefined,
          },
        });
        break;
      }
      case "labels":
        props.onChange({ ...value, filters: { ...value.filters, labels: undefined } });
        break;
      case "author":
        props.onChange({ ...value, filters: { ...value.filters, author: next || undefined } });
        break;
      case "search":
        if (next === "labels" || next === "authors") props.onSearch(next);
        break;
      case "draft":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            draft: next === "all" ? undefined : (next as "only" | "hide"),
          },
        });
        break;
      case "review":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            review:
              next === "all"
                ? undefined
                : (next as NonNullable<PullRequestListControls["filters"]["review"]>),
          },
        });
        break;
      case "checks":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            checks: next === "all" ? undefined : (next as "passing" | "failing"),
          },
        });
        break;
    }
  };
  const count =
    Number(value.state !== "open") +
    Number(value.involvement !== "all") +
    Number(Boolean(author)) +
    selectedLabels.length +
    Number(Boolean(value.filters.draft)) +
    Number(Boolean(value.filters.review)) +
    Number(Boolean(value.filters.checks)) +
    Number(Boolean(value.projectId));
  const more: MenuProps["actions"] = [
    {
      id: "drafts",
      title: value.filters.draft ? DRAFTS[value.filters.draft] : "Ciorne",
      subactions: choices("draft", DRAFTS, value.filters.draft ?? "all"),
    },
    {
      id: "reviews",
      title: value.filters.review ? REVIEWS[value.filters.review] : "Revizuiri",
      subactions: choices("review", REVIEWS, value.filters.review ?? "all"),
    },
    {
      id: "checks",
      title: value.filters.checks ? `Verificări: ${CHECKS[value.filters.checks]}` : "Verificări",
      subactions: choices("checks", CHECKS, value.filters.checks ?? "all"),
    },
    {
      id: "projects",
      title:
        projects.find(
          (project) =>
            project.id === value.projectId && project.environmentId === value.projectEnvironmentId,
        )?.title ?? "Proiect",
      subactions: choices(
        "project",
        Object.fromEntries([
          ["", "Toate proiectele"],
          ...projects.map((project) => [
            JSON.stringify([project.environmentId, project.id]),
            project.title,
          ]),
        ]),
        value.projectId ? JSON.stringify([value.projectEnvironmentId, value.projectId]) : "",
      ),
    },
    { id: "sort", title: SORTS[value.sort], subactions: choices("sort", SORTS, value.sort) },
  ];
  const reset = (withEnvironment: boolean): MenuProps["actions"][number] => ({
    id: id("reset", withEnvironment ? "environment" : ""),
    title: "Resetează filtrele",
    attributes: {
      disabled:
        count === 0 &&
        value.sort === "updated" &&
        (!withEnvironment || props.environmentId === null),
    },
  });
  const labels = [...new Set([...selectedLabels, ...props.labels])].slice(0, 60);
  const authors = [
    ...new Set([...(author && author !== "me" ? [author] : []), ...props.authors]),
  ].slice(0, 60);
  const environmentActions = choices(
    "environment",
    Object.fromEntries([
      ["", "Toate mediile"],
      ...props.environments.map((environment) => [environment.id, environment.label]),
    ]),
    props.environmentId ?? "",
  );
  const stateActions = choices("state", STATES, value.state);
  const involvementActions = choices("involvement", INVOLVEMENT, value.involvement);
  const labelActions: MenuProps["actions"] = [
    { id: id("search", "labels"), title: "Caută etichete…", image: "magnifyingglass" },
    {
      id: id("labels", ""),
      title: "Toate etichetele",
      state: selectedLabels.length ? "off" : "on",
    },
    ...labels.map((label) => {
      const color = props.labelColors[label.toLowerCase()];
      return {
        id: id("label", label),
        title: label,
        state: selectedLabelSet.has(label) ? ("on" as const) : ("off" as const),
        ...(color ? { image: "circle.fill", imageColor: color } : {}),
      };
    }),
  ];
  const authorActions: MenuProps["actions"] = [
    { id: id("search", "authors"), title: "Caută autori…", image: "magnifyingglass" },
    ...choices(
      "author",
      Object.fromEntries([
        ["", "Toți autorii"],
        ["me", "Eu"],
        ...authors.map((login) => [login, login]),
      ]),
      author ?? "",
    ),
  ];
  const customized = count > 0 || value.sort !== "updated" || props.environmentId !== null;
  // The Android header's filter button opens every filter.
  const headerMenu =
    Platform.OS === "android"
      ? {
          actions: [
            { id: "environment", title: "Mediu", subactions: environmentActions },
            { id: "state", title: "Stare", subactions: stateActions },
            { id: "involvement", title: "Implicare", subactions: involvementActions },
            { id: "labels", title: "Etichete", subactions: labelActions },
            { id: "author", title: "Autor", subactions: authorActions },
            ...more,
            reset(true),
          ],
          onSelect: select,
          customized,
        }
      : null;
  usePublishPullRequestFilterMenu(headerMenu);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // In the Android sidebar the first pill lines up with the rows' content instead
      // (8dp row margin + 12dp padding).
      contentContainerStyle={
        props.sidebar && Platform.OS === "android"
          ? { ...ROW_STYLE, paddingHorizontal: 20 }
          : ROW_STYLE
      }
    >
      {Platform.OS === "android" ? null : (
        <ListFilterMenu
          label={count ? String(count) : "Filtre"}
          icon
          active={count > 0}
          accessibilityLabel={count ? `Filtre, ${count} active` : "Mai multe filtre"}
          actions={[...more, reset(false)]}
          onSelect={select}
        />
      )}
      {props.environments.length > 1 ? (
        <ListFilterMenu
          label={
            props.environments.find((environment) => environment.id === props.environmentId)
              ?.label ?? "Toate mediile"
          }
          accessibilityLabel="Alege mediul pull request-urilor"
          actions={environmentActions}
          onSelect={select}
        />
      ) : null}
      <ListFilterMenu
        label={STATES[value.state]}
        active={value.state !== "open"}
        accessibilityLabel="Filtrează după stare"
        actions={stateActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={INVOLVEMENT[value.involvement]}
        active={value.involvement !== "all"}
        accessibilityLabel="Filtrează după implicare"
        actions={involvementActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={selectedLabels.length ? `Etichete ${selectedLabels.length}` : "Etichete"}
        active={selectedLabels.length > 0}
        accessibilityLabel="Filtrează după etichetă"
        actions={labelActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={author === "me" ? "De tine" : (author ?? "Autor")}
        active={Boolean(author)}
        accessibilityLabel="Filtrează după autor"
        actions={authorActions}
        onSelect={select}
      />
    </ScrollView>
  );
}
