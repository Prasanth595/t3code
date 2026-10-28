// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import type { BundledFontProvider } from "@betteroffice/docx/layout";
import {
  loadBundledFontBytes,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
  type BundledFontFace,
  type BundledFontScript,
} from "@betteroffice/fonts";

// Latin and CJK faces load on demand from the app's own assets, including when the document names a Windows font.

/** The faces Word substitutes for a document's fonts: metric-compatible ones first, then Word's own fallbacks. */
export function wordFonts(): BundledFontProvider {
  const loader = (face: BundledFontFace | undefined) => (face ? () => loadFace(face) : undefined);

  return {
    resolve: (family, bold, italic) => loader(resolveMetricCompatFace(family, bold, italic)),
    resolveFamily: (family, bold, italic) => loader(resolveBundledFamilyFace(family, bold, italic)),
    resolveScriptFallback: (script, bold, italic) => loader(scriptFace(script, bold, italic)),
    resolveLastResort: (family, bold, italic) => () =>
      loadFace(resolveLastResortFace(family, bold, italic, "word")),
  };
}

/** The face PowerPoint draws a family with: its metric-compatible or bundled face, else PowerPoint's substitute. */
export function presentationFace(family: string, bold: boolean, italic: boolean): BundledFontFace {
  return (
    resolveMetricCompatFace(family, bold, italic) ??
    resolveBundledFamilyFace(family, bold, italic) ??
    resolveLastResortFace(family, bold, italic, "powerpoint")
  );
}

/** The face that covers a script the Latin faces lack, or undefined when the app ships none. */
export function scriptFace(script: BundledFontScript, bold: boolean, italic: boolean) {
  return resolveScriptFallbackFace(script, bold, italic);
}

/**
 * A bundled face's bytes. The font package caches them per worker, so a face loads once per open file; the browser's
 * caches, which every worker shares, serve the files to the next.
 */
export function loadFace(face: BundledFontFace) {
  return loadBundledFontBytes(face);
}
