import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import {
  getVoiceDispatchModule,
  type VoiceDispatchNativeEvents,
  type VoiceDispatchNativeModule,
} from "../../native/voiceDispatch";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { workspaceConnections } from "../../state/workspace";
import { CarPlayVoiceSession } from "./carPlayVoiceSession";
import { startVoiceThread } from "./startVoiceThread";
import { buildVoiceDispatchProjects } from "./voiceDispatchProjects";

/** A cold start from CarPlay or Siri reads cached projects within moments. */
const PROJECTS_WAIT_MS = 5000;

// Isolated from the busier project and server-config streams: CarPlay and
// Siri only need to hear about a change to the projects they can offer.
const voiceDispatchProjectsAtom = Atom.make((get) =>
  buildVoiceDispatchProjects({
    projects: get(environmentProjects.projectsAtom),
    environmentLabels: new Map(
      get(workspaceConnections.environmentsAtom).map((environment) => [
        environment.environmentId,
        environment.environmentLabel,
      ]),
    ),
    scratchWorkspaceRoots: new Map(
      Array.from(get(environmentServerConfigsAtom), ([environmentId, config]) => [
        environmentId,
        config.scratchWorkspaceRoot,
      ]),
    ),
  }),
).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

type DispatchProject = ReturnType<typeof buildVoiceDispatchProjects>[number];

function readProjects(): Promise<ReadonlyArray<DispatchProject>> {
  const current = appAtomRegistry.get(voiceDispatchProjectsAtom);
  if (current.length > 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(appAtomRegistry.get(voiceDispatchProjectsAtom));
    }, PROJECTS_WAIT_MS);
    unsubscribe = appAtomRegistry.subscribe(voiceDispatchProjectsAtom, (projects) => {
      if (projects.length === 0) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(projects);
    });
  });
}

async function answerDispatchRequest(
  native: VoiceDispatchNativeModule,
  request: VoiceDispatchNativeEvents["onDispatchRequest"],
) {
  const project = (await readProjects()).find((candidate) => candidate.key === request.projectKey);
  if (!project) {
    await native.resolveDispatch(
      request.requestId,
      "failed",
      "That project isn't connected to T3 Code.",
    );
    return;
  }
  try {
    const status = await startVoiceThread(project, request.text);
    await native.resolveDispatch(request.requestId, status, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await native.resolveDispatch(request.requestId, "failed", message);
  }
}

/**
 * Keeps CarPlay and Siri supplied with projects and answers their requests to
 * start threads. Renders nothing; mounted at the app root so it runs whenever
 * the JS runtime does, including launches from CarPlay or Siri.
 */
export function VoiceDispatchCoordinator() {
  const projects = useAtomValue(voiceDispatchProjectsAtom);

  useEffect(() => {
    void getVoiceDispatchModule()?.setProjects(
      projects.map(({ key, title, subtitle, spokenNames }) => ({
        key,
        title,
        subtitle,
        spokenNames,
      })),
    );
  }, [projects]);

  useEffect(() => {
    const native = getVoiceDispatchModule();
    if (!native) return;
    const session = new CarPlayVoiceSession({
      native,
      projects: readProjects,
      startThread: startVoiceThread,
    });
    const subscriptions = [
      native.addListener("onCarPlaySession", ({ connected }) => {
        if (connected) void session.start();
        else session.stop();
      }),
      native.addListener("onVoiceButton", ({ buttonId }) => session.handleButton(buttonId)),
      native.addListener("onDispatchRequest", (request) => {
        void answerDispatchRequest(native, request);
      }),
    ];
    void native.markReady();
    return () => {
      session.stop();
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return null;
}
