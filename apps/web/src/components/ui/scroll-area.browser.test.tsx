import { expect, it } from "vite-plus/test";

import "../../index.css";
import { render } from "../../../test/render";
import { cn } from "../../lib/utils";
import {
  getHorizontalVirtualizedScrollFadeClassName,
  getVirtualizedScrollFadeClassName,
} from "./scroll-area";

it.each(["vertical", "horizontal"] as const)(
  "fades only the requested %s edges and leaves the scrollbar opaque",
  async (axis) => {
    const fadeClassName = (start: boolean, end: boolean) =>
      axis === "vertical"
        ? getVirtualizedScrollFadeClassName({ top: start, bottom: end })
        : getHorizontalVirtualizedScrollFadeClassName({ left: start, right: end });
    await using screen = await render(<div className={fadeClassName(false, true)} />, {
      router: false, // Only native scroll masks are exercised.
    });
    const element = screen.container.firstElementChild!;
    const mask = () => getComputedStyle(element).maskImage;
    const direction = axis === "vertical" ? "" : "to right, ";
    const transparent = "rgba(0, 0, 0, 0)";
    const black = "rgb(0, 0, 0)";
    expect(mask()).toContain(`linear-gradient(${direction}${black}`);
    expect(mask()).toContain(transparent);
    expect(mask()).toContain(`linear-gradient(${black}, ${black})`);
    expect(getComputedStyle(element).maskPosition).toBe(
      axis === "vertical" ? "0% 50%, 100% 50%" : "50% 0%, 50% 100%",
    );

    await screen.rerender(<div className={fadeClassName(true, true)} />);
    expect(mask()).toContain(`linear-gradient(${direction}${transparent}`);
    expect(mask().split(transparent)).toHaveLength(3);

    await screen.rerender(<div className={fadeClassName(true, false)} />);
    expect(mask()).toContain(`linear-gradient(${direction}${transparent}`);
    expect(mask().split(transparent)).toHaveLength(2);

    await screen.rerender(<div className={fadeClassName(false, false)} />);
    expect(mask()).toBe("none");
  },
);

it("intersects both fade axes while preserving both scrollbar lanes", async () => {
  await using screen = await render(
    <div
      className={cn(
        getVirtualizedScrollFadeClassName({ top: true, bottom: true }),
        getHorizontalVirtualizedScrollFadeClassName({ left: true, right: true }),
      )}
    />,
    { router: false /* Only native scroll masks are exercised. */ },
  );
  const style = getComputedStyle(screen.container.firstElementChild!);
  expect(style.maskImage).toContain("linear-gradient(rgba(0, 0, 0, 0)");
  expect(style.maskImage).toContain("to right");
  expect(style.maskPosition).toBe("100% 50%, 50% 100%, 0% 0%, 0% 0%");
  expect(style.maskComposite).toBe("add, add, intersect, add");
  expect(style.maskSize.split(", ").slice(2)).toEqual(["100% 100%", "100% 100%"]);
});

it("sizes a horizontal scrollbar to the lane its fade keeps opaque", () => {
  // Headless Chromium draws overlay scrollbars, so read the rule rather than the lane's size.
  const selectors = (list: CSSRuleList, parent: string): Array<[string, CSSStyleRule]> =>
    Array.from(list).flatMap((rule) => {
      const selector =
        rule instanceof CSSStyleRule ? rule.selectorText.replace("&", parent) : parent;
      const own: Array<[string, CSSStyleRule]> =
        rule instanceof CSSStyleRule ? [[selector, rule]] : [];
      return "cssRules" in rule
        ? [...own, ...selectors((rule as CSSGroupingRule).cssRules, selector)]
        : own;
    });
  const lane = Array.from(document.styleSheets)
    .flatMap((sheet) => selectors(sheet.cssRules, ""))
    .find(
      ([selector]) =>
        selector.includes(".horizontal-virtualized-scroll-fade") &&
        selector.includes("::-webkit-scrollbar"),
    );
  expect(lane?.[1].style.height).toBe("var(--app-scrollbar-width)");
});
