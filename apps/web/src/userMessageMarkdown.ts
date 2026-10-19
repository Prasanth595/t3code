import type { Root, RootContent } from "mdast";

function remarkPreserveListMarkers() {
  return (tree: Root, file: { value: unknown }) => {
    const markdown = String(file.value);
    const visit = (node: Root | RootContent) => {
      if (node.type === "list" && node.ordered) {
        for (const item of node.children) {
          const offset = item.position?.start.offset;
          if (offset === undefined) continue;
          const marker = /^(\d{1,9})[.)](?=\s|$)/.exec(markdown.slice(offset, offset + 11));
          if (!marker) continue;
          item.data = {
            ...item.data,
            hProperties: {
              ...item.data?.hProperties,
              value: Number(marker[1]),
              dataSourceListMarker: marker[0],
            },
          };
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

// User bubbles match the source markers shown in the composer; assistant
// Markdown retains its normal sequential counters.
export const USER_MESSAGE_REMARK_PLUGINS = [remarkPreserveListMarkers];
