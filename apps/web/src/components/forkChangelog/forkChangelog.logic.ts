import { FORK_CHANGELOG_REPOSITORIES, type ForkCommit } from "@t3tools/contracts";

/** One piece of a commit subject. `url` is set for a `#123` pull request reference. */
export interface CommitSubjectPart {
  /** The offset of the piece in the subject, unique within one subject. */
  readonly start: number;
  readonly text: string;
  readonly url: string | null;
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (isDigit(character) || character === "_" || character.toLowerCase() !== character.toUpperCase())
  );
}

/**
 * Splits a commit subject so that each `#123` links to its pull request. A fork commit refers to
 * a fork pull request and an upstream commit to an upstream one. A `#` inside a word, such as
 * `C#1` or `owner/name#1`, stays text.
 */
export function linkCommitSubject(
  commit: Pick<ForkCommit, "subject" | "fork">,
): CommitSubjectPart[] {
  const { subject } = commit;
  const repository = commit.fork
    ? FORK_CHANGELOG_REPOSITORIES.fork
    : FORK_CHANGELOG_REPOSITORIES.upstream;
  const parts: CommitSubjectPart[] = [];
  let textStart = 0;
  let hash = subject.indexOf("#");
  while (hash !== -1) {
    let end = hash + 1;
    while (isDigit(subject[end])) end += 1;
    const before = subject[hash - 1];
    const isReference =
      end > hash + 1 && !isWordCharacter(before) && !isWordCharacter(subject[end]);
    if (isReference) {
      if (hash > textStart) {
        parts.push({ start: textStart, text: subject.slice(textStart, hash), url: null });
      }
      parts.push({
        start: hash,
        text: subject.slice(hash, end),
        url: `https://github.com/${repository}/pull/${subject.slice(hash + 1, end)}`,
      });
      textStart = end;
    }
    hash = subject.indexOf("#", hash + 1);
  }
  if (textStart < subject.length) {
    parts.push({ start: textStart, text: subject.slice(textStart), url: null });
  }
  return parts;
}
