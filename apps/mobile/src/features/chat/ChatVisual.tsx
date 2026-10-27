import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  chatVisualDocument,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { postTheme, useHtmlRenderTheme } from "../threads/HtmlRenderWebView";

const TITLE = "Visual";
// Near a small chart, so most visuals grow a little when they appear instead of jumping.
const PLACEHOLDER_HEIGHT = 160;
const MAX_REMEMBERED_SIZES = 200;
const SIZE_MESSAGE_TYPE = "mira-visual-size";

// The page is the top frame here, so it reports its own size instead of posting to a parent.
const SIZE_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body,h=Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:d.getBoundingClientRect().height),x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,k=h+","+x;if(k===last)return;last=k;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(SIZE_MESSAGE_TYPE)},height:h,overflowX:x}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("load",report);window.addEventListener("resize",report);})();true;`;

type VisualSize = { readonly height: number; readonly overflowX: boolean };

// Remounts (reopened chats, list recycling) start at the last measured size instead of jumping.
const measuredSizes = new Map<string, VisualSize>();

function rememberSize(html: string, size: VisualSize) {
  measuredSizes.delete(html);
  measuredSizes.set(html, size);
  if (measuredSizes.size > MAX_REMEMBERED_SIZES) {
    const oldest = measuredSizes.keys().next().value;
    if (oldest !== undefined) measuredSizes.delete(oldest);
  }
}

function readSizeMessage(data: string): VisualSize | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === SIZE_MESSAGE_TYPE &&
      "height" in message &&
      typeof message.height === "number" &&
      Number.isFinite(message.height) &&
      "overflowX" in message &&
      typeof message.overflowX === "boolean"
      ? { height: message.height, overflowX: message.overflowX }
      : null;
  } catch {
    return null;
  }
}

function Placeholder() {
  return (
    <View className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-subtle">
      <AppActivityIndicator />
      <AppText className="text-xs text-foreground-muted">Preparing visual…</AppText>
    </View>
  );
}

/** Renders a ```visual fence from a chat reply, like an html_render result in a thread. */
export function ChatVisual(props: { readonly html: string; readonly complete: boolean }) {
  if (!props.complete) {
    return (
      <View className="my-3" style={{ height: PLACEHOLDER_HEIGHT }}>
        <Placeholder />
      </View>
    );
  }
  return <ChatVisualFrame html={props.html} />;
}

function ChatVisualFrame(props: { readonly html: string }) {
  const [size, setSize] = useState(() => measuredSizes.get(props.html));
  const height =
    size === undefined ? PLACEHOLDER_HEIGHT : Math.min(size.height, HTML_RENDER_MAX_FIT_HEIGHT);
  const shown = size !== undefined;
  const fade = useAnimatedStyle(() => ({ opacity: withTiming(shown ? 1 : 0, { duration: 200 }) }));
  return (
    <View className="my-3" style={{ height }}>
      {/* The page measures its full height while hidden, so it appears once at its final size. */}
      <Animated.View style={[{ flex: 1 }, fade]}>
        <VisualWebView
          html={props.html}
          scrollEnabled={
            size?.overflowX === true || (size?.height ?? 0) > HTML_RENDER_MAX_FIT_HEIGHT
          }
          onSize={(next) => {
            rememberSize(props.html, next);
            setSize(next);
          }}
        />
      </Animated.View>
      {size === undefined ? (
        <View pointerEvents="none" className="absolute inset-0">
          <Placeholder />
        </View>
      ) : null}
    </View>
  );
}

function VisualWebView(props: {
  readonly html: string;
  readonly scrollEnabled: boolean;
  readonly onSize: (size: VisualSize) => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState<HtmlRenderTheme>(theme);
  const [source] = useState(() => ({ html: chatVisualDocument(props.html, initialTheme) }));
  const webView = useRef<WebView<object>>(null);
  useEffect(() => {
    if (theme !== initialTheme) postTheme(webView.current, theme);
  }, [theme, initialTheme]);
  const { onSize } = props;
  return (
    <WebView<object>
      ref={webView}
      source={source}
      accessibilityLabel={TITLE}
      style={{ flex: 1, backgroundColor: "transparent" }}
      allowsInlineMediaPlayback
      scrollEnabled={props.scrollEnabled}
      // Patched Android WebView hands vertical drags back to the chat list at its edges.
      nestedScrollEnabled={props.scrollEnabled}
      bounces={false}
      overScrollMode="never"
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      injectedJavaScript={SIZE_SCRIPT}
      onMessage={(event: WebViewMessageEvent) => {
        const next = readSizeMessage(event.nativeEvent.data);
        if (next !== null) onSize(next);
      }}
      // Links leave the app; the page itself never navigates away from its inline document.
      onShouldStartLoadWithRequest={(request) => {
        if (request.isTopFrame === false || /^(?:about|data):/i.test(request.url)) return true;
        if (/^https?:/i.test(request.url)) void tryOpenExternalUrl(request.url, "html-render");
        return false;
      }}
      onOpenWindow={(event) => {
        const url = event.nativeEvent.targetUrl;
        if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
      }}
    />
  );
}
