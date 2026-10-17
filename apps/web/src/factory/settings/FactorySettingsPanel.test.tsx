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
}));

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
};

const report = (overrides: Partial<MachineConfigReport> = {}): MachineConfigReport => ({
  file: FILE,
  exists: true,
  config: defaultsConfig,
  defaults: defaultsConfig,
  errors: [],
  repos: [],
  unresolved: [],
  watch_error: null,
  ...overrides,
});

const populated = report({
  config: {
    gh_config_dir: "/home/t3/gh",
    poll_seconds: 45,
    max_concurrent_runs: 3,
    max_concurrent_gates: 2,
  },
  repos: [
    {
      repo: "acme/alpha",
      path: "/work/alpha",
      title: "Alpha",
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
      title: "Beta",
      factory: null,
      errors: [{ file: "/work/beta/.dw/config.yml", message: "factory.gate must be a list" }],
    },
    { repo: "acme/gamma", path: "/work/gamma", title: "Gamma", factory: null, errors: null },
  ],
});

const ok = (value: MachineConfigReport): FactoryConfigResult => ({ kind: "ok", report: value });

const textOf = (node: ReactTestInstance | ReactTestRenderer["root"]): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join(" ");

describe("FactorySettingsPanel", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    mocks.canWrite = true;
    mocks.environmentId = "env-1";
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
  const field = (root: ReactTestInstance, name: string) =>
    root.findAll((node) => node.type === "div" && node.props["data-field"] === name)[0];

  const SAVED_KEYS = {
    gh_config_dir: "",
    poll_seconds: 60,
    max_concurrent_runs: 1,
    max_concurrent_gates: 2,
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
    expect(textOf(field(root, "max_concurrent_gates")!)).toContain("must be an integer");

    await type(input(root, "Max concurrent gates"), "3");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      gh_config_dir: "/home/t3/gh",
      poll_seconds: 45,
      max_concurrent_gates: 3,
    });
  });

  it("lists every save error that names no input at the top", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, field: "gh_config_dir", message: "gh dir is bad" },
        { file: FILE, field: "notify", message: "must be true or false" },
        { file: FILE, message: "file level" },
      ],
    });
    const root = await open();

    await click(button(root, "Save"));

    const top = textOf(root.findAll((node) => node.props["data-testid"] === "form-errors")[0]!);
    expect(top).toContain("must be true or false");
    expect(top).toContain("file level");
    expect(top).not.toContain("gh dir is bad");
    expect(textOf(field(root, "gh_config_dir")!)).toContain("gh dir is bad");
  });

  it("fills the form from the file", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(input(root, "GitHub config directory").props.value).toBe("/home/t3/gh");
    expect(input(root, "Poll seconds").props.value).toBe("45");
    expect(input(root, "Max concurrent runs").props.value).toBe("3");
    expect(input(root, "Max concurrent gates").props.value).toBe("2");
  });

  it("lists two projects that name one repo as two blocks, with no duplicate key", async () => {
    const message =
      "2 T3 projects have this repo as their origin (/a, /b); the factory watches none";
    const twice = report({
      repos: [
        {
          repo: "acme/alpha",
          path: "/a",
          title: "Alpha",
          factory: null,
          errors: [{ file: ".dw/config.yml", message }],
        },
        {
          repo: "acme/alpha",
          path: "/b",
          title: "Alpha copy",
          factory: null,
          errors: [{ file: ".dw/config.yml", message }],
        },
      ],
    });
    mocks.fetchFactoryConfig.mockResolvedValue(ok(twice));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const root = await open();
      const text = textOf(root);
      expect(text).toContain("Watched repo: Alpha");
      expect(text).toContain("Watched repo: Alpha copy");
      expect(text.split(message)).toHaveLength(3);
      const duplicateKey = consoleError.mock.calls.filter((call) =>
        String(call[0]).includes("same key"),
      );
      expect(duplicateKey).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("lists the watched projects the API returns, read-only", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    const text = textOf(root);
    expect(text).toContain("Watched repo: Alpha");
    expect(text).toContain("Watched repo: Beta");
    expect(text).toContain("Watched repo: Gamma");
    expect(text).toContain("acme/alpha");
    expect(text).toContain("/work/alpha");
    expect(text).toContain("/work/gamma");
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

    // The hint is there, and the page can neither add nor remove a repo.
    expect(text).toContain("added as T3 projects");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    expect(
      root.findAll((node) => node.type === "button").map((node) => textOf(node).trim()),
    ).toEqual(["Save"]);
    // The errors sit in a paragraph: they are spans, never a list.
    expect(root.findAll((node) => node.type === "ul" || node.type === "li")).toHaveLength(0);
  });

  it("shows the one-line hint when no T3 project is watched", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report()));
    const root = await open();

    const text = textOf(root);
    expect(text).toContain("Repos are added as T3 projects");
    expect(text).toContain("No T3 project on this environment has one yet.");
    expect(text).not.toContain("Watched repo:");
  });

  it("names the checkouts the factory could not settle instead of saying none is watched", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ unresolved: ["/work/slow"] })));
    const root = await open();

    const text = textOf(root);
    expect(text).toContain("Not settled on the last read");
    expect(text).toContain("/work/slow");
    expect(text).toContain("neither watched nor dropped");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    expect(root.findAll((node) => node.type === "ul" || node.type === "li")).toHaveLength(0);
  });

  it("shows why the T3 projects could not be listed instead of saying none is watched", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(report({ watch_error: "cannot list the T3 projects: store down" })),
    );
    const root = await open();

    const text = textOf(root);
    expect(text).toContain("T3 projects not listed");
    expect(text).toContain("cannot list the T3 projects: store down");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    expect(text).not.toContain("Watched repo:");
  });

  it("shows save errors next to the field they name and file errors at the top", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, message: "unknown key: colour" },
        { file: FILE, field: "max_concurrent_runs", message: "must be at least 1" },
        { file: FILE, field: "poll_seconds", message: "must be at least 10" },
      ],
    });
    const root = await open();

    await click(button(root, "Save"));

    const top = root.findAll((node) => node.props["data-testid"] === "form-errors")[0]!;
    expect(textOf(top)).toContain("unknown key: colour");
    expect(textOf(top)).not.toContain("must be at least");
    expect(textOf(field(root, "max_concurrent_runs")!)).toContain("must be at least 1");
    expect(textOf(field(root, "poll_seconds")!)).toContain("must be at least 10");
    expect(textOf(field(root, "max_concurrent_runs")!)).not.toContain("at least 10");
    expect(textOf(root)).not.toContain("Saved");
  });

  it("disables Save for a session that cannot write settings", async () => {
    mocks.canWrite = false;
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    expect(button(root, "Save").props.disabled).toBe(true);
    expect(textOf(root)).toContain("read-only");
  });
  it("gives machine config fields twice the old width", async () => {
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    const root = await open();

    for (const name of ["gh_config_dir", "poll_seconds"]) {
      const className = String(field(root, name)!.props.className);
      expect(className).toContain("sm:w-144");
      expect(className).not.toContain("sm:w-72");
      expect(className).toContain("min-w-0");
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
        // The four machine fields: the watched projects have no inputs.
        expect(inputs).toHaveLength(4);
        expect(inputs.map((node) => node.props.size)).toEqual(inputs.map(() => "touch"));
        const buttons = root.findAll((node) => node.type === "button");
        expect(buttons.map((node) => textOf(node).trim())).toEqual(["Save"]);
      } finally {
        restore();
      }
    });
  });
});
