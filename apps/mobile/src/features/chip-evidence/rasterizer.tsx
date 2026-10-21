import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectGlyphImageAtom, projectGlyphKey } from "../../native/ProjectChipIconImages";
export { ProjectChipIconRasterizer as Rasterizer } from "../../native/ProjectChipIconImages";

export function seedGlyphFailures() {
  for (const [text, color, failed] of [
    ["P", "blue", false],
    ["F", "red", true],
  ] as const) {
    const atom = projectGlyphImageAtom(projectGlyphKey({ kind: "monogram", text, color }));
    const value = failed
      ? AsyncResult.failure<string, Cause.UnknownError>(
          Cause.fail(new Cause.UnknownError("Static glyph rejection")),
        )
      : AsyncResult.initial();
    const node = appAtomRegistry.ensureNode(atom);
    node.setInitialValue(value);
    appAtomRegistry.subscribe(atom, (next) => {
      if (next !== value) node.setInitialValue(value);
    });
  }
}
