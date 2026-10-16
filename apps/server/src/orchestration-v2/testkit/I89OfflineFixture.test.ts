import * as NodeAssert from "node:assert";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { it } from "vite-plus/test";
import { I89_BYTES, I89_SHA256, runI89OfflineFixture } from "./I89OfflineFixture.ts";
import * as NodeCrypto from "node:crypto";

it("executes one admitted worker and recovers exact receipts after closing and reopening SQLite", async () => {
  const lane = process.env.I89_LANE_DIR ?? (await NodeFSP.realpath(NodeOS.tmpdir()));
  const result = await runI89OfflineFixture(lane);
  NodeAssert.strict.equal(result.workerStarts, 1);
  NodeAssert.strict.equal(
    NodeCrypto.createHash("sha256").update(I89_BYTES).digest("hex"),
    I89_SHA256,
  );
  NodeAssert.strict.equal(
    await NodeFSP.readFile(NodePath.join(result.directory, "scratch/result.txt"), "utf8"),
    I89_BYTES,
  );
  NodeAssert.strict.equal(
    JSON.parse(await NodeFSP.readFile(NodePath.join(result.directory, "receipts.json"), "utf8"))
      .status,
    "PASS",
  );
}, 60000);
