// @effect-diagnostics nodeBuiltinImport:off - exercises the installed web bundles without loading React.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createContainer(weights: ReadonlyArray<number>, nativeMove: boolean) {
  const elements = weights.map((weight, id) => ({
    id,
    querySelectorAll: () => ({ length: weight - 1 }),
  }));
  type Element = (typeof elements)[number];
  const children = [...elements];
  const moved: number[] = [];
  const move = (element: Element, reference: Element | null) => {
    children.splice(children.indexOf(element), 1);
    children.splice(reference === null ? children.length : children.indexOf(reference), 0, element);
    moved.push(element.id);
  };
  return {
    elements,
    moved,
    container: {
      children,
      moveBefore: nativeMove ? move : undefined,
      insertBefore: move,
      appendChild: (element: Element) => move(element, null),
    },
  };
}

function loadSort(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const code = source.slice(
    source.indexOf("function moveChildBefore("),
    source.indexOf("// src/hooks/useDOMOrder.ts"),
  );
  return NodeVM.runInNewContext(`${code}\n(sortDOMElements)`) as (
    container: ReturnType<typeof createContainer>["container"],
    indices: Map<ReturnType<typeof createContainer>["elements"][number], number>,
  ) => void;
}

describe.each(["react.js", "react.mjs", "react-native.web.js", "react-native.web.mjs"])(
  "DOM order (%s)",
  (bundle) => {
    it.each([true, false])("keeps expensive rows still with native move=%s", (nativeMove) => {
      const sort = loadSort(bundle);
      for (const { weights, order, stationary } of [
        { weights: [6000, 2, 2], order: [1, 2, 0], stationary: 0 },
        { weights: [6000, 2, 2, 2], order: [1, 2, 0, 3], stationary: 0 },
        { weights: [2, 2, 6000], order: [2, 0, 1], stationary: 2 },
        { weights: [2, 2, 6000, 2], order: [0, 2, 1, 3], stationary: 2 },
      ]) {
        const fixture = createContainer(weights, nativeMove);
        sort(fixture.container, new Map(order.map((id, index) => [fixture.elements[id]!, index])));
        expect(fixture.container.children.map((element) => element.id)).toEqual(order);
        expect.soft(fixture.moved).not.toContain(stationary);
      }
    });

    it.each([true, false])("moves one cheap row with native move=%s", (nativeMove) => {
      const fixture = createContainer([1, 10, 10], nativeMove);
      using laterTree = vi.spyOn(fixture.elements[2]!, "querySelectorAll");
      loadSort(bundle)(
        fixture.container,
        new Map([1, 2, 0].map((id, index) => [fixture.elements[id]!, index])),
      );
      expect(fixture.container.children.map((element) => element.id)).toEqual([1, 2, 0]);
      expect(fixture.moved).toEqual([0]);
      expect(laterTree).not.toHaveBeenCalled();
    });
  },
);
