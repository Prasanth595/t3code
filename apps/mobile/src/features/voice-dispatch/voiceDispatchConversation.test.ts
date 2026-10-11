import { describe, expect, it } from "vite-plus/test";

import { spokenProjectNames } from "./spokenProjectMatch";
import {
  runVoiceDispatch,
  VOICE_BUTTON,
  type ListenOutcome,
  type VoiceDispatchIO,
  type VoiceDispatchProject,
} from "./voiceDispatchConversation";

function project(title: string): VoiceDispatchProject {
  return { key: `env/${title}`, title, subtitle: null, spokenNames: spokenProjectNames({ title }) };
}

const t3code = project("t3code");
const autogpt = project("AutoGPT");

/** A car display that answers each listen with the next scripted outcome. */
function scriptedCar(
  answers: ReadonlyArray<ListenOutcome>,
  options: { readonly choose?: VoiceDispatchProject | null } = {},
) {
  const remaining = [...answers];
  const spoken: string[] = [];
  const titles: string[] = [];
  const listChoices: string[][] = [];
  const io: VoiceDispatchIO = {
    showPrompt: (prompt) => {
      titles.push(prompt.title);
    },
    speak: async (text) => {
      spoken.push(text);
    },
    listen: async () => {
      const next = remaining.shift();
      if (!next) throw new Error("listened more often than scripted");
      return next;
    },
    chooseProject: async (projects) => {
      listChoices.push(projects.map((candidate) => candidate.title));
      return options.choose ?? null;
    },
  };
  return { io, spoken, titles, listChoices, remaining };
}

const speech = (transcript: string): ListenOutcome => ({ type: "speech", transcript });
const tap = (button: { readonly id: string }): ListenOutcome => ({
  type: "button",
  buttonId: button.id,
});

describe("runVoiceDispatch", () => {
  it("asks for a project, a request, and a confirmation before starting", async () => {
    const car = scriptedCar([
      speech("T three code"),
      speech("Add a dark mode toggle to settings"),
      speech("yes"),
    ]);
    const started: Array<[string, string]> = [];

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code, autogpt],
      startThread: async (target, request) => {
        started.push([target.title, request]);
        return "started" as const;
      },
    });

    expect(outcome).toEqual({
      type: "started",
      project: t3code,
      request: "Add a dark mode toggle to settings",
    });
    expect(started).toEqual([["t3code", "Add a dark mode toggle to settings"]]);
    expect(car.spoken).toEqual([
      "Which project?",
      "What do you want to build in t3code?",
      "Add a dark mode toggle to settings. Should I start it?",
      "Started in t3code.",
    ]);
    expect(car.titles.at(-1)).toBe("Thread started");
  });

  it("skips the project question when only one project is connected", async () => {
    const car = scriptedCar([speech("Fix the flaky login test"), tap(VOICE_BUTTON.start)]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [autogpt],
      startThread: async () => "started" as const,
    });

    expect(outcome).toMatchObject({ type: "started", project: autogpt });
    expect(car.spoken[0]).toBe("What do you want to build in AutoGPT?");
  });

  it("falls back to the project list when the answer names no project", async () => {
    const car = scriptedCar([speech("the grocery list"), speech("Ship it"), speech("yes")], {
      choose: autogpt,
    });

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code, autogpt],
      startThread: async () => "started" as const,
    });

    expect(outcome).toMatchObject({ type: "started", project: autogpt, request: "Ship it" });
    expect(car.spoken[1]).toBe("I couldn't find the grocery list. Pick a project.");
    expect(car.listChoices).toEqual([["t3code", "AutoGPT"]]);
  });

  it("does not start anything when the driver says no", async () => {
    const car = scriptedCar([speech("t3code"), speech("Rewrite everything"), speech("no")]);
    let started = false;

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code, autogpt],
      startThread: async () => {
        started = true;
        return "started" as const;
      },
    });

    expect(outcome).toEqual({ type: "cancelled" });
    expect(started).toBe(false);
    expect(car.spoken.at(-1)).toBe("Okay, cancelled.");
  });

  it("re-asks once for an unclear confirmation, then gives up without starting", async () => {
    const car = scriptedCar([
      speech("t3code"),
      speech("Bump the version"),
      speech("hmm"),
      { type: "no-speech" },
    ]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code, autogpt],
      startThread: async () => {
        throw new Error("should not start");
      },
    });

    expect(outcome).toEqual({ type: "cancelled" });
    expect(car.spoken).toContain("Should I start it? Say yes or no.");
  });

  it("reads back only the start of a long request", async () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const car = scriptedCar([speech(long), speech("yes")]);

    await runVoiceDispatch({
      io: car.io,
      projects: [t3code],
      startThread: async () => "started" as const,
    });

    expect(car.spoken[1]).toMatch(/^word0 .* word29, and so on\. Should I start it\?$/);
  });

  it("reports a failed start so the driver can retry without dictating again", async () => {
    const car = scriptedCar([speech("Update the docs"), speech("yes")]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code],
      startThread: async () => {
        throw new Error("t3code is offline.");
      },
    });

    expect(outcome).toEqual({
      type: "failed",
      project: t3code,
      request: "Update the docs",
      message: "t3code is offline.",
    });
    expect(car.spoken.at(-1)).toBe("I couldn't start the thread. t3code is offline.");
  });

  it("tells the driver when the thread waits for its environment", async () => {
    const car = scriptedCar([speech("Rename the button"), speech("yes")]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code],
      startThread: async () => "queued" as const,
    });

    expect(outcome).toMatchObject({ type: "queued", project: t3code });
    expect(car.spoken.at(-1)).toBe("Queued. It starts when t3code reconnects.");
  });

  it("retries a failed request without asking again", async () => {
    const car = scriptedCar([]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [t3code, autogpt],
      retry: { project: autogpt, request: "Update the docs" },
      startThread: async () => "started" as const,
    });

    expect(outcome).toEqual({ type: "started", project: autogpt, request: "Update the docs" });
    expect(car.spoken).toEqual(["Started in AutoGPT."]);
  });

  it("stops quietly when the car disconnects mid-conversation", async () => {
    const controller = new AbortController();
    const car = scriptedCar([speech("t3code")]);
    const io: VoiceDispatchIO = {
      ...car.io,
      listen: async (request) => {
        const outcome = await car.io.listen(request);
        controller.abort();
        return outcome;
      },
    };

    const outcome = await runVoiceDispatch({
      io,
      projects: [t3code, autogpt],
      startThread: async () => "started" as const,
      signal: controller.signal,
    });

    expect(outcome).toEqual({ type: "cancelled" });
    expect(car.spoken).toEqual(["Which project?"]);
  });

  it("tells the driver when no projects are available", async () => {
    const car = scriptedCar([]);

    const outcome = await runVoiceDispatch({
      io: car.io,
      projects: [],
      startThread: async () => "started" as const,
    });

    expect(outcome).toEqual({ type: "no-projects" });
    expect(car.spoken).toEqual([
      "No T3 Code projects are connected. Open T3 Code on your iPhone first.",
    ]);
  });
});
