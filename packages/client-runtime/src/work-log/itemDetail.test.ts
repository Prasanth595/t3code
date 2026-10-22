import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { toolCallLines, turnItemHasDetail } from "./itemDetail.ts";

const htmlTool = {
  id: TurnItemId.make("tool-html"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__html_preview",
  input: { html: "<h1>Preview</h1>" },
  output: undefined,
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

describe("HTML tool inputs", () => {
  it.each([{}, null, undefined, "", { html: null }])(
    "does not offer an HTML preview when source is missing: %j",
    (args) => {
      expect(toolCallLines({ toolName: "mcp__t3-code__html_preview", args }).html).toBe(false);
    },
  );

  it("keeps blank HTML visible without requesting a preview", () => {
    const html = " \n\t ";
    const lines = toolCallLines({ toolName: "mcp__t3-code__html_preview", args: { html } });
    expect(lines.html).toBe(false);
    expect(lines.args).toEqual([["html", html]]);
  });

  it.each([
    { status: "failed" as const },
    { status: "completed" as const, output: { isError: true } },
    { status: "completed" as const, output: { content: [{ text: '{"isError":true}' }] } },
  ])("keeps failed HTML calls readable for debugging: %j", (failure) => {
    const html = "<style>body{min-height:100vh}</style><h1>Invalid page</h1>";
    const lines = toolCallLines({
      toolName: "mcp__t3-code__html_preview",
      ...failure,
      args: { html },
    });
    expect(lines.html).toBe(false);
    expect(lines.args).toEqual([["html", html]]);
  });
  it.each(["mcp__t3-code__html_preview", "mcp__t3_code__html_render", "t3-code.html_preview"])(
    "presents %s as HTML while retaining other arguments",
    (toolName) => {
      const html = "<!doctype html><h1>Release status</h1>";
      expect(toolCallLines({ toolName, args: { html, width: 728 } })).toEqual({
        command: null,
        html: true,
        args: [["width", "728"]],
        argsText: null,
      });
      expect(turnItemHasDetail({ ...htmlTool, toolName, input: { html }, output: undefined })).toBe(
        true,
      );
    },
  );

  it("keeps HTML arguments of other tools as text", () => {
    const html = "<h1>Example</h1>";
    const lines = toolCallLines({ toolName: "mcp__other__html_preview", args: { html } });
    expect(lines.html).toBe(false);
    expect(lines.args).toEqual([["html", html]]);
  });

  it.each([{ truncated: true, summary: "Large input" }, '{"html":"truncated source…'])(
    "renders HTML through its asset even when detail input is bounded: %j",
    (args) => {
      const lines = toolCallLines({ toolName: "mcp__t3-code__html_preview", args });
      expect(lines.html).toBe(true);
      expect(lines.argsText).toBeNull();
    },
  );
});
