import { codegenNativeComponent, type CodegenTypes } from "react-native";
import type { ViewProps } from "react-native";

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

/**
 * @property start - The start index of the selected range (0-based)
 * @property end - The end index of the selected range (0-based, exclusive)
 */
interface SelectionChangeEvent extends TargetedEvent {
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
}

type EllipsizeMode = "head" | "middle" | "tail" | "clip";

interface NativeProps extends ViewProps {
  numberOfLines?: CodegenTypes.Int32;
  allowFontScaling?: CodegenTypes.WithDefault<boolean, true>;
  ellipsizeMode?: CodegenTypes.WithDefault<EllipsizeMode, "tail">;
  selectable?: boolean;
  onSelectionChange?: CodegenTypes.BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3SourceText", {
  excludedPlatforms: ["android"],
});
