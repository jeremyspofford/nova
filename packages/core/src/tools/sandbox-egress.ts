// How a sandbox reaches the egress proxy (docs/11 §2.2, §2.5 and §7, docs/12 §8). Every
// substrate gives the sandbox its own network namespace with only loopback, bind-mounts the
// session's proxy socket at /run/nova/egress, and starts a small forwarder inside that listens on
// 127.0.0.1:3128 and relays each connection to that socket. The socket is the only route out,
// and the proxy behind it enforces the policy, so the sandbox cannot bypass it: there is no
// interface, route or DNS server to use instead. Only proxy and CA-bundle variables are passed.
//
// The forwarder is a short Perl script in containers (Perl is part of every Debian-based image,
// including the default one) and Node (the Hub's own binary, mounted read-only) under
// bubblewrap. An image without Perl cannot reach the network and says so; it never falls back to
// an open network.
import type { SandboxExecRequest } from './sandbox-process.ts';

/** What a substrate needs to open the proxy session for one command. */
export interface SandboxEgressContext {
  accountId: string | null;
  threadId: string | null;
  network: 'allowlist' | 'limited';
  /** The scope the network policy belongs to, when the caller knows it (an agent's computer). */
  scope: { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string } | null;
  /** An explicit policy replacing the scopes' (ExecRequestExtras `egress.policy`). */
  policy?: EgressPolicyOverride;
}

/**
 * A command's own network policy (an external agent, FR-203): it may reach only `allow`; the
 * global mode and deny list still apply, and no credential is ever injected.
 */
export interface EgressPolicyOverride {
  allow: string[];
}

/** One proxy session, as a substrate mounts it. */
export interface SandboxEgressSession {
  /** Folder with the proxy socket and the CA bundle, mounted at EGRESS_MOUNT. */
  dir: string;
  socketName: string;
  caBundleName: string | null;
  close(): Promise<void>;
}

/**
 * Opens a proxy session per sandboxed command. Null means the effective policy is `off` (the
 * command runs without network); a throw means the proxy is expected but cannot be used, and
 * the command runs without network and is told why (docs/11 §10, fail closed).
 */
export interface SandboxEgress {
  open(ctx: SandboxEgressContext): Promise<SandboxEgressSession | null>;
}

export const EGRESS_MOUNT = '/run/nova/egress';
export const FORWARDER_PORT = 3128;
/** Where bubblewrap mounts the Hub's Node binary for the forwarder. */
export const FORWARDER_NODE = '/run/nova/node';

/** Proxy and CA variables for the sandbox (the only network configuration it gets). */
export function proxyEnv(session: SandboxEgressSession): Record<string, string> {
  const proxy = `http://127.0.0.1:${FORWARDER_PORT}`;
  const env: Record<string, string> = {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    // The sandbox's own loopback (a dev server inside it) is reached directly.
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
  if (session.caBundleName) {
    const bundle = `${EGRESS_MOUNT}/${session.caBundleName}`;
    Object.assign(env, {
      SSL_CERT_FILE: bundle,
      CURL_CA_BUNDLE: bundle,
      REQUESTS_CA_BUNDLE: bundle,
      PIP_CERT: bundle,
      GIT_SSL_CAINFO: bundle,
      NODE_EXTRA_CA_CERTS: bundle,
      AWS_CA_BUNDLE: bundle,
      CARGO_HTTP_CAINFO: bundle,
    });
  }
  return env;
}

/**
 * The Perl forwarder: binds 127.0.0.1:<port>, then forks; the parent exits once the port is
 * bound (so the command starts only when the route exists) and the child relays connections.
 */
export const PERL_FORWARDER = `use strict; use IO::Socket::INET; use IO::Socket::UNIX; use IO::Select; use POSIX ();
my ($path, $port) = @ARGV;
my $l = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $port, Proto => 'tcp', Listen => 128, ReuseAddr => 1) or die "nova: network forwarder: $!\\n";
my $pid = fork(); die "nova: network forwarder: $!\\n" unless defined $pid;
exit 0 if $pid;
POSIX::setsid();
open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null');
$SIG{CHLD} = 'IGNORE'; $SIG{PIPE} = 'IGNORE';
while (1) {
  my $c = $l->accept or next;
  my $k = fork();
  if (!defined $k || $k) { close $c; next; }
  close $l;
  my $u = IO::Socket::UNIX->new(Peer => $path) or exit 1;
  my $sel = IO::Select->new($c, $u);
  my $open = 2;
  while ($open > 0) {
    for my $r ($sel->can_read) {
      my $w = ($r == $c) ? $u : $c;
      my $n = sysread($r, my $buf, 65536);
      if (!$n) { $sel->remove($r); shutdown($w, 1); $open--; next; }
      my $off = 0;
      while ($off < $n) { my $m = syswrite($w, $buf, $n - $off, $off); exit 0 unless defined $m; $off += $m; }
    }
  }
  exit 0;
}
`;

/**
 * The Node forwarder (bubblewrap): the first process starts a detached copy of itself and exits
 * once that copy reports the port bound.
 */
export const NODE_FORWARDER = `const net = require('node:net');
const [sock, port] = process.argv.slice(1);
if (process.env.NOVA_FORWARDER_CHILD !== '1') {
  const c = require('node:child_process').spawn(process.execPath, ['-e', process.env.NOVA_EGRESS_FORWARDER, sock, port], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NOVA_FORWARDER_CHILD: '1' } });
  c.stdout.once('data', () => { c.stdout.destroy(); c.unref(); process.exit(0); });
  c.once('exit', () => process.exit(1));
} else {
  process.stdout.on('error', () => undefined);
  net.createServer((c) => {
    const u = net.connect(sock);
    c.on('error', () => u.destroy());
    u.on('error', () => c.destroy());
    c.pipe(u);
    u.pipe(c);
  }).listen(Number(port), '127.0.0.1', () => process.stdout.write('ready\\n'));
}
`;

/**
 * The shell prelude that starts the forwarder before the command (`$1`). The script itself is
 * passed in NOVA_EGRESS_FORWARDER and removed from the command's environment.
 */
export function forwarderPrelude(runtime: 'perl' | 'node', socketName: string): string {
  const sock = `${EGRESS_MOUNT}/${socketName}`;
  const start =
    runtime === 'perl'
      ? `perl -e "$NOVA_EGRESS_FORWARDER" ${sock} ${FORWARDER_PORT}`
      : `${FORWARDER_NODE} -e "$NOVA_EGRESS_FORWARDER" ${sock} ${FORWARDER_PORT}`;
  const missing =
    runtime === 'perl'
      ? 'the network forwarder could not start in this sandbox (the image needs perl)'
      : 'the network forwarder could not start in this sandbox';
  return `${start} || { echo "nova: ${missing}; the command did not run" >&2; exit 125; }; unset NOVA_EGRESS_FORWARDER NOVA_FORWARDER_CHILD;`;
}

/** The egress context of a request: the computer's, else the exec tool's owner. */
export function egressContext(req: SandboxExecRequest): SandboxEgressContext | null {
  if (req.network === 'off') return null;
  const owner = (req as { owner?: { accountId?: unknown; threadId?: unknown } }).owner;
  const accountId =
    req.egress?.accountId ?? (typeof owner?.accountId === 'string' ? owner.accountId : null);
  const threadId =
    req.egress?.threadId ?? (typeof owner?.threadId === 'string' ? owner.threadId : null);
  const ctx: SandboxEgressContext = {
    accountId,
    threadId,
    network: req.network,
    scope: req.egress?.scope ?? null,
  };
  if (req.egress?.policy) ctx.policy = { allow: [...req.egress.policy.allow] };
  return ctx;
}

/** Open the request's proxy session; a failure is a note and no network (fail closed). */
export async function openEgress(
  egress: SandboxEgress | undefined,
  req: SandboxExecRequest,
): Promise<{ session: SandboxEgressSession | null; note?: string }> {
  const ctx = egressContext(req);
  if (!egress || !ctx) return { session: null };
  try {
    return { session: await egress.open(ctx) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { session: null, note: `nova: this command has no network: ${why}` };
  }
}
