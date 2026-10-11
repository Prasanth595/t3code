import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

const UNSUPPORTED_DETAIL = "fx does not provide application text generation yet.";

/**
 * Every `fx acp` session is saved under `~/.fx`, and ACP has no session
 * delete, so a throwaway text-generation session would stay on disk.
 */
export const makeUnsupportedFxTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: UNSUPPORTED_DETAIL,
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};
