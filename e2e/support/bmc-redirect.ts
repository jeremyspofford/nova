// Loaded into the Hub process with `node --import` for J9.5 (out-of-band management, FR-147): the
// Hub's TLS connections to a BMC at a stand-in address reach the fake Redfish BMC on loopback.
// NOVA_E2E_BMC_REDIRECT is `<stand-in IP>=<real IP>` (for example `192.0.2.80=127.0.0.1`).
//
// Why: the Hub refuses BMC addresses that are loopback, link-local or its own interface addresses
// (packages/core/src/oob/address.ts), when the owner enters them and again before it connects,
// and the test-only `allowLoopbackForTests` is never set by app.ts. In the E2E container every
// address a local fake can listen on is one of those. The owner enters the stand-in address (a
// TEST-NET-1 address, not one of this machine's), every check runs on it as entered, and only the
// TCP connection under the TLS handshake goes to the fake instead: the certificate pinning, the
// credentials and the approvals all run for real.
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';

const spec = process.env.NOVA_E2E_BMC_REDIRECT ?? '';
const [from, to] = spec.split('=');

if (from && to) {
  const real = tls.connect;
  const patched = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    if (typeof first === 'object' && first !== null && (first as { host?: unknown }).host === from)
      args[0] = { ...first, host: to };
    return (real as (...a: unknown[]) => tls.TLSSocket).apply(this, args);
  } as typeof tls.connect;
  tls.connect = patched;
  // `import { connect } from 'node:tls'` in the Hub's modules sees the patched function.
  syncBuiltinESMExports();
}
