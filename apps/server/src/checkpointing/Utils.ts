import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefNamespaceForThread(threadId: ThreadId): string {
  return `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/`;
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(`${checkpointRefNamespaceForThread(threadId)}turn/${turnCount}`);
}
