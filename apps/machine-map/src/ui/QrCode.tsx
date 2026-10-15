import { QrCode } from "@t3tools/shared/qrCode";

/** MM-913: a QR code as SVG, one path of dark runs per row. */
export function QrCodeSvg({ value, size = 220 }: { value: string; size?: number }) {
  const qr = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const margin = 2;
  const box = qr.size + margin * 2;
  const runs: Array<string> = [];
  for (let y = 0; y < qr.size; y += 1) {
    let start = -1;
    for (let x = 0; x <= qr.size; x += 1) {
      const dark = x < qr.size && qr.getModule(x, y);
      if (dark && start === -1) start = x;
      if (!dark && start !== -1) {
        runs.push(`M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`);
        start = -1;
      }
    }
  }
  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Invite QR code"
    >
      <rect width={box} height={box} fill="#fff" />
      <path d={runs.join("")} fill="#000" />
    </svg>
  );
}
