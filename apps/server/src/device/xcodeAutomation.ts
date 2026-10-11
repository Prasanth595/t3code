import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

/**
 * Shared with the SSH bootstrap. Returns why agents cannot drive iOS Simulators
 * on this Mac, or null. Agent taps and snapshots run through XCTest, which needs
 * Xcode's DTServiceHub. macOS kills that binary at launch when the installed
 * Xcode is older than the OS allows, while streaming and screenshots keep working.
 */
export const xcodeAutomationWarningScript = String.raw`
function xcodeAutomationWarning() {
  const { spawnSync } = require('node:child_process');
  const xcodeRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  const developerDir = xcodeRun('xcode-select', ['-p']).stdout?.trim();
  if (!developerDir) return null;
  const serviceHub = require('node:path').join(developerDir, '..', 'SharedFrameworks', 'DVTInstrumentsFoundation.framework', 'Resources', 'DTServiceHub');
  if (xcodeRun(serviceHub, ['--help']).signal !== 'SIGKILL') return null;
  const xcode = xcodeRun('xcodebuild', ['-version']).stdout?.split('\n')[0]?.trim() || 'This Xcode';
  const macos = xcodeRun('sw_vers', ['-productVersion']).stdout?.trim() || 'this Mac';
  return xcode + ' is too old for macOS ' + macos + ', so agents cannot tap, type, or read the screen in iOS Simulators. Update Xcode.';
}
`;

const decodeWarning = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(Schema.String)),
);

/** The check is advisory: any failure to run it reports no warning. */
export const localXcodeAutomationWarning = Effect.fn("DeviceHost.localXcodeAutomationWarning")(
  function* (nodePath: string) {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner
      .run({
        command: nodePath,
        args: [
          "-e",
          xcodeAutomationWarningScript +
            "\nprocess.stdout.write(JSON.stringify(xcodeAutomationWarning()));",
        ],
        timeout: "20 seconds",
      })
      .pipe(
        Effect.flatMap((result) => decodeWarning(result.stdout)),
        Effect.orElseSucceed(() => null),
      );
  },
);
