import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions, withUserDevice } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});

describe("withUserDevice", () => {
  it("names a same-machine sender with every known detail", () => {
    expect(
      withUserDevice("open the app", {
        label: "T3 Code\nDesktop",
        os: "macOS",
        deviceType: "desktop",
        surface: "desktop",
        sameMachine: true,
      }),
    ).toBe(
      '<user_device>The user sent this message from "T3 Code Desktop" (macOS desktop, desktop) on this machine.</user_device>\n\nopen the app',
    );
  });

  it("names the remote host, or says it is unknown", () => {
    expect(
      withUserDevice("hi", {
        deviceType: "mobile",
        os: "iOS",
        sameMachine: false,
        hostName: "phone.tailnet.ts.net",
      }),
    ).toBe(
      "<user_device>The user sent this message from a device (iOS mobile) on another machine (phone.tailnet.ts.net).</user_device>\n\nhi",
    );
    expect(withUserDevice("hi", { deviceType: "unknown", sameMachine: false })).toBe(
      "<user_device>The user sent this message from an unknown device on another machine (unknown host).</user_device>\n\nhi",
    );
  });

  it("leaves messages without a sender and slash commands unchanged", () => {
    expect(withUserDevice("hi", undefined)).toBe("hi");
    expect(withUserDevice("  /compact", { deviceType: "desktop", sameMachine: true })).toBe(
      "  /compact",
    );
  });
});
