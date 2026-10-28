type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export function rehypeTemporaryMedia(temporary: boolean) {
  return (tree: HastNode) => {
    if (!temporary) return;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child.type !== "element") return child;
        if (child.tagName === "img" || child.tagName === "video" || child.tagName === "picture")
          return { type: "text", value: "Keep this thread to load images and videos." };
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}
