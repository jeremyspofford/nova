// The agent's web_fetch never reaches Nova itself or the person's own network (Amendment
// 2026-10-30-C Part 3, the SSRF guard). Nova's console answers any request from this machine as the
// person, so a page that talked the agent into fetching http://localhost:<port>/api/v1/memory read
// everything Nova knows, without asking. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TOOLS } from '../src/tools.js';
import { publicAddress, safeFetch, Refused } from '../src/safe-fetch.js';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('only public, unicast addresses count as the public web', () => {
  for (const a of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(publicAddress(a), true, a);
  for (const a of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.100.100.100', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1', 'not-an-ip']) {
    assert.equal(publicAddress(a), false, a);
  }
});

// IPv6 ranges that carry or tunnel to an IPv4 address (or are otherwise not one host on the public
// web): 6to4 (2002::/16, whose next 32 bits are an IPv4 address, 2002:7f00:1:: being 127.0.0.1),
// Teredo (2001::/32), IPv4-compatible (::/96), the local-use NAT64 prefix (64:ff9b:1::/48), ORCHID
// and the benchmarking range. All are refused, whatever IPv4 address they carry.
test('IPv6 addresses that carry an IPv4 address, or tunnel to one, are never the public web', () => {
  for (const a of ['2002:7f00:1::', '2002:7f00:0001::1', '2002:0a00:0001::1', '2002:5db8:d70e::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1',
    '::127.0.0.1', '::7f00:1', '::10.0.0.1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b:1::1', '2001:10::1', '2001:20::1', '2001:2::1']) {
    assert.equal(publicAddress(a), false, a);
  }
  // Other 2001: space is the public web (2001:4860:: is a public resolver's).
  for (const a of ['2001:4860:4860::8888', '2606:4700::1111', '2a00:1450:4001::1']) assert.equal(publicAddress(a), true, a);
});

test('web_fetch refuses Nova’s own console and anything on this machine or the private network', async () => {
  const { server, port } = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[{"content":"a private note"}]'); });
  try {
    for (const url of [`http://127.0.0.1:${port}/api/v1/memory`, `http://localhost:${port}/api/v1/memory`, `http://[::1]:${port}/`,
      'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.100/', 'http://[::ffff:127.0.0.1]/',
      'https://example-hub.example-tailnet.ts.net/', 'http://printer.local/']) {
      await assert.rejects(TOOLS.web_fetch.run({ url }, {}), (e) => /not the public web/.test(e.message), url);
    }
  } finally { server.close(); }
});

test('a name is checked where it resolves, and the connection goes to the address that was checked', async () => {
  const { server, port } = await serve((req, res) => res.end('should never be read'));
  try {
    // A stand-in rule that refuses this machine: "localhost" resolves to it, and is refused.
    await assert.rejects(safeFetch(`http://localhost:${port}/`, { allow: (a) => a !== '127.0.0.1' && a !== '::1' }), Refused);
  } finally { server.close(); }
});

test('a redirect to a refused address is refused, however the first page looked', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: `http://127.0.0.2:${port}/api/v1/memory` }); res.end(); return; }
    res.end('private');
  });
  try {
    // The first page is allowed (a stand-in for a public site); where it sends the agent is not.
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/start`, { allow: (a) => a === '127.0.0.1' }), Refused);
  } finally { server.close(); }
});
