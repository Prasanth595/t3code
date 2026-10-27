import React, { type ComponentRef, type Ref } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  type TextProps,
  type TextStyle,
} from "react-native";
import T3SourceTextRunNativeComponent from "./T3SourceTextRunNativeComponent";
import T3SourceTextNativeComponent from "./T3SourceTextNativeComponent";
import { flattenStyles } from "./util";

interface SourceTextContext {
  readonly style: TextStyle;
  readonly allowFontScaling: boolean;
  readonly fontScale: number;
}

const ROOT_STYLE: TextStyle = {};
const TextAncestorContext = React.createContext<SourceTextContext | null>(null);

export type SourceTextProps = Omit<TextProps, "onTextLayout" | "onPress" | "onLongPress"> & {
  nativeTextRef?: Ref<ComponentRef<typeof Text>>;
  onSelectionChange?: (event: {
    nativeEvent: { target: number; start: number; end: number };
  }) => void;
};

export function SourceText(props: SourceTextProps) {
  const ancestor = React.useContext(TextAncestorContext);
  return ancestor ? (
    <SourceTextContent {...props} ancestor={ancestor} systemFontScale={ancestor.fontScale} />
  ) : (
    <SourceTextRoot {...props} />
  );
}

function SourceTextRoot(props: SourceTextProps) {
  const { fontScale } = useWindowDimensions();
  return <SourceTextContent {...props} systemFontScale={fontScale} />;
}

function SourceTextContent({
  ancestor,
  systemFontScale,
  style,
  children,
  nativeTextRef,
  ...props
}: SourceTextProps & { readonly ancestor?: SourceTextContext; readonly systemFontScale: number }) {
  const rootStyle = ancestor?.style ?? ROOT_STYLE;
  const allowFontScaling = props.allowFontScaling ?? ancestor?.allowFontScaling ?? true;
  const scale = Platform.OS === "ios" && allowFontScaling ? systemFontScale : 1;
  const flattenedStyle = React.useMemo(() => {
    const base = flattenStyles(rootStyle, style);
    return {
      ...base,
      fontSize: (base.fontSize ?? 14) * scale,
      lineHeight: base.lineHeight === undefined ? undefined : base.lineHeight * scale,
    };
  }, [rootStyle, style, scale]);
  const contextValue = React.useMemo<SourceTextContext>(
    () => ({
      style: StyleSheet.flatten([rootStyle, style]) ?? ROOT_STYLE,
      allowFontScaling,
      fontScale: systemFontScale,
    }),
    [rootStyle, style, allowFontScaling, systemFontScale],
  );
  if (Platform.OS !== "ios") {
    const { onSelectionChange: _onSelectionChange, ...textProps } = props;
    return (
      <TextAncestorContext.Provider value={contextValue}>
        <Text ref={nativeTextRef} style={style} {...textProps} allowFontScaling={allowFontScaling}>
          {children}
        </Text>
      </TextAncestorContext.Provider>
    );
  }
  const runs = React.Children.toArray(children).map(
    (
      child,
      index,
    ) => /* oxlint-disable react/no-array-index-key -- Native text runs are stateless positions within the supplied text. */ {
        if (React.isValidElement(child)) return child;
        if (typeof child !== "string" && typeof child !== "number") return null;
        return (
          <T3SourceTextRunNativeComponent
            key={index}
            style={flattenedStyle}
            {...flattenedStyle}
            text={String(child)}
          />
        );
      } /* oxlint-enable react/no-array-index-key */,
  );
  if (ancestor) {
    return <TextAncestorContext.Provider value={contextValue}>{runs}</TextAncestorContext.Provider>;
  }
  return (
    <TextAncestorContext.Provider value={contextValue}>
      <T3SourceTextNativeComponent
        selectable
        {...props}
        allowFontScaling={false}
        style={flattenedStyle}
      >
        {runs}
      </T3SourceTextNativeComponent>
    </TextAncestorContext.Provider>
  );
}
