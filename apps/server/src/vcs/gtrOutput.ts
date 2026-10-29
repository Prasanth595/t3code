import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Creation = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty()),
  branch: Schema.String.check(Schema.isNonEmpty()),
  hookStatus: Schema.Literals(["disabled", "none", "ran", "skipped-untrusted", "partial"]),
});
const decodeCreation = Schema.decodeUnknownOption(Creation);

export function parseGtrCreation(stdout: string, windows = false) {
  const match = /^path\t([^\n]*)\nbranch\t([^\n]*)\nhook_status\t([^\n]*)\n$/.exec(stdout);
  if (!match) return null;
  const unescape = (value: string) =>
    !/^(?:[^\\\t]|\\[\\tn])*$/.test(value)
      ? null
      : value.replace(/\\([\\tn])/g, (_, escaped: string) =>
          escaped === "t" ? "\t" : escaped === "n" ? "\n" : "\\",
        );
  const decodedPath = unescape(match[1]!);
  return Option.getOrNull(
    decodeCreation({
      path: windows ? decodedPath?.replace(/^\/([a-zA-Z])\//, "$1:/") : decodedPath,
      branch: unescape(match[2]!),
      hookStatus: match[3],
    }),
  );
}
