// A QR code drawn as an SVG path from the `qrcode` package's module matrix, made in the browser:
// the payload (it carries the pairing code) never leaves the page, and no markup is injected.
// Scanners need dark modules on a light field with a 4-module quiet zone, so the colors are fixed
// in both themes.
import { useMemo } from 'react';
import QRCode from 'qrcode';

/** The SVG path of the dark modules, and the side length including the quiet zone. */
export function qrPath(text: string): { d: string; size: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const n = modules.size;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.data[y * n + x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return { d, size: n + quiet * 2 };
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { d, size } = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      className="devices-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
