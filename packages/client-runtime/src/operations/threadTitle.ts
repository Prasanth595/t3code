import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  return assistantCitationsToPlainText(value).trim().replace(/\s+/gu, " ");
}

/** Prefer the request over image chips; image-only prompts still get a readable title. */
export function threadTitleTextFromPrompt(value: string): string {
  let imageLabel: string | undefined;
  const prose = replaceComposerContextReferences(value, (reference) => {
    if (reference.kind === "image") {
      imageLabel ??= reference.label;
      return "";
    }
    return reference.label;
  });
  return (
    normalizeTitleSeed(prose) || (imageLabel ? `Image: ${normalizeTitleSeed(imageLabel)}` : "")
  );
}

export function deriveThreadTitleSeed(input: ThreadTitleSeedInput): string {
  const text = threadTitleTextFromPrompt(input.text);
  if (text.length > 0) {
    return truncate(text);
  }

  const attachmentName = normalizeTitleSeed(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) {
    return truncate(`Image: ${attachmentName}`);
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return "New thread";
}
