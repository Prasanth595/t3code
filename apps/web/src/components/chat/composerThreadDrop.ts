import type { ThreadContextRecord } from "@t3tools/contracts";
import type { ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";

/** Question references belong to the answer draft, whose text lives outside the draft store. */
export function insertDroppedThreadContexts(options: {
  records: ReadonlyArray<ThreadContextRecord>;
  composerTarget: ComposerThreadTarget;
  questionTarget: ComposerThreadTarget | null;
  canAnswer: boolean;
  insertAnswerText: (text: string) => boolean;
  addThreadContexts: ReturnType<typeof useComposerDraftStore.getState>["addThreadContexts"];
}): boolean {
  if (options.records.length === 0) return false;
  if (options.questionTarget !== null) {
    if (!options.canAnswer) return false;
    const text = `${options.records
      .map((record) => formatInlineContextReference(threadContextReference(record)))
      .join(" ")} `;
    if (!options.insertAnswerText(text)) return false;
    options.addThreadContexts(options.questionTarget, options.records, { appendReference: false });
  } else {
    options.addThreadContexts(options.composerTarget, options.records);
  }
  return true;
}
