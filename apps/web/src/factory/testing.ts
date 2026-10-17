import { act, type ReactElement } from "react";
import {
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
  type ReactTestRendererNode,
} from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flatten = (
  node: ReactTestRendererNode | ReadonlyArray<ReactTestRendererNode> | null,
): string => {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten((node as ReactTestRendererJSON).children);
};

/** Renders `element` and returns the renderer with helpers to read it. */
export async function render(element: ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return {
    renderer,
    /** All rendered text, concatenated. */
    text: () => flatten(renderer.toJSON()),
    /** Host elements of `type` (`a`, `button`, ...). */
    all: (type: string): ReadonlyArray<ReactTestInstance> => renderer.root.findAllByType(type),
    /** The `button` whose text is `label`. */
    button: (label: string): ReactTestInstance | undefined =>
      renderer.root.findAllByType("button").find((b) => flatten(b.children as never) === label),
    unmount: () => act(() => renderer.unmount()),
  };
}
