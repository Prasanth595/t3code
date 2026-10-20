import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  failureMessage,
  runProviderMaintenanceCommandWithSpawner,
  type ProviderMaintenanceCommandResult,
} from "./providerMaintenanceRunner.ts";

const failed = (
  output: Partial<Pick<ProviderMaintenanceCommandResult, "stdout" | "stderr">>,
): ProviderMaintenanceCommandResult => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...output,
});

it("shows the updater's own explanation in the failure message", () => {
  expect(
    failureMessage(
      failed({
        stderr:
          "Error: Could not detect the Codex installation method. Please update manually: https://developers.openai.com/codex/cli/\n",
      }),
    ),
  ).toBe(
    "Update command exited with code 1: Error: Could not detect the Codex installation method. Please update manually: https://developers.openai.com/codex/cli/",
  );
});

it("keeps the exit-code message when the updater printed nothing", () => {
  expect(failureMessage(failed({}))).toBe("Update command exited with code 1.");
  expect(failureMessage(failed({ stderr: " \n\t\n", stdout: "\n" }))).toBe(
    "Update command exited with code 1.",
  );
});

it("falls back to stdout when stderr is empty", () => {
  expect(failureMessage(failed({ stdout: "No update available for this install\n" }))).toBe(
    "Update command exited with code 1: No update available for this install",
  );
});

it("prefers stderr over stdout", () => {
  expect(
    failureMessage(failed({ stdout: "Fetching metadata\n", stderr: "EACCES: denied\n" })),
  ).toBe("Update command exited with code 1: EACCES: denied");
});

it("strips terminal control sequences from the excerpt", () => {
  expect(failureMessage(failed({ stderr: "\u001b[31merror\u001b[0m:   boom\u001b[K\n" }))).toBe(
    "Update command exited with code 1: error: boom",
  );
});

it("shows only the last lines of long output", () => {
  const stderr = Array.from({ length: 500 }, (_, index) => `progress line ${index}`).join("\n");

  expect(failureMessage(failed({ stderr }))).toBe(
    "Update command exited with code 1: progress line 498 progress line 499",
  );
});

it("bounds a single huge line", () => {
  const message = failureMessage(failed({ stderr: "x".repeat(10_000) }));

  expect(message.startsWith("Update command exited with code 1: xxx")).toBe(true);
  expect(message.length).toBeLessThanOrEqual(260);
});

it("leaves the timeout and unknown-exit messages alone", () => {
  expect(
    failureMessage({ ...failed({ stderr: "late output" }), exitCode: null, timedOut: true }),
  ).toBe("Update timed out.");
  expect(failureMessage({ ...failed({ stderr: "killed" }), exitCode: null })).toBe(
    "Update command failed.",
  );
});

// Chunk boundaries fall mid-line, as they do on a real pipe.
const runFailingUpdater = (stderr: string, chunkSize = 1_000) => {
  const bytes = new TextEncoder().encode(stderr);
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
    bytes.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.fromIterable(chunks),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return runProviderMaintenanceCommandWithSpawner({ spawner, command: "updater", args: [] }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
  );
};

it.effect("shows the final error of output longer than the captured 10 KB", () =>
  Effect.gen(function* () {
    const progress = Array.from(
      { length: 1_000 },
      (_, index) => `Downloading part ${index} of 1000\n`,
    ).join("");
    const result = yield* runFailingUpdater(
      `${progress}npm error code EACCES\nnpm error Could not write to /usr/local/lib\n`,
    );

    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(10_000);
    expect(result.stderr.startsWith("Downloading part 0 of 1000\n")).toBe(true);
    expect(failureMessage(result)).toBe(
      "Update command exited with code 1: npm error code EACCES npm error Could not write to /usr/local/lib",
    );
  }),
);

it.effect("does not show the cut start of a long output as its last line", () =>
  Effect.gen(function* () {
    const result = yield* runFailingUpdater(`${"x".repeat(20_000)}\nError: boom\n`);

    expect(failureMessage(result)).toBe("Update command exited with code 1: Error: boom");
  }),
);

it.effect("keeps the failure excerpt bounded for a huge line without newlines", () =>
  Effect.gen(function* () {
    const result: ProviderMaintenanceCommandResult = yield* runFailingUpdater(
      "y".repeat(1_000_000),
      64 * 1_024,
    );

    expect(result.stderrTail?.length).toBeLessThanOrEqual(4_096);
    expect(failureMessage(result).length).toBeLessThanOrEqual(260);
  }),
);
