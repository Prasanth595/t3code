import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Row image for the native iOS menu. UIMenu only takes images, so a favicon
 * arrives as a sized image source and everything else uses an SF Symbol.
 */
export type HomeListFilterMenuIcon =
  | { readonly type: "sfSymbol"; readonly name: string }
  | {
      readonly type: "imageSource";
      readonly imageSource: {
        readonly uri: string;
        readonly width: number;
        readonly height: number;
        readonly scale: number;
      };
    };

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
  /** Project whose favicon stands for the scope; Android draws it beside the label. */
  readonly representative?: EnvironmentProject;
  /** iOS counterpart of `representative`, resolved by `useProjectFilterMenuIcons`. */
  readonly icon?: HomeListFilterMenuIcon;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly icon?: HomeListFilterMenuIcon;
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          ...(project.icon ? { icon: project.icon } : {}),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}
