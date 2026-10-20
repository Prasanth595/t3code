import { expect, it } from "@effect/vitest";

import {
  failureMessage,
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
