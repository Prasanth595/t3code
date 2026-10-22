import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";

const state = vi.hoisted(() => ({
  archive: vi.fn(),
  router: {
    state: {
      location: { href: "/archive-env/thread-a" },
      matches: [{ params: {} as Record<string, string> }],
    },
  },
  refreshed: [] as string[],
  notice: null as { action: string; undo: () => Promise<unknown> } | null,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => state.router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => {
    state.router.state.location.href = "/draft/project-a";
  },
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: string) => {
    state.refreshed.push(environmentId);
  },
}));
vi.mock("./showThreadUndoNotice", () => ({
  showThreadUndoNotice: (notice: NonNullable<typeof state.notice>) => {
    state.notice = notice;
  },
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readThreadShell: () => ({
    title: "Thread A",
    projectId: "project-a",
    environmentId: "archive-env",
    runtime: null,
    session: null,
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.archive ? state.archive : vi.fn(),
}));

it.each([
  { destination: "/archive-env/thread-a", expected: "/draft/project-a" },
  { destination: "/archive-env/thread-b", expected: "/archive-env/thread-b" },
  { destination: "/settings", expected: "/settings" },
])("keeps $expected after archive completes at $destination", async ({ destination, expected }) => {
  state.router.state.location.href = "/archive-env/thread-a";
  state.router.state.matches[0]!.params = {
    environmentId: "archive-env",
    threadId: "thread-a",
  };
  state.refreshed = [];
  state.notice = null;
  let resolveArchive!: (result: { _tag: "Success"; value: undefined }) => void;
  const archive = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
    resolveArchive = resolve;
  });
  state.archive.mockReset().mockReturnValue(archive);

  const pending = useThreadActions().archiveThread({
    environmentId: EnvironmentId.make("archive-env"),
    threadId: ThreadId.make("thread-a"),
  });
  state.router.state.location.href = destination;
  state.router.state.matches[0]!.params =
    destination === "/settings"
      ? {}
      : { environmentId: "archive-env", threadId: destination.split("/").at(-1)! };
  resolveArchive({ _tag: "Success", value: undefined });

  expect((await pending)._tag).toBe("Success");
  expect(state.refreshed).toEqual(["archive-env"]);
  expect(state.notice).toMatchObject({ action: "Archived", undo: expect.any(Function) });
  expect(state.router.state.location.href).toBe(expected);
});
