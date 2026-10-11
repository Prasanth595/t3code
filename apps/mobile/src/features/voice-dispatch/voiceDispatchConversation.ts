import {
  matchSpokenProject,
  parseSpokenConfirmation,
  type SpokenProjectCandidate,
} from "./spokenProjectMatch";

/** A project the driver can send a voice note to. */
export interface VoiceDispatchProject extends SpokenProjectCandidate {
  /** Stable across launches: `${environmentId}/${projectId}`. */
  readonly key: string;
  readonly title: string;
  /** Environment label, shown when projects come from several environments. */
  readonly subtitle: string | null;
}

export interface VoicePromptButton {
  readonly id: string;
  readonly title: string;
  /** SF Symbol name. */
  readonly systemImage: string;
}

/** What the voice screen shows: a short title, and whether the mic is live. */
export interface VoicePrompt {
  readonly title: string;
  readonly listening: boolean;
  readonly buttons: ReadonlyArray<VoicePromptButton>;
}

export interface ListenRequest {
  /** Stop this long after the speaker goes quiet. */
  readonly endSilenceMs: number;
  /** Give up when nobody starts speaking within this time. */
  readonly startTimeoutMs: number;
  readonly maxDurationMs: number;
  /** Buttons that stop listening and keep what was heard so far. */
  readonly finishButtonIds: ReadonlyArray<string>;
  /** Words the recognizer should favor, such as project names. */
  readonly hints: ReadonlyArray<string>;
}

export type ListenOutcome =
  | { readonly type: "speech"; readonly transcript: string }
  | { readonly type: "button"; readonly buttonId: string }
  | { readonly type: "no-speech" };

/** Audio and screen primitives of the car display. */
export interface VoiceDispatchIO {
  showPrompt(prompt: VoicePrompt): void;
  speak(text: string): Promise<void>;
  listen(request: ListenRequest): Promise<ListenOutcome>;
  /** Shows a tappable list; resolves null when the driver backs out. */
  chooseProject(
    projects: ReadonlyArray<VoiceDispatchProject>,
  ): Promise<VoiceDispatchProject | null>;
}

export interface VoiceDispatchDependencies {
  readonly io: VoiceDispatchIO;
  readonly projects: ReadonlyArray<VoiceDispatchProject>;
  /**
   * Starts the thread. "queued" means it waits for its environment to
   * reconnect. Rejects with a message the driver can hear.
   */
  readonly startThread: (
    project: VoiceDispatchProject,
    request: string,
  ) => Promise<"started" | "queued">;
  /** Skips the questions to start a request whose first start failed. */
  readonly retry?: { readonly project: VoiceDispatchProject; readonly request: string };
  readonly signal?: AbortSignal;
}

export type VoiceDispatchOutcome =
  | {
      readonly type: "started" | "queued";
      readonly project: VoiceDispatchProject;
      readonly request: string;
    }
  | {
      readonly type: "failed";
      readonly project: VoiceDispatchProject;
      readonly request: string;
      readonly message: string;
    }
  | { readonly type: "cancelled" }
  | { readonly type: "no-projects" };

export const VOICE_BUTTON = {
  projects: { id: "projects", title: "Projects", systemImage: "list.bullet" },
  done: { id: "done", title: "Done", systemImage: "checkmark" },
  cancel: { id: "cancel", title: "Cancel", systemImage: "xmark" },
  start: { id: "start", title: "Start", systemImage: "play.fill" },
  newThread: { id: "new-thread", title: "New Thread", systemImage: "plus" },
  retry: { id: "retry", title: "Try Again", systemImage: "arrow.clockwise" },
} as const satisfies Record<string, VoicePromptButton>;

const PROJECT_LISTEN: Omit<ListenRequest, "hints"> = {
  endSilenceMs: 1200,
  startTimeoutMs: 7000,
  maxDurationMs: 12_000,
  finishButtonIds: [],
};

const REQUEST_LISTEN: Omit<ListenRequest, "hints"> = {
  endSilenceMs: 2500,
  startTimeoutMs: 10_000,
  maxDurationMs: 120_000,
  finishButtonIds: [VOICE_BUTTON.done.id],
};

const CONFIRM_LISTEN: Omit<ListenRequest, "hints"> = {
  endSilenceMs: 1000,
  startTimeoutMs: 6000,
  maxDurationMs: 8000,
  finishButtonIds: [],
};

/** Longest read-back of a request before it is cut short. */
const READ_BACK_WORDS = 30;

class VoiceDispatchCancelled extends Error {}

function readBack(request: string): string {
  const words = request.trim().split(/\s+/);
  if (words.length <= READ_BACK_WORDS) return request.trim();
  return `${words.slice(0, READ_BACK_WORDS).join(" ")}, and so on`;
}

/**
 * Runs one hands-free dispatch: which project, what to build, confirm, start.
 * Every question also has an on-screen way out, and nothing starts without a
 * spoken or tapped confirmation.
 */
export async function runVoiceDispatch(
  dependencies: VoiceDispatchDependencies,
): Promise<VoiceDispatchOutcome> {
  const { io, projects, signal } = dependencies;
  const checkAborted = () => {
    if (signal?.aborted) throw new VoiceDispatchCancelled();
  };
  const ask = async (prompt: VoicePrompt, spoken: string, listen: ListenRequest) => {
    checkAborted();
    io.showPrompt({ ...prompt, listening: false });
    await io.speak(spoken);
    checkAborted();
    io.showPrompt(prompt);
    const outcome = await io.listen(listen);
    checkAborted();
    return outcome;
  };

  try {
    if (dependencies.retry) {
      return await start(dependencies.retry.project, dependencies.retry.request);
    }
    if (projects.length === 0) {
      io.showPrompt({ title: "No projects", listening: false, buttons: [VOICE_BUTTON.newThread] });
      await io.speak("No T3 Code projects are connected. Open T3 Code on your iPhone first.");
      return { type: "no-projects" };
    }

    const project = projects.length === 1 ? projects[0] : await askForProject(projects);
    if (!project) return await cancel();

    const request = await askForRequest(project);
    if (request === null) return await cancel();

    const confirmed = await askToConfirm(request);
    if (!confirmed) return await cancel();

    return await start(project, request);
  } catch (error) {
    if (error instanceof VoiceDispatchCancelled) return { type: "cancelled" };
    throw error;
  }

  async function start(
    project: VoiceDispatchProject,
    request: string,
  ): Promise<VoiceDispatchOutcome> {
    checkAborted();
    io.showPrompt({ title: "Starting thread…", listening: false, buttons: [] });
    let status: "started" | "queued";
    try {
      status = await dependencies.startThread(project, request);
    } catch (error) {
      checkAborted();
      const message = error instanceof Error ? error.message : "Something went wrong.";
      io.showPrompt({
        title: "Couldn't start the thread",
        listening: false,
        buttons: [VOICE_BUTTON.retry, VOICE_BUTTON.newThread],
      });
      await io.speak(`I couldn't start the thread. ${message}`);
      return { type: "failed", project, request, message };
    }
    checkAborted();
    if (status === "queued") {
      io.showPrompt({
        title: "Thread queued",
        listening: false,
        buttons: [VOICE_BUTTON.newThread],
      });
      await io.speak(`Queued. It starts when ${project.title} reconnects.`);
    } else {
      io.showPrompt({
        title: "Thread started",
        listening: false,
        buttons: [VOICE_BUTTON.newThread],
      });
      await io.speak(`Started in ${project.title}.`);
    }
    return { type: status, project, request };
  }

  async function cancel(): Promise<VoiceDispatchOutcome> {
    checkAborted();
    io.showPrompt({ title: "Cancelled", listening: false, buttons: [VOICE_BUTTON.newThread] });
    await io.speak("Okay, cancelled.");
    return { type: "cancelled" };
  }

  async function askForProject(
    candidates: ReadonlyArray<VoiceDispatchProject>,
  ): Promise<VoiceDispatchProject | null> {
    const hints = candidates.flatMap((candidate) => [candidate.title, ...candidate.spokenNames]);
    const prompt = {
      title: "Which project?",
      listening: true,
      buttons: [VOICE_BUTTON.projects, VOICE_BUTTON.cancel],
    };
    for (const spoken of ["Which project?", "Which project? You can also tap Projects."]) {
      const outcome = await ask(prompt, spoken, { ...PROJECT_LISTEN, hints });
      if (outcome.type === "button") {
        if (outcome.buttonId === VOICE_BUTTON.cancel.id) return null;
        return pickFromList(candidates, "Pick a project.");
      }
      if (outcome.type === "no-speech") continue;
      const match = matchSpokenProject(outcome.transcript, candidates);
      if (match.type === "match") return match.candidate;
      if (match.type === "ambiguous") {
        return pickFromList(match.candidates, "A few projects match. Pick one.");
      }
      return pickFromList(candidates, `I couldn't find ${outcome.transcript}. Pick a project.`);
    }
    return pickFromList(candidates, "Pick a project.");
  }

  async function pickFromList(
    candidates: ReadonlyArray<VoiceDispatchProject>,
    spoken: string,
  ): Promise<VoiceDispatchProject | null> {
    checkAborted();
    io.showPrompt({ title: "Pick a project", listening: false, buttons: [] });
    await io.speak(spoken);
    checkAborted();
    const choice = await io.chooseProject(candidates);
    checkAborted();
    return choice;
  }

  async function askForRequest(project: VoiceDispatchProject): Promise<string | null> {
    const prompt = {
      title: "What do you want to build?",
      listening: true,
      buttons: [VOICE_BUTTON.done, VOICE_BUTTON.cancel],
    };
    const questions = [
      `What do you want to build in ${project.title}?`,
      "I didn't hear anything. What do you want to build?",
    ];
    for (const spoken of questions) {
      const outcome = await ask(prompt, spoken, { ...REQUEST_LISTEN, hints: [] });
      if (outcome.type === "button") return null;
      if (outcome.type === "speech" && outcome.transcript.trim().length > 0) {
        return outcome.transcript.trim();
      }
    }
    return null;
  }

  async function askToConfirm(request: string): Promise<boolean> {
    const prompt = {
      title: "Start this thread?",
      listening: true,
      buttons: [VOICE_BUTTON.start, VOICE_BUTTON.cancel],
    };
    const questions = [
      `${readBack(request)}. Should I start it?`,
      "Should I start it? Say yes or no.",
    ];
    for (const spoken of questions) {
      const outcome = await ask(prompt, spoken, { ...CONFIRM_LISTEN, hints: [] });
      if (outcome.type === "button") return outcome.buttonId === VOICE_BUTTON.start.id;
      if (outcome.type === "no-speech") continue;
      const answer = parseSpokenConfirmation(outcome.transcript);
      if (answer !== "unclear") return answer === "yes";
    }
    return false;
  }
}
