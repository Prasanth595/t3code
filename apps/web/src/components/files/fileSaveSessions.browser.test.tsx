import { render, fakeTimers } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { runAtomCommand, getUnsavedFile, getSavedContents, setDraft } = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  getUnsavedFile: vi.fn(),
  getSavedContents: vi.fn(),
  setDraft: vi.fn(),
}));
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: runAtomCommand as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: () => true,
  getUnsavedProjectFileQueryData: getUnsavedFile,
  getSavedProjectFileContents: getSavedContents,
  setProjectFileQueryData: setDraft,
}));

import { changeFileSaveSession, useFileSaveSession } from "./fileSaveSessions";

const target = {
  environmentId: EnvironmentId.make("file-save-sessions-browser"),
  cwd: "/workspace",
  relativePath: "README.md",
};
const onPendingChange = vi.fn();

// The editor and rendered-markdown surfaces are different component types, so
// switching between them unmounts one session holder and mounts another.
function EditorSurface() {
  useFileSaveSession({ ...target }, onPendingChange);
  return <div>editor</div>;
}
function MarkdownSurface() {
  useFileSaveSession({ ...target }, onPendingChange);
  return <div>markdown</div>;
}

describe("file save sessions in React", () => {
  it("writes a pending draft once when the file switches surfaces under StrictMode", async () => {
    let finishWrite = () => {};
    runAtomCommand.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(AsyncResult.success({ relativePath: target.relativePath }));
        }),
    );
    getUnsavedFile.mockReset().mockReturnValue(null);
    await using screen = await render(
      <StrictMode>
        <EditorSurface />
      </StrictMode>,
      { router: false }, // no routes involved; the surfaces are bare effect hosts
    );
    using _timers = fakeTimers();
    // An edit lands in the query cache, unconfirmed until its write settles.
    getUnsavedFile.mockReturnValue({ contents: "draft" });
    changeFileSaveSession(target, "draft");

    await screen.rerender(
      <StrictMode>
        <MarkdownSurface />
      </StrictMode>,
    );
    finishWrite();
    getUnsavedFile.mockReturnValue(null);
    await vi.runAllTimersAsync();

    expect(runAtomCommand.mock.calls.map(([, , request]) => request)).toEqual([
      {
        environmentId: target.environmentId,
        input: { cwd: "/workspace", relativePath: "README.md", contents: "draft" },
      },
    ]);
    expect(onPendingChange).toHaveBeenLastCalledWith("README.md", false);
  });

  it("pins the saved contents a host-file edit replaces before the draft overwrites them", async () => {
    const hostTarget = { ...target, relativePath: "/Users/me/.codex/AGENTS.md" };
    // Until its refetch lands, a confirmed save is only in the draft the next edit replaces.
    let saved = "saved";
    getSavedContents.mockReset().mockImplementation(() => saved);
    setDraft.mockReset().mockImplementation(() => {
      saved = "stale read";
    });
    runAtomCommand
      .mockReset()
      .mockResolvedValue(AsyncResult.success({ relativePath: hostTarget.relativePath }));
    getUnsavedFile.mockReset().mockReturnValue(null);
    function HostFileSurface() {
      useFileSaveSession({ ...hostTarget }, onPendingChange);
      return <div>editor</div>;
    }
    await using _screen = await render(<HostFileSurface />, { router: false }); // no routes involved; the surface is a bare effect host
    using _timers = fakeTimers();
    changeFileSaveSession(hostTarget, "edit");
    await vi.runAllTimersAsync();

    expect(
      runAtomCommand.mock.calls.map(([, , request]) => request.input.expectedContents),
    ).toEqual(["saved"]);
  });
});
