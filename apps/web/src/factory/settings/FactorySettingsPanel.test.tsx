import {
  AuthSettingsWriteScope,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { viewport } from "../testing";
import type { FactoryConfigResult, MachineConfigReport } from "./api";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  environmentId: "env-1" as string | null,
  prepared: { httpBaseUrl: "http://t3.test", httpAuthorization: null },
  fetchFactoryConfig: vi.fn(),
  saveFactoryConfig: vi.fn(),
  projects: [] as ReadonlyArray<{
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
    isScratch?: boolean;
  }>,
}));

vi.mock("~/state/entities", () => ({ useProjects: () => mocks.projects }));

vi.mock("~/state/session", () => ({
  useEnvironmentScope: (_id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    scope === AuthSettingsWriteScope && mocks.canWrite,
  usePreparedConnection: () => Option.some(mocks.prepared),
}));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: mocks.environmentId === null ? null : { environmentId: mocks.environmentId },
  }),
}));
vi.mock("./api", () => ({
  fetchFactoryConfig: mocks.fetchFactoryConfig,
  saveFactoryConfig: mocks.saveFactoryConfig,
}));
vi.mock("../../components/ui/input", () => ({ Input: "input" }));
vi.mock("../../components/ui/select", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const Value = createContext<unknown>(null);
  return {
    Select: (props: { value: unknown; children?: ReactNode }) =>
      createElement(Value.Provider, { value: props.value }, createElement("select", props)),
    SelectItem: "option",
    SelectPopup: "div",
    SelectTrigger: "select-trigger",
    SelectValue: (props: { children: (value: unknown) => ReactNode }) =>
      createElement("span", null, props.children(useContext(Value))),
  };
});
vi.mock("../../components/ui/button", async () => {
  const { cloneElement } = await import("react");
  return {
    Button: "button",
    InlineButton: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
      cloneElement(render, undefined, children),
  };
});
vi.mock("../../components/settings/settingsLayout", async () => {
  const { createElement } = await import("react");
  return {
    SettingsPageContainer: (props: { children: ReactNode }) =>
      createElement("div", null, props.children),
    SettingsSection: (props: { title: string; headerAction?: ReactNode; children: ReactNode }) =>
      createElement(
        "section",
        null,
        createElement("h2", null, props.title),
        props.headerAction,
        props.children,
      ),
    SettingsRow: (props: {
      title: string;
      description?: ReactNode;
      control?: ReactNode;
      children?: ReactNode;
    }) =>
      createElement(
        "div",
        null,
        createElement("h3", null, props.title),
        props.description,
        props.control,
        props.children,
      ),
  };
});

import { FactorySettingsPanel } from "./FactorySettingsPanel";

const FILE = "/home/t3/factory/config.yml";

const defaultsConfig = {
  gh_config_dir: "",
  poll_seconds: 60,
  max_concurrent_runs: 1,
  max_concurrent_gates: 2,
  repos: [],
};

const report = (overrides: Partial<MachineConfigReport> = {}): MachineConfigReport => ({
  file: FILE,
  exists: true,
  config: defaultsConfig,
  defaults: defaultsConfig,
  errors: [],
  repos: [],
  ...overrides,
});

const populated = report({
  config: {
    gh_config_dir: "/home/t3/gh",
    poll_seconds: 45,
    max_concurrent_runs: 3,
    max_concurrent_gates: 2,
    repos: [
      { repo: "acme/alpha", path: "/work/alpha" },
      { repo: "acme/beta", path: "/work/beta" },
    ],
  },
  repos: [
    {
      repo: "acme/alpha",
      path: "/work/alpha",
      factory: {
        instructors: ["tom"],
        base: "develop",
        provision: ["vp i"],
        gate: ["vp test"],
        required_checks: ["ci"],
        limits: {
          minutes: 90,
          gate_retries: 1,
          regates: 5,
          checks_minutes: 30,
          interruption_resumes: 2,
        },
        autonomy: "pr",
      },
      errors: null,
    },
    {
      repo: "acme/beta",
      path: "/work/beta",
      factory: null,
      errors: [{ file: "/work/beta/.dw/config.yml", message: "factory.gate must be a list" }],
    },
    { repo: "acme/gamma", path: "/work/gamma", factory: null, errors: null },
  ],
});

const PROJECTS = [
  { environmentId: "env-1", id: "p1", title: "Alpha", workspaceRoot: "/work/alpha" },
  { environmentId: "env-1", id: "p2", title: "Beta", workspaceRoot: "/work/beta" },
  {
    environmentId: "env-1",
    id: "p3",
    title: "Scratch",
    workspaceRoot: "/tmp/scratch",
    isScratch: true,
  },
  { environmentId: "env-2", id: "p4", title: "Elsewhere", workspaceRoot: "/work/elsewhere" },
];

const ok = (value: MachineConfigReport): FactoryConfigResult => ({ kind: "ok", report: value });

const textOf = (node: ReactTestInstance | ReactTestRenderer["root"]): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join(" ");

describe("FactorySettingsPanel", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    mocks.canWrite = true;
    mocks.environmentId = "env-1";
    mocks.projects = PROJECTS;
    mocks.fetchFactoryConfig.mockReset();
    mocks.saveFactoryConfig.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  async function open() {
    await act(async () => {
      renderer = create(<FactorySettingsPanel />);
    });
    return renderer!.root;
  }

  const input = (root: ReactTestInstance, label: string) => {
    const found = root.findAll(
      (node) => node.type === "input" && node.props["aria-label"] === label,
    );
    expect(found, `input "${label}"`).toHaveLength(1);
    return found[0]!;
  };
  const button = (root: ReactTestInstance, label: string) => {
    const found = root.findAll(
      (node) =>
        node.type === "button" &&
        (node.props["aria-label"] === label || textOf(node).trim() === label),
    );
    expect(found, `button "${label}"`).toHaveLength(1);
    return found[0]!;
  };
  const type = async (node: ReactTestInstance, value: string) => {
    await act(async () => node.props.onChange({ target: { value } }));
  };
  const click = async (node: ReactTestInstance) => {
    await act(async () => node.props.onClick());
  };
  const projectSelect = (root: ReactTestInstance, index: number) => {
    const found = root.findAll((node) => node.type === "select");
    expect(found.length, `project select ${index + 1}`).toBeGreaterThan(index);
    return found[index]!;
  };
  const field = (root: ReactTestInstance, name: string) =>
    root.findAll((node) => node.type === "div" && node.props["data-field"] === name)[0];

  const SAVED_KEYS = {
    gh_config_dir: "",
    poll_seconds: 60,
    max_concurrent_runs: 1,
    max_concurrent_gates: 2,
    repos: [],
  };

  // #93: the model is picked in T3 (the project's default, else Settings), not on this page.
  it("has no model rows: the page edits no model_instance or model", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(root.findAll((node) => node.props["aria-label"] === "Model instance")).toHaveLength(0);
    expect(root.findAll((node) => node.props["aria-label"] === "Model")).toHaveLength(0);
    expect(textOf(root)).not.toContain("Model");

    await click(button(root, "Save"));
    const sent = mocks.saveFactoryConfig.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "gh_config_dir",
      "max_concurrent_gates",
      "max_concurrent_runs",
      "poll_seconds",
      "repos",
    ]);
  });

  it("shows the defaults when there is no file yet, and saving creates it", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ exists: false })));
    mocks.saveFactoryConfig.mockResolvedValue(ok(report({ exists: true })));
    const root = await open();

    expect(textOf(root)).toContain("No config file exists at");
    expect(textOf(root)).toContain(FILE);
    expect(input(root, "Poll seconds").props.value).toBe("60");
    expect(input(root, "Max concurrent gates").props.value).toBe("2");

    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, SAVED_KEYS);
    expect(textOf(root)).toContain("Saved");
    expect(textOf(root)).not.toContain("No config file exists");
  });

  it("shows a loading state while the config is in flight", async () => {
    mocks.fetchFactoryConfig.mockReturnValue(new Promise(() => {}));
    const root = await open();

    expect(textOf(root)).toContain("Loading");
    expect(root.findAll((node) => node.type === "input")).toHaveLength(0);
  });

  it("shows a load error with a Retry that loads again", async () => {
    mocks.fetchFactoryConfig
      .mockResolvedValueOnce({ kind: "error", message: "the factory is unreachable" })
      .mockResolvedValueOnce(ok(populated));
    const root = await open();

    expect(textOf(root)).toContain("the factory is unreachable");
    expect(root.findAll((node) => node.type === "input")).toHaveLength(0);

    await click(button(root, "Retry"));

    expect(mocks.fetchFactoryConfig).toHaveBeenCalledTimes(2);
    expect(textOf(root)).not.toContain("the factory is unreachable");
    expect(input(root, "Poll seconds").props.value).toBe("45");
  });

  it("lists the errors of an invalid file and still lets the form be fixed", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(
        report({
          config: null,
          errors: [
            { file: FILE, message: "not valid YAML: unexpected end of stream" },
            { file: FILE, field: "poll_seconds", message: "must be a positive integer" },
          ],
        }),
      ),
    );
    mocks.saveFactoryConfig.mockResolvedValue(ok(report()));
    const root = await open();

    expect(textOf(root)).toContain("not valid YAML: unexpected end of stream");
    expect(textOf(root)).toContain("must be a positive integer");
    expect(textOf(field(root, "poll_seconds")!)).toContain("must be a positive integer");

    await type(input(root, "Poll seconds"), "30");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      poll_seconds: 30,
    });
    expect(textOf(root)).not.toContain("not valid YAML");
  });

  it("fills the form of an invalid file from its draft so only the bad field is fixed", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(
        report({
          config: null,
          draft: {
            gh_config_dir: "/home/t3/gh",
            poll_seconds: 45,
            max_concurrent_gates: "two" as unknown as number,
            repos: [{ repo: "acme/alpha", path: "/work/alpha" }, { repo: "acme/beta" }],
          },
          errors: [{ file: FILE, field: "max_concurrent_gates", message: "must be an integer" }],
        }),
      ),
    );
    mocks.saveFactoryConfig.mockResolvedValue(ok(report()));
    const root = await open();

    expect(input(root, "GitHub config directory").props.value).toBe("/home/t3/gh");
    expect(input(root, "Poll seconds").props.value).toBe("45");
    expect(input(root, "Max concurrent runs").props.value).toBe("1");
    expect(input(root, "Repository 1").props.value).toBe("acme/alpha");
    expect(projectSelect(root, 1).props.value).toBeNull();
    expect(textOf(field(root, "max_concurrent_gates")!)).toContain("must be an integer");

    await type(input(root, "Max concurrent gates"), "3");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      gh_config_dir: "/home/t3/gh",
      poll_seconds: 45,
      max_concurrent_gates: 3,
      repos: [
        { repo: "acme/alpha", path: "/work/alpha" },
        { repo: "acme/beta", path: "" },
      ],
    });
  });

  it("lists every save error that names no input at the top", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, field: "gh_config_dir", message: "gh dir is bad" },
        { file: FILE, field: "repos", message: "must not be empty" },
        { file: FILE, field: "repos[0].path", message: "path is bad" },
        { file: FILE, message: "file level" },
      ],
    });
    const root = await open();

    await click(button(root, "Save"));

    const top = textOf(root.findAll((node) => node.props["data-testid"] === "form-errors")[0]!);
    expect(top).toContain("must not be empty");
    expect(top).toContain("file level");
    expect(top).not.toContain("gh dir is bad");
    expect(top).not.toContain("path is bad");
    expect(textOf(field(root, "gh_config_dir")!)).toContain("gh dir is bad");
    expect(textOf(field(root, "repos[0].path")!)).toContain("path is bad");
  });

  it("fills the form from the file and shows each watched repo read-only", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(input(root, "GitHub config directory").props.value).toBe("/home/t3/gh");
    expect(input(root, "Poll seconds").props.value).toBe("45");
    expect(input(root, "Max concurrent runs").props.value).toBe("3");
    expect(input(root, "Repository 1").props.value).toBe("acme/alpha");
    expect(projectSelect(root, 1).props.value).toBe("/work/beta");

    const text = textOf(root);
    expect(text).toContain("tom");
    expect(text).toContain("develop");
    expect(text).toContain("vp test");
    expect(text).toContain("factory.gate must be a list");
    expect(text).toContain("Not read yet");

    const links = root.findAll(
      (node) => node.type === "a" && textOf(node).includes("View .dw/config.yml on GitHub"),
    );
    expect(links.map((link) => link.props.href)).toEqual([
      "https://github.com/acme/alpha/blob/develop/.dw/config.yml",
      "https://github.com/acme/beta/blob/HEAD/.dw/config.yml",
      "https://github.com/acme/gamma/blob/HEAD/.dw/config.yml",
    ]);
  });

  it("shows save errors next to the field they name and file errors at the top", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, message: "unknown key: colour" },
        { file: FILE, field: "repos[1].path", message: "path must be absolute" },
        { file: FILE, field: "poll_seconds", message: "must be at least 1" },
      ],
    });
    const root = await open();

    await click(button(root, "Save"));

    const top = root.findAll((node) => node.props["data-testid"] === "form-errors")[0]!;
    expect(textOf(top)).toContain("unknown key: colour");
    expect(textOf(top)).not.toContain("path must be absolute");
    expect(textOf(field(root, "repos[1].path")!)).toContain("path must be absolute");
    expect(textOf(field(root, "repos[0].path")!)).not.toContain("path must be absolute");
    expect(textOf(field(root, "poll_seconds")!)).toContain("must be at least 1");
    expect(textOf(root)).not.toContain("Saved");
  });

  it("disables Save for a session that cannot write settings", async () => {
    mocks.canWrite = false;
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(button(root, "Save").props.disabled).toBe(true);
    expect(textOf(root)).toContain("read-only");
  });
  it("lists only this environment's projects, with name and workspace root", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    const options = projectSelect(root, 0).findAll((node) => node.type === "option");
    expect(options.map((node) => node.props.value)).toEqual(["/work/alpha", "/work/beta"]);
    expect(textOf(options[0]!)).toContain("Alpha");
    expect(textOf(options[0]!)).toContain("/work/alpha");
    expect(textOf(options[1]!)).toContain("Beta");
    expect(textOf(root)).not.toContain("Scratch");
    expect(textOf(root)).not.toContain("Elsewhere");
  });

  it("writes the chosen project's workspace root into the row and saves it as path", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(textOf(field(root, "repos[0].path")!)).toContain("Alpha");
    await act(async () => projectSelect(root, 0).props.onValueChange("/work/beta"));
    expect(projectSelect(root, 0).props.value).toBe("/work/beta");
    expect(textOf(field(root, "repos[0].path")!)).toContain("Beta");

    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      gh_config_dir: "/home/t3/gh",
      poll_seconds: 45,
      max_concurrent_runs: 3,
      max_concurrent_gates: 2,
      repos: [
        { repo: "acme/alpha", path: "/work/beta" },
        { repo: "acme/beta", path: "/work/beta" },
      ],
    });
  });

  it("keeps a saved path that matches no project, marks it, and saves it unchanged", async () => {
    const orphaned = report({
      config: {
        ...defaultsConfig,
        repos: [{ repo: "acme/alpha", path: "/gone/away" }],
      },
    });
    mocks.fetchFactoryConfig.mockResolvedValue(ok(orphaned));
    mocks.saveFactoryConfig.mockResolvedValue(ok(orphaned));
    const root = await open();

    const shown = textOf(field(root, "repos[0].path")!);
    expect(shown).toContain("/gone/away");
    expect(shown).toContain("not a T3 project");
    expect(projectSelect(root, 0).props.value).toBe("/gone/away");
    const unknown = projectSelect(root, 0)
      .findAll((node) => node.type === "option")
      .find((node) => node.props.value === "/gone/away");
    expect(unknown?.props.disabled).toBe(true);

    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      repos: [{ repo: "acme/alpha", path: "/gone/away" }],
    });
  });

  it("does not mark a path that matches a project", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(textOf(root)).not.toContain("not a T3 project");
  });

  it("starts a new row with no project chosen and saves an empty path", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report()));
    mocks.saveFactoryConfig.mockResolvedValue(ok(report()));
    const root = await open();

    await click(button(root, "Add repo"));

    expect(projectSelect(root, 0).props.value).toBeNull();
    expect(textOf(field(root, "repos[0].path")!)).toContain("Choose a project");
    expect(textOf(root)).not.toContain("not a T3 project");

    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      repos: [{ repo: "", path: "" }],
    });
  });

  it("shows a path error under the project select of the row it names", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [{ file: FILE, field: "repos[1].path", message: "path must be absolute" }],
    });
    const root = await open();

    await click(button(root, "Save"));

    const second = field(root, "repos[1].path")!;
    expect(second.findAll((node) => node.type === "select")).toHaveLength(1);
    expect(textOf(second)).toContain("path must be absolute");
    expect(textOf(field(root, "repos[0].path")!)).not.toContain("path must be absolute");
  });

  it("gives machine config fields twice the old width and splits a repo row 50/50", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    for (const name of ["gh_config_dir", "poll_seconds"]) {
      const className = String(field(root, name)!.props.className);
      expect(className).toContain("sm:w-144");
      expect(className).not.toContain("sm:w-72");
      expect(className).toContain("min-w-0");
    }
    for (const name of ["repos[0].repo", "repos[0].path"]) {
      const className = String(field(root, name)!.props.className);
      expect(className).toContain("sm:flex-1");
      expect(className).toContain("min-w-0");
      expect(className).not.toContain("sm:w-72");
    }
  });

  describe.each([375, 1280])("at %i px", (width) => {
    it("lets a long config path break instead of overflowing", async () => {
      const restore = viewport(width);
      try {
        const long = `/Users/someone/${"deeply/".repeat(12)}.t3/factory/config.yml`;
        mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ exists: false, file: long })));
        const root = await open();
        const holder = root.findAll(
          (node) => typeof node.type === "string" && node.children.includes(long),
        );
        expect(holder).toHaveLength(1);
        expect(String(holder[0]!.props.className)).toContain("break-all");
      } finally {
        restore();
      }
    });

    it("asks for touch-sized inputs, with Save present", async () => {
      const restore = viewport(width);
      try {
        mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
        const root = await open();
        const inputs = root.findAll((node) => node.type === "input");
        // Four machine fields, then a repo for each of the two repos; the path is a select.
        expect(inputs).toHaveLength(6);
        expect(inputs.map((node) => node.props.size)).toEqual(inputs.map(() => "touch"));
        const buttons = root.findAll((node) => node.type === "button");
        expect(buttons.map((node) => textOf(node).trim())).toEqual([
          "Add repo",
          "Remove",
          "Remove",
          "Save",
        ]);
      } finally {
        restore();
      }
    });
  });
});
