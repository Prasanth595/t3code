import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderInstructionsConflictError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      writeProviderInstructions: {
        ...actual.serverEnvironment.writeProviderInstructions,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) =>
    command.label.includes("read-provider-instructions" as string)
      ? state.read
      : state.write) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { ProviderInstructionsSection } from "./ProviderInstructionsSection";

const environmentId = EnvironmentId.make("env");
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project");

const success = (value: unknown) => ({ _tag: "Success", value, waiting: false });
const file = (contents: string, state: string = "ready") =>
  success({
    fileName: "AGENTS.md",
    path: "/work/AGENTS.md",
    contents,
    revision: "10:1",
    state,
  });

function setup() {
  state.read.mockReset();
  state.write.mockReset();
}

const section = () => (
  <RegistryProvider>
    <ProviderInstructionsSection
      environmentId={environmentId}
      instanceId={instanceId}
      projectIds={[projectId]}
      providerLabel="Codex"
      environmentLabel="Laptop"
      readOnly={false}
    />
  </RegistryProvider>
);

it("saves an edit against the revision it opened and keeps CRLF endings", async () => {
  setup();
  state.read.mockResolvedValue(file("one\r\ntwo\r\n"));
  state.write.mockResolvedValue(success({ revision: "20:2", byteLength: 20 }));
  await using _screen = await render(section());

  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  const editor = page.getByRole("textbox", { name: "AGENTS.md contents" });
  await expect.element(editor).toHaveValue("one\ntwo\n");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.fill(editor, "one\ntwo\nthree\n");
  await userEvent.click(page.getByRole("button", { name: "Save" }));

  expect(state.write).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, projectId, contents: "one\r\ntwo\r\nthree\r\n", revision: "10:1" },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the draft on a conflict and reloads the file on request", async () => {
  setup();
  state.read.mockResolvedValueOnce(file("mine")).mockResolvedValueOnce(file("theirs"));
  state.write.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new ProviderInstructionsConflictError()),
    waiting: false,
  });
  await using _screen = await render(section());

  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  const editor = page.getByRole("textbox", { name: "AGENTS.md contents" });
  await userEvent.fill(editor, "mine, edited");
  await userEvent.click(page.getByRole("button", { name: "Save" }));

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(editor).toHaveValue("mine, edited");

  await userEvent.click(page.getByRole("button", { name: "Reload from disk" }));
  await expect
    .element(page.getByRole("textbox", { name: "AGENTS.md contents" }))
    .toHaveValue("theirs");
});

it("offers no editor for a file it cannot edit as text", async () => {
  setup();
  state.read.mockResolvedValue(file("", "too_large"));
  await using _screen = await render(section());

  await userEvent.click(page.getByRole("button", { name: "Edit" }));

  await expect.element(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
});
