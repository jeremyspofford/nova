// Wake-on-LAN (M6 plan §2): the hub wakes a sleeping GPU spoke with a magic packet, six 0xFF
// bytes and then the spoke's MAC sixteen times, sent as UDP to the broadcast address of the
// spoke's network. Where it goes is the spoke's own heartbeat (its MAC and its network), or a
// target the person set; tests set a loopback listener, so no packet reaches a real network.
import { createSocket } from 'node:dgram';

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

export function magicPacket(mac: string): Buffer {
  if (!MAC.test(mac)) throw new Error(`${mac} isn’t a MAC address.`);
  const bytes = Buffer.from(mac.split(/[:-]/).map((x) => parseInt(x, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

// "host:port", or a bare host on the usual port 9.
export function parseTarget(t: string): { host: string; port: number } {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(t.trim());
  if (!m) throw new Error(`${t} isn’t a wake target (host:port).`);
  const port = m[2] ? Number(m[2]) : 9;
  if (port < 1 || port > 65535) throw new Error(`${t} has no usable port.`);
  return { host: m[1]!, port };
}

export function sendMagic(mac: string, target: string): Promise<void> {
  const { host, port } = parseTarget(target);
  const packet = magicPacket(mac);
  const sock = createSocket('udp4');
  return new Promise((resolve, reject) => {
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* a unicast target needs no broadcast */ }
      sock.send(packet, port, host, (e) => {
        sock.close();
        if (e) reject(e); else resolve();
      });
    });
  });
}
