/**
 * QR codes for the setup links (S47).
 *
 * One pinned, zero-dependency encoder (uqr). Its module matrix is drawn by
 * QrCode.tsx as one SVG path, dark on a white tile in every theme: a phone
 * camera needs contrast, and a themed QR code is one nobody can scan.
 *
 * `qrRefusal` is the rule every QR code in Nova obeys (spec s47 §10): only an
 * https address with a DNS name. Loopback, any IP address and plain http open
 * nothing on another device — a phone cannot reach this machine's loopback and
 * cannot trust a certificate for an IP — so they are refused, with the reason,
 * instead of being drawn.
 */
import { encode } from 'uqr'

export interface QrMatrix {
  size: number
  dark: boolean[][]
}

export function qrMatrix(link: string): QrMatrix {
  const { size, data } = encode(link, { ecc: 'M', border: 4 })
  return { size, dark: data }
}

export function qrPath(m: QrMatrix): string {
  let d = ''
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.dark[y][x]) d += `M${x} ${y}h1v1h-1z`
    }
  }
  return d
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export function qrRefusal(link: string): string | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return 'not a link'
  }
  if (url.protocol !== 'https:') return 'only an https address opens on another device'
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return `${host} is this machine only`
  if (IPV4.test(host) || host.startsWith('[')) {
    return `${host} is an IP address, which a phone cannot trust and may not reach`
  }
  return null
}
