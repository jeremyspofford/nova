// Wake-on-LAN magic packets (FR-144, docs/23 §5.3). In M6 the Hub sends the packet itself as a
// UDP broadcast on its LAN; a Wake Helper on the target's LAN sends it from M6.5 (FR-138).
import { createSocket } from 'node:dgram';

/** Six bytes of a MAC address (`aa:bb:cc:dd:ee:ff`, `aa-bb-…` or 12 hex digits), or null. */
export function parseMac(mac: string): Buffer | null {
  const hex = mac.trim().toLowerCase().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  const sep = mac.trim().replace(/[0-9a-fA-F]/g, '');
  // Either no separators or five of one kind.
  if (sep !== '' && !/^(:{5}|-{5})$/.test(sep)) return null;
  const bytes = Buffer.from(hex, 'hex');
  // A broadcast or all-zero address is never a NIC.
  if (bytes.every((b) => b === 0) || bytes.every((b) => b === 0xff)) return null;
  return bytes;
}

/** The 102-byte magic packet: six 0xFF bytes, then the MAC sixteen times. */
export function magicPacket(mac: string): Buffer {
  const bytes = parseMac(mac);
  if (!bytes) throw new TypeError(`not a MAC address: ${mac}`);
  const out = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) bytes.copy(out, 6 + i * 6);
  return out;
}

export interface WolTarget {
  /** Broadcast address of the target's LAN (default 255.255.255.255). */
  address?: string;
  /** UDP port (default 9, the discard port). */
  port?: number;
}

/** Send the magic packet for `mac` as a UDP broadcast. */
export async function sendMagicPacket(mac: string, target: WolTarget = {}): Promise<void> {
  const packet = magicPacket(mac);
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.setBroadcast(true);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, target.port ?? 9, target.address ?? '255.255.255.255', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}
