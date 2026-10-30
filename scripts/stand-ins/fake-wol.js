#!/usr/bin/env node
// A stand-in Wake-on-LAN listener: a UDP socket on loopback that takes magic packets (six 0xFF
// bytes, then the target's MAC sixteen times) and says which MAC each one woke. Tests point Nova's
// wake target at it, so no packet ever goes to a real network's broadcast address.
//
// As a module (tests):  const w = await startFakeWol({ onWake: (mac) => … });
//                       w.target ("127.0.0.1:<port>"), w.packets, await w.close()
// From the command line (the gate): node scripts/stand-ins/fake-wol.js [--port 0]
//   It prints "fake-wol listening at 127.0.0.1:<port>" and a line per packet: "wake <mac>".
import { createSocket } from 'node:dgram';
import { pathToFileURL } from 'node:url';

// The MAC a magic packet names, or null if it isn't one.
export function magicMac(buf) {
  if (buf.length < 102) return null;
  for (let i = 0; i < 6; i++) if (buf[i] !== 0xff) return null;
  const mac = buf.subarray(6, 12);
  for (let r = 1; r < 16; r++) if (!buf.subarray(6 + r * 6, 12 + r * 6).equals(mac)) return null;
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/** @param {{ port?: number, onWake?: (mac: string) => void }} [opts] */
export function startFakeWol(opts = {}) {
  const packets = [];
  const sock = createSocket('udp4');
  sock.on('message', (msg, from) => {
    const mac = magicMac(msg);
    packets.push({ mac, from: `${from.address}:${from.port}`, at: new Date().toISOString(), bytes: msg.length });
    if (mac) opts.onWake?.(mac);
  });
  return new Promise((resolveStart, fail) => {
    sock.once('error', fail);
    sock.bind(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = sock.address();
      resolveStart({ target: `127.0.0.1:${port}`, port, packets, close: () => new Promise((r) => sock.close(() => r())) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const w = await startFakeWol({ port: i > 0 ? Number(process.argv[i + 1]) : 0, onWake: (mac) => console.log(`wake ${mac}`) });
  console.log(`fake-wol listening at ${w.target}`);
}
