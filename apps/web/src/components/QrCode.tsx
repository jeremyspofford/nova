import { useMemo } from 'react'
import { qrMatrix, qrPath, qrRefusal } from '../lib/qr'

/** A setup link as a QR code (S47) — or the reason it cannot be one. */
export function QrCode({ link, size = 208 }: { link: string; size?: number }) {
  const refusal = qrRefusal(link)
  const matrix = useMemo(() => (refusal === null ? qrMatrix(link) : null), [link, refusal])
  if (matrix === null) {
    return (
      <p
        role="alert"
        className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning"
      >
        No QR code: {refusal}.
      </p>
    )
  }
  return (
    <figure className="flex flex-col items-center gap-2">
      <svg
        role="img"
        aria-label={`QR code for ${link}`}
        viewBox={`0 0 ${matrix.size} ${matrix.size}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        className="rounded-md"
      >
        <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
        <path d={qrPath(matrix)} fill="#000000" />
      </svg>
      <figcaption className="max-w-full break-all text-center font-mono text-mono-sm text-content-secondary">
        {link}
      </figcaption>
    </figure>
  )
}
