#!/usr/bin/env node
// A stand-in for the stable mesh name (M10g), for the promotion drill and its tests only: a TCP
// forwarder on 127.0.0.1 that passes every connection on to whichever Nova it points at, and a
// control endpoint Nova's stable-name driver asks to point it elsewhere (NOVA_MESH_NAME_CONTROL).
// It stands for a DNS name or a tailnet address; nothing real is changed (the ADR's Hard limits).
//
//   import { startStableName } from './scripts/stand-ins/stable-name.js'
//   const name = await startStableName({ target: 'http://127.0.0.1:1234' });
//   name.url        the name devices use (http://127.0.0.1:<port>)
//   name.control    where Nova asks to move it (POST {address})
//   name.target()   where it points now;  name.point(address) moves it as the test
//   name.stuck(true) makes it answer "moved" and stay where it is (a change that didn't take)
//   name.moves()    every move asked for, in order;  await name.close()
import { createServer as http } from 'node:http';
import { connect, createServer as tcp } from 'node:net';
import { pathToFileURL } from 'node:url';

/** @param {{ target?: string | null }} o */
export async function startStableName(o = {}) {
  let target = o.target ? new URL(o.target) : null;
  let stuck = false;
  const moves = [];
  const sockets = new Set();
  const forward = tcp((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    if (!target) { client.destroy(); return; }
    const up = connect(Number(target.port), target.hostname);
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    client.pipe(up);
    up.pipe(client);
    const end = () => { client.destroy(); up.destroy(); };
    client.on('error', end);
    up.on('error', end);
  });
  const control = http((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let address = null;
      try { address = new URL(JSON.parse(body).address); } catch { /* below */ }
      if (!address || address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'This stand-in points only at loopback addresses.' }));
        return;
      }
      moves.push({ address: address.origin, stuck, at: new Date().toISOString() });
      // Connections already open (kept alive) went to the old place: a moved name starts afresh.
      if (!stuck) { target = address; for (const s of sockets) s.destroy(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, address: address.origin }));
    });
  });
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  const port = await listen(forward);
  const cport = await listen(control);
  return {
    url: `http://127.0.0.1:${port}`,
    control: `http://127.0.0.1:${cport}/point`,
    target: () => (target ? target.origin : null),
    point: (address) => { target = address ? new URL(address) : null; for (const s of sockets) s.destroy(); },
    stuck: (v) => { stuck = !!v; },
    moves: () => [...moves],
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all([new Promise((r) => forward.close(r)), new Promise((r) => { control.closeAllConnections?.(); control.close(r); })]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = await startStableName({ target: process.argv[2] ?? null });
  console.log(JSON.stringify({ url: n.url, control: n.control, target: n.target() }));
}
