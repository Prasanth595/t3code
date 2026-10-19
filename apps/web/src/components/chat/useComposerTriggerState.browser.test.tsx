import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { replaceTextRange, serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { detectComposerTrigger } from "../../composer-logic";
import { useComposerTriggerState } from "./useComposerTriggerState";

const command = "pnpm install -g @openai/codex@latest";
const initialPrompt = "pnpm install -g @openai";
let root: Root;
let composer: ReturnType<typeof useComposerTriggerState>;

function ComposerProbe({ text = initialPrompt, enabled = true } = {}) {
  const state = useComposerTriggerState(text, enabled);
  useLayoutEffect(() => {
    composer = state;
  });
  return null;
}

async function updatePrompt(text: string, cursor = text.length) {
  await act(() => composer.setTrigger(composer.detectTrigger(text, cursor)));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(() =>
    root.render(
      <StrictMode>
        <ComposerProbe />
      </StrictMode>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("composer suggestion dismissal", () => {
  it.each(["@Foreign", "/plan", "$review", "#123"])(
    "keeps suggestions closed when initialized with the literal answer %s",
    async (text) => {
      await act(() =>
        root.render(<ComposerProbe key="literal-answer" text={text} enabled={false} />),
      );
      expect(composer.trigger).toBeNull();
    },
  );

  it("clears a multi-word search when resetting to a literal answer", async () => {
    await updatePrompt("@Foreign");
    await updatePrompt("@Foreign Subsidiaries");
    expect(composer.trigger?.query).toBe("Foreign Subsidiaries");
    await act(() => composer.resetTrigger(null, "@Literal answer"));
    expect(composer.trigger).toBeNull();
    // Returning to a regular composer must not continue the literal answer as an old search.
    await updatePrompt("@Literal answer more");
    expect(composer.trigger).toBeNull();
  });

  it("continues through spaces and replaces only the mention before closing", async () => {
    const prefix = "Inspect ";
    const suffix = " then summarize";
    for (const query of ["Release", "Release ", "Release Notes.md"]) {
      const beforeCaret = `${prefix}@${query}`;
      await updatePrompt(beforeCaret + suffix, beforeCaret.length);
      expect(composer.trigger).toEqual({
        kind: "path",
        query,
        rangeStart: prefix.length,
        rangeEnd: beforeCaret.length,
      });
    }
    const text = `${prefix}@Release Notes.md${suffix}`;
    const trigger = composer.resolveTrigger(
      composer.detectTrigger(text, text.length - suffix.length),
    );
    expect(trigger).not.toBeNull();
    const result = replaceTextRange(
      text,
      trigger!.rangeStart,
      trigger!.rangeEnd,
      serializeComposerFileLink("docs/Release Notes.md"),
    );
    expect(result.text).toBe("Inspect [Release Notes.md](docs/Release%20Notes.md) then summarize");
    await updatePrompt(result.text, result.cursor);
    expect(composer.trigger).toBeNull();
  });

  it("rejects selection after the caret leaves the query for existing prose", async () => {
    const suffix = " then summarize";
    await updatePrompt("Inspect @Release" + suffix, "Inspect @Release".length);
    const text = "Inspect @Release Notes" + suffix;
    await updatePrompt(text, "Inspect @Release Notes".length);
    expect(composer.trigger?.query).toBe("Release Notes");
    expect(composer.resolveTrigger(composer.detectTrigger(text, text.length))).toBeNull();
    await updatePrompt(text);
    expect(composer.trigger).toBeNull();
    await updatePrompt(text + " more");
    expect(composer.trigger).toBeNull();
  });

  it.each(["\n", "\t"])("closes an active search at a %j boundary", async (boundary) => {
    await updatePrompt("@Release");
    await updatePrompt("@Release Notes");
    expect(composer.trigger?.query).toBe("Release Notes");
    await updatePrompt(`@Release Notes${boundary}`);
    expect(composer.trigger).toBeNull();
    await updatePrompt(`@Release Notes${boundary}more`);
    expect(composer.trigger).toBeNull();
  });

  it("keeps Escape dismissal through spaces until a new mention starts", async () => {
    await updatePrompt("@Release");
    await updatePrompt("@Release Notes");
    const trigger = composer.trigger;
    expect(trigger?.query).toBe("Release Notes");
    await act(() => {
      composer.dismissTrigger(trigger);
      expect(composer.resolveTrigger(trigger)).toBeNull();
    });
    await updatePrompt("@Release Notes ");
    await updatePrompt("@Release Notes draft");
    expect(composer.trigger).toBeNull();
    await updatePrompt("@Release Notes draft @src");
    expect(composer.trigger?.query).toBe("src");
  });

  it("closes suggestions and rejects keyboard selection before the next render", async () => {
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    expect(composer.trigger).toEqual(candidate);

    await act(() => {
      composer.dismissTrigger(candidate);
      expect(composer.resolveTrigger(candidate)).toBeNull();
    });
    expect(composer.trigger).toBeNull();
  });

  it("stays dismissed while typing a scoped package, including its second @", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length; cursor <= command.length; cursor += 1) {
      const text = command.slice(0, cursor);
      await updatePrompt(text);
      expect(composer.trigger).toBeNull();
      expect(composer.resolveTrigger(detectComposerTrigger(text, cursor))).toBeNull();
    }
  });

  it("stays dismissed while deleting characters or moving within the same word", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));

    for (let cursor = initialPrompt.length - 1; cursor > initialPrompt.indexOf("@"); cursor -= 1) {
      await updatePrompt(initialPrompt, cursor);
      expect(composer.trigger).toBeNull();
      await updatePrompt(initialPrompt.slice(0, cursor));
      expect(composer.trigger).toBeNull();
    }
  });

  it("opens suggestions for a new @ word after a space", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} `);
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
    expect(composer.trigger?.rangeStart).toBe(command.length + 1);
  });

  it("opens a different token when the caret moves directly to it", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${command} @src`);

    expect(composer.trigger?.query).toBe("src");
  });

  it("can reopen after the caret leaves the dismissed word", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(initialPrompt, 0);
    await updatePrompt(initialPrompt);

    expect(composer.trigger?.query).toBe("openai");
  });

  it("can reopen at the same position after deleting and retyping @", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    const prefix = initialPrompt.slice(0, initialPrompt.indexOf("@"));
    await updatePrompt(prefix);
    await updatePrompt(`${prefix}@`);

    expect(composer.trigger?.query).toBe("");
  });

  it("clears dismissal when switching drafts or pending questions", async () => {
    await act(() => composer.dismissTrigger(composer.trigger));
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    await act(() => composer.resetTrigger(candidate, initialPrompt));

    expect(composer.trigger).toEqual(candidate);
    expect(composer.resolveTrigger(candidate)).toEqual(candidate);
  });

  it.each(["/plan", "$skill", "#123"])("also dismisses %s suggestions", async (text) => {
    await updatePrompt(text);
    await act(() => composer.dismissTrigger(composer.trigger));
    await updatePrompt(`${text}x`);

    expect(composer.trigger).toBeNull();
    await updatePrompt("@src");
    expect(composer.trigger?.kind).toBe("path");
  });
});
