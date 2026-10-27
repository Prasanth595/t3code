import { useMemo } from "react";

import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../../lib/appearancePreferences";
import { createNativeReviewDiffStyle } from "../../review/nativeReviewDiffAdapter";
import { createNativeSourceStyle } from "../../files/nativeSourceFileAdapter";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";
import { useSystemFontScale } from "../../../lib/useSystemFontScale";
import { scaleCodeSurfaceMetrics, scaleNativeCodeStyle } from "./systemFontMetrics";

export function useAppearanceCodeSurface(): {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly codeWordBreak: boolean;
  readonly nativeSourceStyle: ReturnType<typeof createNativeSourceStyle>;
  readonly nativeReviewDiffStyle: ReturnType<typeof createNativeReviewDiffStyle>;
} {
  const { appearance } = useAppearancePreferences();
  const scaleSystemFont = useSystemFontScale();
  const baseCodeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  // Code text and virtualized/native rows share effective metrics; RN code text opts out of a second scale.
  const codeSurface = useMemo(
    () => scaleCodeSurfaceMetrics(baseCodeSurface, scaleSystemFont),
    [baseCodeSurface, scaleSystemFont],
  );
  const nativeSourceStyle = useMemo(
    () => scaleNativeCodeStyle(createNativeSourceStyle(baseCodeSurface), scaleSystemFont),
    [baseCodeSurface, scaleSystemFont],
  );
  const nativeReviewDiffStyle = useMemo(
    () =>
      scaleNativeCodeStyle(
        createNativeReviewDiffStyle(baseCodeSurface, appearance.codeWordBreak),
        scaleSystemFont,
      ),
    [appearance.codeWordBreak, baseCodeSurface, scaleSystemFont],
  );

  return {
    codeSurface,
    codeWordBreak: appearance.codeWordBreak,
    nativeSourceStyle,
    nativeReviewDiffStyle,
  };
}
