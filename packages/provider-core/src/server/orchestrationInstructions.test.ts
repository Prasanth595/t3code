import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  resolveAgentInstructions,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

describe("agent instruction overrides", () => {
  it("replaces selected sections, omits empty ones, and restores defaults with null", () => {
    const defaults = resolveAgentInstructions();
    assert.equal(defaults.orchestration, T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.deepEqual(resolveAgentInstructions(null), defaults);
    assert.deepEqual(resolveAgentInstructions({ visuals: null, browser: null }), defaults);
    const resolved = resolveAgentInstructions({
      visuals: "Return a link for standalone artifacts.",
      browser: "",
      devices: "Use the team's device workflow.",
    });
    assert.include(resolved.orchestration, "Return a link for standalone artifacts.");
    assert.notInclude(resolved.orchestration, "### Visuals and preview");
    assert.include(resolved.orchestration, "orchestrator_capabilities");
    assert.equal(resolved.browser, "");
    assert.equal(resolved.devices, "Use the team's device workflow.");
    assert.equal(resolved.devicesWithToolSearch, resolved.devices);
    assert.notInclude(
      resolveAgentInstructions({ orchestration: "" }).orchestration,
      "orchestrator_capabilities",
    );
  });

  it("uses replacements in system, first-prompt and ACP instruction channels", () => {
    const instructionOverrides = {
      orchestration: "Custom coordination.",
      visuals: "",
      devices: "Custom device guidance.",
    };
    const expected = t3OrchestrationSystemPrompt(true, true, instructionOverrides)!;
    assert.include(expected, "Custom coordination.");
    assert.include(expected, "Custom device guidance.");
    assert.notInclude(expected, "html_render");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true, instructionOverrides));
    const cursor = t3OrchestrationPrompt({
      prompt: "Do the work.",
      hasT3Mcp: true,
      hasDeviceTools: true,
      orchestrationDelivered: false,
      deviceInstructionsDelivered: false,
      instructionOverrides,
    });
    assert.include(cursor, expected.trim());
    const acp = t3AcpPromptWithInstructions({
      prompt: "Do the work.",
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true },
      instructionOverrides,
    });
    assert.include(acp, "Custom coordination.");
    assert.include(acp, "Custom device guidance.");
    assert.notInclude(acp, "html_render");
    const lateDevices = t3OrchestrationPrompt({
      prompt: "Use the device.",
      hasT3Mcp: true,
      hasDeviceTools: true,
      orchestrationDelivered: true,
      deviceInstructionsDelivered: false,
      instructionOverrides,
    });
    assert.include(lateDevices, "Custom device guidance.");
    assert.notInclude(lateDevices, "Custom coordination.");
  });
});
