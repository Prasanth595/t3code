// Comparison (tsx lane, 640×440): which lane to author a board card in. Sizes are the index.html of the
// samples in this folder, compiled with --preset canvas-dark-kobra at nofun-components 8922135e.
import { Comparison, Stack, Text } from "@nofun/artifacts";

const COLUMNS = [
  { title: "Spec", subtitle: "dashboard.spec.json", badge: "Start here", highlight: true },
  { title: "TSX", subtitle: "flow-card.tsx" },
  { title: "Page", subtitle: "brand-page.page.json" },
];

const ROWS = [
  { label: "You write", values: ["Catalog JSON", "React with real blocks", "A json-render page"] },
  { label: "Card size", values: ["960 × 600", "640 × 440", "1200 × 800"] },
  { label: "Standalone", values: ["1.0 MiB", "587 KiB", "3.0 MiB with its product images"] },
  { label: "Linked", values: ["3.7 KiB", "14.8 KiB", false] },
  {
    label: "Best for",
    values: ["Numbers, charts, tables", "Flows and small tools", "Brand landing pages"],
  },
];

export default function LaneComparison() {
  return (
    <Stack gap="md">
      <Text variant="title" text="Spec is the lane to start a board card in" />
      <Comparison
        columns={COLUMNS}
        rows={ROWS}
        caption="index.html sizes, measured Oct 14"
        diffToggle={false}
      />
    </Stack>
  );
}
