import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const browserTest = createOxlintRuleHarness("t3code/require-disposable-render", {
  filename: "Widget.browser.test.tsx",
});
const unitTest = createOxlintRuleHarness("t3code/require-disposable-render", {
  filename: "widget.test.tsx",
});

describe("t3code/require-disposable-render", () => {
  browserTest.valid(
    "allows the disposable helper",
    [
      'import { act, render } from "../test/render";',
      'import { useState } from "react";',
      'it("renders", async () => {',
      "  await using screen = await render(null);",
      "  await act(() => screen.rerender(null));",
      '  await userEvent.click(screen.getByRole("button"));',
      "  await act(() => store.setState({ open: true }));",
      "});",
    ].join("\n"),
  );
  browserTest.invalid("rejects react-dom/client", 'import { createRoot } from "react-dom/client";');
  browserTest.invalid("rejects act from react", 'import { act } from "react";');
  browserTest.invalid(
    "rejects a renamed act from react",
    'import { act as reactAct } from "react";',
  );
  browserTest.invalid(
    "rejects setting the act environment",
    "globalThis.IS_REACT_ACT_ENVIRONMENT = true;",
  );
  browserTest.invalid(
    "rejects setting the act environment by computed key",
    'window["IS_REACT_ACT_ENVIRONMENT"] = true;',
  );
  browserTest.invalid(
    "rejects stubbing the act environment",
    'vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);',
  );
  browserTest.invalid(
    "rejects userEvent wrapped in act from react",
    [
      'import { act } from "react";',
      'it("clicks", async () => {',
      "  await act(async () => {",
      "    await userEvent.click(document.body);",
      "  });",
      "});",
    ].join("\n"),
    (output) => assert.match(output, /Do not wrap userEvent in React's act/),
  );
  browserTest.invalid(
    "rejects userEvent wrapped in the render helper's act",
    [
      'import { act } from "../../test/render";',
      'it("types", async () => {',
      '  await act(() => userEvent.type(document.body, "a"));',
      "});",
    ].join("\n"),
  );
  browserTest.invalid(
    "rejects userEvent wrapped in a renamed render helper act",
    [
      'import { act as flush } from "../test/render.tsx";',
      'it("clicks", async () => {',
      "  await flush(async () => {",
      "    await userEvent.click(document.body);",
      "  });",
      "});",
    ].join("\n"),
  );
  browserTest.invalid(
    "rejects importing lifecycle hooks from the test runner",
    'import { beforeEach, it } from "vite-plus/test";',
  );
  browserTest.invalid("rejects afterEach", "afterEach(async () => {});");
  browserTest.invalid("rejects beforeAll", "beforeAll(() => {});");
  unitTest.valid("allows lifecycle hooks outside browser tests", "beforeEach(() => {});");
  unitTest.valid(
    "allows importing lifecycle hooks outside browser tests",
    'import { afterEach } from "vite-plus/test";',
  );
  unitTest.invalid("still rejects react-dom/client in unit tests", 'import "react-dom/client";');
});
