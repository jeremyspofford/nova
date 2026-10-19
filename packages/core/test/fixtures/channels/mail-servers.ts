// Local mail servers for the email channel tests (offline, 127.0.0.1, plain sockets): a small
// IMAP4rev1 server that speaks what imapflow uses (CAPABILITY, LOGIN, NAMESPACE, LIST, EXAMINE /
// SELECT, UID FETCH of sizes and whole messages, IDLE with EXISTS, NOOP, LOGOUT) over one folder,
// recording which message bodies it sent, and an SMTP
// server (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT) that records what it was sent.
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FakeImap {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Add a message to the folder; returns its UID (and tells idling clients). */
  deliver(raw: string): number;
  /** Start the folder over with a new UIDVALIDITY (the server reset its UIDs). */
  reset(validity: number): void;
  logins: { user: string; ok: boolean }[];
  commands: string[];
  /** UIDs whose whole message was sent, in order. */
  bodiesSent: number[];
  /** Cut every connection now (a server restart, a network drop). */
  dropAll(): void;
  /** Cut the connection of the next N clients that ask for message bodies, mid-fetch. */
  dropOnBodyFetch: number;
  /** Clients in IDLE now. */
  idling(): number;
  close(): Promise<void>;
}

const CAPS = 'IMAP4rev1 IDLE NAMESPACE UIDPLUS';

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

/** IMAP arguments: atoms and quoted strings. */
function args(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? unquote(`"${m[1]}"`) : m[2]!);
  return out;
}

function inSet(uid: number, set: string, max: number): boolean {
  return set.split(',').some((part) => {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    if (b === undefined) return uid === lo;
    const hi = b === '*' ? max : Number(b);
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
  });
}

export async function startFakeImap(
  opts: { user?: string; password?: string; folder?: string } = {},
): Promise<FakeImap> {
  const user = opts.user ?? 'nova@example.com';
  const password = opts.password ?? 'imap-app-password-1';
  const folder = opts.folder ?? 'INBOX';
  let validity = 1;
  let nextUid = 1;
  let messages: { uid: number; raw: Buffer }[] = [];
  const idlers = new Set<Socket>();
  const logins: FakeImap['logins'] = [];
  const commands: string[] = [];
  const bodiesSent: number[] = [];
  const sockets = new Set<Socket>();
  const state = { dropOnBodyFetch: 0 } as FakeImap;

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => {
      sockets.delete(sock);
      idlers.delete(sock);
    });
    sock.on('error', () => undefined);
    let authed = false;
    let selected = false;
    let idleTag: string | null = null;
    let buf = '';
    const send = (s: string) => {
      if (!sock.destroyed) sock.write(s);
    };
    send(`* OK [CAPABILITY ${CAPS}] fake IMAP ready\r\n`);
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handle(line);
      }
    });
    const handle = (line: string) => {
      if (idleTag) {
        if (line.trim().toUpperCase() === 'DONE') {
          idlers.delete(sock);
          send(`${idleTag} OK IDLE terminated\r\n`);
          idleTag = null;
        }
        return;
      }
      const sp = line.indexOf(' ');
      const tag = line.slice(0, sp);
      let rest = line.slice(sp + 1);
      let uidMode = false;
      if (/^UID /i.test(rest)) {
        uidMode = true;
        rest = rest.slice(4);
      }
      const csp = rest.indexOf(' ');
      const cmd = (csp < 0 ? rest : rest.slice(0, csp)).toUpperCase();
      const a = csp < 0 ? '' : rest.slice(csp + 1);
      commands.push(`${uidMode ? 'UID ' : ''}${cmd}`);
      const ok = (text = 'done') => send(`${tag} OK ${text}\r\n`);
      switch (cmd) {
        case 'CAPABILITY':
          send(`* CAPABILITY ${CAPS}\r\n`);
          return ok();
        case 'NOOP':
          return ok();
        case 'LOGIN': {
          const [u, p] = args(a);
          const good = u === user && p === password;
          logins.push({ user: u ?? '', ok: good });
          if (!good) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          authed = true;
          return ok(`[CAPABILITY ${CAPS}] logged in`);
        }
        case 'LOGOUT':
          send('* BYE logging out\r\n');
          ok();
          sock.end();
          return;
        default:
          break;
      }
      if (!authed) return send(`${tag} NO not authenticated\r\n`);
      switch (cmd) {
        case 'NAMESPACE':
          send('* NAMESPACE (("" "/")) NIL NIL\r\n');
          return ok();
        case 'LIST':
          send(`* LIST (\\HasNoChildren) "/" ${folder}\r\n`);
          return ok();
        case 'SELECT':
        case 'EXAMINE': {
          const [name] = args(a);
          if ((name ?? '').toUpperCase() !== folder.toUpperCase())
            return send(`${tag} NO no such folder\r\n`);
          selected = true;
          send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
          send('* OK [PERMANENTFLAGS ()] read-only\r\n');
          send(`* ${messages.length} EXISTS\r\n`);
          send(`* OK [UIDVALIDITY ${validity}] UIDs valid\r\n`);
          send(`* OK [UIDNEXT ${nextUid}] predicted next UID\r\n`);
          return ok(cmd === 'EXAMINE' ? '[READ-ONLY] done' : '[READ-WRITE] done');
        }
        case 'FETCH': {
          if (!selected) return send(`${tag} BAD no folder selected\r\n`);
          const [set] = args(a);
          const max = messages.length
            ? uidMode
              ? messages[messages.length - 1]!.uid
              : messages.length
            : 0;
          const wantsBody = /BODY(\.PEEK)?\[\]/i.test(a);
          const wantsSize = /RFC822\.SIZE/i.test(a);
          if (wantsBody && state.dropOnBodyFetch > 0) {
            // Half a response, then the connection goes.
            state.dropOnBodyFetch--;
            send('* 1 FETCH (UID 1 BODY[] {100}\r\nFrom: half');
            sock.destroy();
            return;
          }
          messages.forEach((m, idx) => {
            const key = uidMode ? m.uid : idx + 1;
            if (!max || !inSet(key, set ?? '', max)) return;
            const size = wantsSize ? ` RFC822.SIZE ${m.raw.length}` : '';
            if (!wantsBody) return send(`* ${idx + 1} FETCH (UID ${m.uid}${size})\r\n`);
            bodiesSent.push(m.uid);
            send(`* ${idx + 1} FETCH (UID ${m.uid}${size} BODY[] {${m.raw.length}}\r\n`);
            sock.write(m.raw);
            send(')\r\n');
          });
          return ok();
        }
        case 'IDLE':
          idleTag = tag;
          idlers.add(sock);
          send('+ idling\r\n');
          return;
        default:
          return send(`${tag} BAD unknown command\r\n`);
      }
    };
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  Object.assign(state, {
    host: '127.0.0.1',
    port,
    user,
    password,
    logins,
    commands,
    bodiesSent,
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    idling: () => idlers.size,
    deliver(raw: string) {
      const uid = nextUid++;
      messages.push({ uid, raw: Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8') });
      for (const s of idlers) s.write(`* ${messages.length} EXISTS\r\n`);
      return uid;
    },
    reset(v: number) {
      validity = v;
      messages = [];
      nextUid = 1;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  });
  return state;
}

// ---- SMTP ----------------------------------------------------------------------------------------

export interface SentMail {
  from: string;
  to: string[];
  data: string;
  user: string | null;
}

export interface FakeSmtp {
  host: string;
  port: number;
  user: string;
  password: string;
  sent: SentMail[];
  /** Refuse the next DATA with this reply (a failing server). */
  failNext: string | null;
  close(): Promise<void>;
}

export async function startFakeSmtp(
  opts: { user?: string; password?: string } = {},
): Promise<FakeSmtp> {
  const user = opts.user ?? 'nova@example.com';
  const password = opts.password ?? 'imap-app-password-1';
  const sent: SentMail[] = [];
  const sockets = new Set<Socket>();
  const state: FakeSmtp = {
    host: '127.0.0.1',
    port: 0,
    user,
    password,
    sent,
    failNext: null,
    close: () => Promise.resolve(),
  };
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    let authedAs: string | null = null;
    let mail: { from: string; to: string[] } | null = null;
    let data: string[] | null = null;
    let loginStep: 'user' | 'pass' | null = null;
    let loginUser = '';
    const send = (s: string) => {
      if (!sock.destroyed) sock.write(`${s}\r\n`);
    };
    send('220 fake.smtp ESMTP ready');
    const login = (u: string, p: string) => {
      if (u === user && p === password) {
        authedAs = u;
        send('235 2.7.0 authenticated');
      } else send('535 5.7.8 authentication failed');
    };
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            const body = data.join('\r\n');
            data = null;
            if (state.failNext) {
              send(state.failNext);
              state.failNext = null;
            } else {
              sent.push({ from: mail!.from, to: mail!.to, data: body, user: authedAs });
              send('250 2.0.0 queued');
            }
            mail = null;
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (loginStep === 'user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 'pass';
          send(`334 ${Buffer.from('Password:').toString('base64')}`);
          continue;
        }
        if (loginStep === 'pass') {
          loginStep = null;
          login(loginUser, Buffer.from(line, 'base64').toString('utf8'));
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          const b64 = line.slice(10).trim();
          const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
          login(u ?? '', p ?? '');
        } else if (upper.startsWith('AUTH LOGIN')) {
          loginStep = 'user';
          send(`334 ${Buffer.from('Username:').toString('base64')}`);
        } else if (upper.startsWith('MAIL FROM:')) {
          if (!authedAs) send('530 5.7.0 authentication required');
          else {
            mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [] };
            send('250 2.1.0 ok');
          }
        } else if (upper.startsWith('RCPT TO:')) {
          mail?.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send('250 2.1.5 ok');
        } else if (upper === 'DATA') {
          data = [];
          send('354 end with .');
        } else if (upper === 'QUIT') {
          send('221 bye');
          sock.end();
        } else if (upper === 'RSET' || upper === 'NOOP') send('250 ok');
        else send('502 5.5.2 not implemented');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}

/** A raw RFC 5322 message for `FakeImap.deliver`. */
export function mail(m: {
  from: string;
  to: string;
  cc?: string;
  subject?: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
  /** The receiving server's verdict (the topmost header); omitted: none. */
  auth?: string | null;
  attachment?: { name: string; mime: string; content: Buffer };
}): string {
  const id = m.messageId ?? `${Math.random().toString(36).slice(2)}@sender.example`;
  const head: string[] = [];
  if (m.auth) head.push(`Authentication-Results: mx.example.com; ${m.auth}`);
  head.push(`From: ${m.from}`, `To: ${m.to}`);
  if (m.cc) head.push(`Cc: ${m.cc}`);
  head.push(
    `Subject: ${m.subject ?? 'Hello'}`,
    `Message-ID: <${id}>`,
    'Date: Sat, 17 Oct 2026 12:00:00 +0000',
  );
  if (m.inReplyTo) head.push(`In-Reply-To: <${m.inReplyTo}>`);
  if (m.references) head.push(`References: ${m.references}`);
  for (const [k, v] of Object.entries(m.headers ?? {})) head.push(`${k}: ${v}`);
  head.push('MIME-Version: 1.0');
  if (!m.attachment) {
    head.push('Content-Type: text/plain; charset=utf-8');
    return `${head.join('\r\n')}\r\n\r\n${m.text}\r\n`;
  }
  const b = 'boundary-nova-test';
  head.push(`Content-Type: multipart/mixed; boundary="${b}"`);
  const parts = [
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}\r\n`,
    `--${b}\r\nContent-Type: ${m.attachment.mime}; name="${m.attachment.name}"\r\n` +
      `Content-Disposition: attachment; filename="${m.attachment.name}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${m.attachment.content.toString('base64')}\r\n`,
    `--${b}--\r\n`,
  ];
  return `${head.join('\r\n')}\r\n\r\n${parts.join('')}`;
}
