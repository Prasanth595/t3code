import { useId } from "react";
import { StyleSheet } from "react-native";
import Svg, { Circle, Defs, Path, Pattern, Rect } from "react-native-svg";

import { themeColorWithAlpha } from "../../../lib/mobileTheme";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

/**
 * Fork: the canvas pattern of the active published theme, as a static layer behind a feed. Same
 * sizes as web `fork-theme.css`: 16px dots, a 24px grid, and the foreground at 14% without a
 * theme color. Renders nothing for a theme without a pattern.
 */
export function ForkCanvasPattern() {
  const { themeStyle, themeVariables } = useAppearancePreferences();
  const patternId = `fork-canvas-${useId().replaceAll(":", "")}`;
  const pattern = themeStyle.canvasPattern;
  if (!pattern) return null;
  const color = pattern.color ?? themeColorWithAlpha(themeVariables["--color-foreground"], 0.14);
  const cell = pattern.kind === "dots" ? 16 : 24;
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id={patternId} width={cell} height={cell} patternUnits="userSpaceOnUse">
          {pattern.kind === "dots" ? (
            <Circle cx={cell / 2} cy={cell / 2} r={1.2} fill={color} />
          ) : (
            <Path d={`M0 0.5H${cell}M0.5 0V${cell}`} stroke={color} strokeWidth={1} />
          )}
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </Svg>
  );
}
