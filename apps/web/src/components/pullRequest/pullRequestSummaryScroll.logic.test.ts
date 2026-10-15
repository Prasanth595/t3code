import { describe, expect, it } from "vite-plus/test";

import {
  sectionCollapseAnchorScrollTop,
  shouldCondenseDetailChrome,
} from "./pullRequestSummaryScroll.logic";

describe("section collapse scroll anchoring", () => {
  it("returns the section's natural offset when its heading is pinned", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 600,
        viewportTop: 264,
        sectionTop: -200,
        headingTop: 264,
      }),
    ).toBe(136);
  });

  it("allows a fractional sticky-edge difference", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 500,
        viewportTop: 264,
        sectionTop: 100,
        headingTop: 264.5,
      }),
    ).toBe(336);
  });

  it("leaves the scroll position alone before the heading becomes sticky", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 120,
        viewportTop: 264,
        sectionTop: 320,
        headingTop: 320,
      }),
    ).toBeNull();
  });

  it("does not produce a negative scroll offset", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 20,
        viewportTop: 264,
        sectionTop: 200,
        headingTop: 264,
      }),
    ).toBe(0);
  });
});

describe("detail header condensing", () => {
  // Measured on a one-file diff: a 108px fold that leaves an 80px gap when it condenses.
  const chrome = { foldHeight: 108, chromeDelta: 80, clientHeight: 606 };

  it("keeps the header open when the collapse would leave too little range", () => {
    expect(shouldCondenseDetailChrome({ ...chrome, scrollTop: 146, scrollHeight: 752 })).toBe(
      false,
    );
  });

  it("condenses once a long diff scrolls past the fold", () => {
    expect(shouldCondenseDetailChrome({ ...chrome, scrollTop: 146, scrollHeight: 3000 })).toBe(
      true,
    );
  });
});
