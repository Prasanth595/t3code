import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createContext, useContext } from "react";

import "~/index.css";
import { render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const state = vi.hoisted(() => ({ connected: true, tasksLoaded: true }));
const MonthlySchedulingContext = createContext<boolean | undefined>(undefined);

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
}

function environment(monthlySupported?: boolean) {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? {
          environment: {
            platform: "linux",
            capabilities:
              monthlySupported === undefined ? {} : { monthlyScheduledTasks: monthlySupported },
          },
        }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: [entry],
      connectedEnvironments: state.connected ? [entry] : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: () => allowed,
      },
    },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data: request === null ? null : { tasks: state.tasksLoaded ? [task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => environment(useContext(MonthlySchedulingContext))) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });

  it("offers monthly scheduling only when supported and preserves a draft when support is lost", async () => {
    setup();
    await using screen = await render(
      <MonthlySchedulingContext value={undefined}>
        <ScheduledTasksSettings taskId={task.id} />
      </MonthlySchedulingContext>,
    );
    const dialog = page.getByRole("dialog");
    const monthly = dialog.getByRole("button", { name: "Monthly", exact: true });
    await expect.element(monthly).not.toBeInTheDocument();

    await screen.rerender(
      <MonthlySchedulingContext value={true}>
        <ScheduledTasksSettings taskId={task.id} />
      </MonthlySchedulingContext>,
    );
    await userEvent.click(monthly);
    const day = dialog.getByRole("combobox", { name: "Day of month" });
    await userEvent.click(day);
    await userEvent.click(page.getByRole("option", { name: "31", exact: true }));
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "Monthly review");

    await screen.rerender(
      <MonthlySchedulingContext value={false}>
        <ScheduledTasksSettings taskId={task.id} />
      </MonthlySchedulingContext>,
    );
    await expect.element(monthly).toBeDisabled();
    await expect.element(day).toHaveTextContent("31");
    await expect.element(name).toHaveValue("Monthly review");
    await expect
      .element(dialog.getByText("Update T3 Code on this environment to save monthly schedules."))
      .toBeVisible();
    const save = dialog.getByRole("button", { name: "Save task" });
    await expect.element(save).toBeDisabled();

    await userEvent.click(dialog.getByRole("button", { name: "Weekly", exact: true }));
    await expect.element(save).toBeEnabled();
  });
});
