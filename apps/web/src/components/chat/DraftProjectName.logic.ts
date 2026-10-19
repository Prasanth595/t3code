const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The container is sized by the DOM layout of the full name, while `measure` is a canvas
// `measureText`. Layout snaps widths to 1/64px and canvas does not, so a name that exactly
// fits can measure a hair wider and get truncated. One pixel absorbs that, and the container
// clips any overhang.
const MEASURE_TOLERANCE_PX = 1;

export function truncateProjectName(
  value: string,
  availableWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(value) <= availableWidth + MEASURE_TOLERANCE_PX) return value;
  if (measure("…") > availableWidth) return "";

  const characters = Array.from(graphemes.segment(value), (part) => part.segment);
  const candidate = (count: number) => {
    const head = characters.slice(0, Math.floor(count / 2)).join("");
    const tailCount = Math.ceil(count / 2);
    const tail = tailCount > 0 ? characters.slice(-tailCount).join("") : "";
    return `${head}…${tail}`;
  };

  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (measure(candidate(count)) <= availableWidth) low = count;
    else high = count - 1;
  }
  return candidate(low);
}
