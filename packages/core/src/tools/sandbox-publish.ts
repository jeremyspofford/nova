// Dev servers inside a sandbox, reachable from the Hub (FR-067, FR-097; docs/10 §7, docs/11 §2.2
// and §7). Every sandbox has its own network namespace with only loopback, so a server bound to
// 127.0.0.1:PORT inside cannot be reached by the Hub, the agent browser or the user. A command
// started with `publish: {port}` gets a bridge, the egress forwarder (sandbox-egress.ts) in
// reverse:
//
// - The Hub makes a private folder (0700) with a `share` folder in it (0700), which the substrate
//   bind-mounts at /run/nova/publish. A Hub running as root whose containers run as nobody hands
//   `share` to that user; nothing else is ever opened up.
// - Inside, a forwarder started before the command (Perl in containers, the Hub's own Node under
//   bubblewrap) listens on /run/nova/publish/dev.sock (mode 0600) and, per accepted connection,
//   connects to 127.0.0.1:PORT (then ::1) inside the sandbox and relays both ways.
// - On the Hub, a TCP listener on 127.0.0.1:<a free port> pipes each connection to that socket.
//   Before the first connection the Hub moves the socket out of `share` into the private folder,
//   which the sandbox cannot see, and accepts it only if it is a socket (never a link) with the
//   same inode before and after the move: the sandbox can never point the Hub at another socket.
// - The listener and both folders are removed when the command ends or is killed.
//
// The command's network stays `off`: its namespace still has only loopback and no route out.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, lstatSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovaError } from '@nova/shared';
import { FORWARDER_NODE } from './sandbox-egress.ts';

/** Where the bridge folder is mounted inside the sandbox. */
export const PUBLISH_MOUNT = '/run/nova/publish';
/** The socket the forwarder inside listens on. */
export const PUBLISH_SOCKET = 'dev.sock';

let defaultBase: string | null = null;

/** The folder bridges live in, one per Hub process; substrates hide it inside every root. */
export function publishBase(): string {
  defaultBase ??= join(
    tmpdir().length < 60 ? tmpdir() : '/tmp',
    `nova-publish-${randomBytes(6).toString('hex')}`,
  );
  return defaultBase;
}

/** A TCP port number, or a `validation` error. */
export function checkPublishPort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new NovaError('validation', `the port to publish must be 1-65535, not ${String(port)}`);
  return port;
}

/** One bridge, as a substrate mounts it and the caller reaches it. */
export interface PublishBridge {
  /** The folder the substrate bind-mounts at PUBLISH_MOUNT. */
  readonly dir: string;
  /** The server's port inside the sandbox. */
  readonly port: number;
  /** The Hub-side port on 127.0.0.1. */
  readonly hostPort: number;
  close(): Promise<void>;
}

export interface PublishOptions {
  port: number;
  /**
   * The user the sandbox runs as when that is not the Hub's (a Hub running as root runs its
   * containers as nobody): the shared folder is handed to it so its forwarder can listen there.
   */
  sandboxUser?: { uid: number; gid: number } | null;
  /** The folder bridges live in; defaults to `publishBase()`. */
  base?: string;
  /** How long a connection waits for the forwarder's socket to appear (default 5 s). */
  socketWaitMs?: number;
}

/**
 * The Perl forwarder (containers): listens on the socket (0600), then forks; the parent exits
 * once it listens, so the command starts only when the bridge exists. Each connection is relayed
 * to 127.0.0.1:<port>, or ::1 when nothing listens on IPv4.
 */
export const PERL_PUBLISH_FORWARDER = `use strict; use IO::Socket::UNIX; use IO::Socket::IP; use IO::Select; use POSIX ();
my ($path, $port) = @ARGV;
umask 077;
my $l = IO::Socket::UNIX->new(Local => $path, Listen => 128) or die "nova: dev-server bridge: $!\\n";
chmod 0600, $path;
my $pid = fork(); die "nova: dev-server bridge: $!\\n" unless defined $pid;
exit 0 if $pid;
POSIX::setsid();
open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null');
$SIG{CHLD} = 'IGNORE'; $SIG{PIPE} = 'IGNORE';
while (1) {
  my $c = $l->accept or next;
  my $k = fork();
  if (!defined $k || $k) { close $c; next; }
  close $l;
  my $u;
  for my $h ('127.0.0.1', '::1') { $u = IO::Socket::IP->new(PeerHost => $h, PeerPort => $port, Proto => 'tcp') and last; }
  exit 1 unless $u;
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
 * once that copy listens on the socket.
 */
export const NODE_PUBLISH_FORWARDER = `const net = require('node:net');
const [sock, port] = process.argv.slice(1);
if (process.env.NOVA_FORWARDER_CHILD !== '1') {
  const c = require('node:child_process').spawn(process.execPath, ['-e', process.env.NOVA_PUBLISH_FORWARDER, sock, port], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NOVA_FORWARDER_CHILD: '1' } });
  c.stdout.once('data', () => { c.stdout.destroy(); c.unref(); process.exit(0); });
  c.once('exit', () => process.exit(1));
} else {
  process.stdout.on('error', () => undefined);
  process.umask(0o077);
  const hosts = ['127.0.0.1', '::1'];
  net.createServer({ allowHalfOpen: true }, (c) => {
    c.on('error', () => undefined);
    const attempt = (i) => {
      const u = net.connect({ port: Number(port), host: hosts[i], allowHalfOpen: true });
      let up = false;
      u.once('connect', () => { up = true; c.pipe(u); u.pipe(c); });
      u.on('error', () => { if (!up && i + 1 < hosts.length) attempt(i + 1); else c.destroy(); });
      c.once('close', () => u.destroy());
    };
    attempt(0);
  }).listen(sock, () => {
    require('node:fs').chmodSync(sock, 0o600);
    process.stdout.write('ready\\n');
  });
}
`;

/**
 * The shell prelude that starts the dev-server forwarder before the command. The script is passed
 * in NOVA_PUBLISH_FORWARDER and removed from the command's environment.
 */
export function publishPrelude(runtime: 'perl' | 'node', port: number): string {
  const p = checkPublishPort(port);
  const sock = `${PUBLISH_MOUNT}/${PUBLISH_SOCKET}`;
  const start =
    runtime === 'perl'
      ? `perl -e "$NOVA_PUBLISH_FORWARDER" ${sock} ${p}`
      : `${FORWARDER_NODE} -e "$NOVA_PUBLISH_FORWARDER" ${sock} ${p}`;
  const missing =
    runtime === 'perl'
      ? 'the dev-server bridge could not start in this sandbox (the image needs perl)'
      : 'the dev-server bridge could not start in this sandbox';
  return `${start} || { echo "nova: ${missing}; the command did not run" >&2; exit 125; }; unset NOVA_PUBLISH_FORWARDER NOVA_FORWARDER_CHILD;`;
}

const SOCKET_PATH_MAX = 100;

/** Open a bridge for one command; the substrate mounts `dir` and starts the forwarder. */
export async function openPublish(opts: PublishOptions): Promise<PublishBridge> {
  const port = checkPublishPort(opts.port);
  const base = opts.base ?? publishBase();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  const root = join(base, randomBytes(8).toString('hex'));
  const share = join(root, 'share');
  const offered = join(share, PUBLISH_SOCKET);
  const adopted = join(root, PUBLISH_SOCKET);
  if (Buffer.byteLength(offered) > SOCKET_PATH_MAX)
    throw new NovaError('server_error', `the dev-server bridge path is too long: ${offered}`);
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(share, { mode: 0o700 });
  chmodSync(share, 0o700);
  const remove = () => {
    try {
      rmSync(root, { recursive: true, force: true });
      // The base goes with the last bridge (the next one makes it again).
      rmdirSync(base);
    } catch {
      // Other bridges are open, or the sandbox left a file the Hub cannot remove.
    }
  };
  const user = opts.sandboxUser;
  try {
    if (user && process.getuid?.() === 0 && user.uid !== 0) chownSync(share, user.uid, user.gid);
  } catch (err) {
    remove();
    throw err;
  }
  const waitMs = opts.socketWaitMs ?? 5_000;
  const sockets = new Set<Socket>();
  let inode: { ino: number; dev: number } | null = null;
  let closed = false;

  // The forwarder's socket, moved where the sandbox cannot reach it; false until it exists.
  const adopt = (): boolean => {
    if (inode) {
      try {
        const st = lstatSync(adopted);
        return st.isSocket() && st.ino === inode.ino && st.dev === inode.dev;
      } catch {
        return false;
      }
    }
    let before;
    try {
      before = lstatSync(offered);
    } catch {
      return false;
    }
    if (!before.isSocket()) return false;
    try {
      renameSync(offered, adopted);
      const after = lstatSync(adopted);
      if (after.isSocket() && after.ino === before.ino && after.dev === before.dev) {
        inode = { ino: after.ino, dev: after.dev };
        return true;
      }
    } catch {
      // Swapped or removed meanwhile: refused below.
    }
    rmSync(adopted, { force: true });
    return false;
  };

  const route = async (client: Socket): Promise<void> => {
    const deadline = Date.now() + waitMs;
    while (!adopt()) {
      if (closed || client.destroyed || Date.now() >= deadline) {
        client.destroy();
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (closed || client.destroyed) {
      client.destroy();
      return;
    }
    const upstream = connect({ path: adopted, allowHalfOpen: true });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };

  // Half-open both ways: a client that ends its request still gets the answer.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (closed) {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    void route(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    remove();
    throw err;
  }
  const addr = server.address();
  const hostPort = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    dir: share,
    port,
    hostPort,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      remove();
    },
  };
}
