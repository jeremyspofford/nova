// Preloaded into Nova's process by the acceptance test (node --import). Any TCP connection to a
// host that isn't this machine is written to NOVA_EGRESS_LOG and refused, so "local-only" is
// checked, not assumed. (UDP is not covered; nothing in the core uses it.)
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
// The mesh's own addresses (a test's hub and standby on this machine's network address) are inside
// the mesh, which local-only allows; a test names them in NOVA_EGRESS_ALLOW. Everything else is
// still refused and logged.
for (const h of (process.env.NOVA_EGRESS_ALLOW ?? '').split(',').map((x) => x.trim()).filter(Boolean)) LOOPBACK.add(h);
const log = process.env.NOVA_EGRESS_LOG;
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
  // net.connect() hands socket.connect() an already-normalized array: [options, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = (typeof first === 'object' && first !== null ? first : {}) as { host?: string; path?: string; port?: number };
  const host = typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : opts.path ? 'localhost' : opts.host ?? 'localhost';
  if (!LOOPBACK.has(host)) {
    if (log) appendFileSync(log, `${new Date().toISOString()} ${host}:${opts.port ?? first}\n`);
    throw new Error(`egress refused: ${host}`);
  }
  return (original as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
