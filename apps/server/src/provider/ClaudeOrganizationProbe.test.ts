import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { probeClaudeOrganizationId } from "./ClaudeProvider.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);
const windowsHost = process.platform === "win32";

it.layer(NodeServices.layer)("Claude organization probe", (it) => {
  it.effect.skipIf(windowsHost)("reads each wrapper's account instead of the inherited account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const cli = path.join(directory, "claude");
      yield* fs.writeFileString(
        cli,
        '#!/bin/sh\n[ "$*" = "auth status --json" ] || exit 2\ncat "$CLAUDE_CONFIG_DIR/status.json"\n',
      );
      yield* fs.chmod(cli, 0o755);
      const organizations: Array<string | undefined> = [];
      for (const orgId of ["personal", "team"]) {
        const configDir = path.join(directory, orgId);
        yield* fs.makeDirectory(configDir);
        yield* fs.writeFileString(
          path.join(configDir, "status.json"),
          JSON.stringify({ loggedIn: true, email: "same@example.com", orgId }),
        );
        const wrapper = path.join(directory, `claude-${orgId}`);
        yield* fs.writeFileString(
          wrapper,
          `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="$(dirname "$0")/${orgId}"\nexec "$(dirname "$0")/claude" "$@"\n`,
        );
        yield* fs.chmod(wrapper, 0o755);
        organizations.push(
          yield* probeClaudeOrganizationId(decodeSettings({ binaryPath: wrapper }), {
            ...process.env,
            CLAUDE_CONFIG_DIR: path.join(directory, "personal"),
          }),
        );
      }
      assert.deepEqual(organizations, ["personal", "team"]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("rejects unsupported or malformed auth status for the fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const binaryPath = path.join(directory, "claude");
      for (const response of ["exit 1", "echo malformed"]) {
        yield* fs.writeFileString(binaryPath, `#!/bin/sh\n${response}\n`);
        yield* fs.chmod(binaryPath, 0o755);
        const result = yield* probeClaudeOrganizationId(decodeSettings({ binaryPath })).pipe(
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
      }
    }).pipe(Effect.scoped),
  );
});
