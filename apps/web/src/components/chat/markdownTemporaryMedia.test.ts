import { expect, it } from "vite-plus/test";
import { rehypeTemporaryMedia } from "./markdownTemporaryMedia";

type Root = Parameters<ReturnType<typeof rehypeTemporaryMedia>>[0];

const image = (src: string) => ({
  type: "element",
  tagName: "img",
  properties: { src, alt: "Preview" },
  children: [],
});

it.each(["https://example.com/cacheable.png", "//example.com/cacheable.mp4", "./private.png"])(
  "replaces temporary media before a resource can mount: %s",
  (src) => {
    const tree: Root = {
      type: "root",
      children: [{ type: "element", tagName: "p", properties: {}, children: [image(src)] }],
    };
    rehypeTemporaryMedia(true)(tree);
    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [{ type: "text", value: "Keep this thread to load images and videos." }],
      },
    ]);
  },
);

it("removes raw video sources and poster requests before mounting", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "video",
        properties: {
          src: "https://example.com/cacheable.mp4",
          poster: "https://example.com/cacheable.png",
        },
        children: [
          {
            type: "element",
            tagName: "source",
            properties: { src: "https://example.com/other.mp4" },
            children: [],
          },
        ],
      },
    ],
  };
  rehypeTemporaryMedia(true)(tree);
  expect(tree.children).toEqual([
    { type: "text", value: "Keep this thread to load images and videos." },
  ]);
});

it("keeps text, links, and code unchanged", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com/image.png" },
        children: [{ type: "text", value: "Open image" }],
      },
      {
        type: "element",
        tagName: "code",
        properties: {},
        children: [{ type: "text", value: '<img src="https://example.com/example.png">' }],
      },
    ],
  };
  const original = structuredClone(tree);
  rehypeTemporaryMedia(true)(tree);
  expect(tree).toEqual(original);
});

it("leaves media unchanged for saved threads and after Keep", () => {
  const original: Root = {
    type: "root",
    children: [
      image("https://example.com/cacheable.png"),
      {
        type: "element",
        tagName: "video",
        properties: { src: "https://example.com/cacheable.mp4" },
        children: [],
      },
    ],
  };
  const tree = structuredClone(original);
  rehypeTemporaryMedia(false)(tree);
  expect(tree).toEqual(original);
});
