import { runI89OfflineFixture } from "../src/orchestration-v2/testkit/I89OfflineFixture.ts";

const lane = process.argv[2];
if (!lane || process.argv.length !== 3)
  throw new Error(
    "Usage: node apps/server/scripts/i89-offline-fixture.ts <existing-lane-directory>",
  );
const receipt = await runI89OfflineFixture(lane);
console.log(
  JSON.stringify({
    status: receipt.status,
    directory: receipt.directory,
    workerStarts: receipt.workerStarts,
  }),
);
