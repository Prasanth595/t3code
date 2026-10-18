import mediumZoom, { type Zoom } from "medium-zoom";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { nextTick, onMounted, watch } from "vue";

import "./custom.css";

export default {
  extends: DefaultTheme,
  // Click an image to see it full size. Both halves of a light/dark screenshot pair are attached,
  // but the hidden one is `display: none`, so only the visible one can be clicked.
  setup() {
    const route = useRoute();
    // Made on mount, not in setup, so it never runs during SSR or before hydration.
    let zoom: Zoom | undefined;
    onMounted(() => {
      zoom = mediumZoom(".vp-doc img", { background: "var(--vp-c-bg)" });
    });
    watch(
      () => route.path,
      () => nextTick(() => zoom?.detach().attach(".vp-doc img")),
    );
  },
};
