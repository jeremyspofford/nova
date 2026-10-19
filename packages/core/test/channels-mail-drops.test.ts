// Mailbox connections that drop (FR-110; the review found an imapflow rejection nobody handled,
// which in the Hub crashes the process): the IMAP server cuts the connection mid-IDLE and
// mid-fetch, and a watch is cancelled while its connection dies. Nothing may surface as an
// unhandled rejection or an uncaught exception; the reader fails with a NovaError, the poller marks
// the binding as failing, backs off and recovers, and the mail that arrived is still read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type SettingKey } from '@nova/shared';
import { ChannelPollers, ImapReader } from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import {
  mail,
  startFakeImap,
  startFakeSmtp,
  type FakeImap,
  type FakeSmtp,
} from './fixtures/channels/mail-servers.ts';

let imap: FakeImap;
let smtp: FakeSmtp;
let escaped: unknown[];
const onRejection = (reason: unknown) => escaped.push(reason);
const onException = (err: unknown) => escaped.push(err);

beforeEach(async () => {
  escaped = [];
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  imap = await startFakeImap();
  smtp = await startFakeSmtp();
});

afterEach(async () => {
  await imap.close();
  await smtp.close();
  // Late rejections (a close after the test's own work) get time to surface.
  await new Promise((r) => setTimeout(r, 300));
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  expect(escaped.map(String)).toEqual([]);
});

const access = () => ({
  host: imap.host,
  port: imap.port,
  security: 'none' as const,
  username: imap.user,
  password: imap.password,
  folder: 'INBOX',
});

describe('the reader', () => {
  it('a connection cut mid-IDLE fails the watch, handled', async () => {
    const reader = new ImapReader();
    const watching = reader.watch(access(), 10_000, AbortSignal.timeout(15_000));
    await vi.waitFor(() => expect(imap.idling()).toBe(1));
    imap.dropAll();
    await expect(watching).rejects.toMatchObject({ code: 'server_error' });
  });

  it('a connection cut mid-fetch fails the read, handled', async () => {
    const reader = new ImapReader();
    const start = await reader.fetchNew(access(), null, 50, AbortSignal.timeout(10_000));
    imap.deliver(mail({ from: 'a@b.example', to: imap.user, text: 'one' }));
    imap.dropOnBodyFetch = 1;
    await expect(
      reader.fetchNew(access(), start.cursor, 50, AbortSignal.timeout(10_000)),
    ).rejects.toMatchObject({ code: 'server_error' });
    // The next read works and nothing was skipped.
    const again = await reader.fetchNew(access(), start.cursor, 50, AbortSignal.timeout(10_000));
    expect(again.messages).toHaveLength(1);
  });

  it('a cancelled watch whose connection then dies leaves nothing behind', async () => {
    const reader = new ImapReader();
    const ctl = new AbortController();
    const watching = reader.watch(access(), 10_000, ctl.signal);
    await vi.waitFor(() => expect(imap.idling()).toBe(1));
    ctl.abort();
    imap.dropAll();
    await watching.catch(() => undefined);
    // A fetch cancelled while its connection drops, too.
    const reading = reader.fetchNew(access(), null, 50, AbortSignal.timeout(1));
    imap.dropAll();
    await reading.catch(() => undefined);
  });

  it('a server that is gone fails connect, handled', async () => {
    const reader = new ImapReader();
    const port = imap.port;
    await imap.close();
    await expect(
      reader.fetchNew({ ...access(), port }, null, 50, AbortSignal.timeout(10_000)),
    ).rejects.toMatchObject({ code: 'server_error' });
    imap = await startFakeImap();
  });
});

describe('connections cut while a session starts', () => {
  it('never escapes, whatever the timing (the window the Hub run hit)', async () => {
    // Before the fix about four in ten of these escaped as "Connection not available" from
    // imapflow's LOGIN or ENABLE, emitted as an 'error' nobody listened to.
    const reader = new ImapReader();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const ctl = new AbortController();
      const w = reader.watch(access(), 5_000, ctl.signal).catch(() => undefined);
      await sleep(i % 7);
      ctl.abort();
      if (i % 2) imap.dropAll();
      await w;
      const f = reader
        .fetchNew(access(), null, 50, AbortSignal.timeout(1 + (i % 5)))
        .catch(() => undefined);
      await sleep(i % 4);
      imap.dropAll();
      await f;
    }
  }, 30_000);
});

describe('the poller', () => {
  let env: ServiceEnv;
  let pollers: ChannelPollers;
  const setting = <K extends SettingKey>(key: K) =>
    Promise.resolve((key === 'channels.email.pollSeconds' ? 15 : SETTINGS[key].default) as never);

  beforeEach(async () => {
    env = await serviceEnv();
    pollers = new ChannelPollers({ service: env.service, db: env.db, setting, backoffMs: 100 });
  });

  afterEach(async () => {
    await pollers.stop();
    await env.service.close();
    env.db.close();
  });

  async function binding() {
    await env.service.addIdentity(ACCOUNT, {
      kind: 'email',
      externalId: 'jeremy@home.example',
      role: 'owner',
    });
    const b = await env.service.create(ACCOUNT, {
      kind: 'email',
      externalRef: 'jeremy@home.example',
      audience: 'private',
      credentials: { password: imap.password },
      config: {
        address: imap.user,
        imapHost: '127.0.0.1',
        imapPort: imap.port,
        imapSecurity: 'none',
        smtpHost: '127.0.0.1',
        smtpPort: smtp.port,
        smtpSecurity: 'none',
        mode: 'idle',
        authservId: 'mx.example.com',
      },
    } as never);
    await env.service.setEnabled(ACCOUNT, b.id, true);
    return b;
  }

  const fresh = (text: string) =>
    mail({
      from: 'jeremy@home.example',
      to: imap.user,
      text,
      auth: 'dmarc=pass header.from=home.example',
    });

  it('recovers from a drop mid-IDLE: marks the binding failing, backs off, reads on', async () => {
    const b = await binding();
    pollers.start();
    await vi.waitFor(() => expect(imap.idling()).toBe(1), { timeout: 5_000 });
    imap.dropAll();
    await vi.waitFor(
      async () =>
        expect((await env.service.get(ACCOUNT, b.id)).statusDetail).toMatch(/reading failed/),
      { timeout: 5_000, interval: 10 },
    );
    await vi.waitFor(() => expect(imap.idling()).toBe(1), { timeout: 5_000 });
    imap.deliver(fresh('after the drop'));
    await vi.waitFor(() => expect(env.turns.calls).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(async () =>
      expect((await env.service.get(ACCOUNT, b.id)).statusDetail).toBeNull(),
    );
  });

  it('recovers from a drop mid-fetch and still reads the message', async () => {
    const b = await binding();
    pollers.start();
    await vi.waitFor(() => expect(imap.idling()).toBe(1), { timeout: 5_000 });
    imap.dropOnBodyFetch = 1;
    imap.deliver(fresh('fetched after a drop'));
    await vi.waitFor(() => expect(env.turns.calls).toHaveLength(1), { timeout: 5_000 });
    expect(env.turns.calls[0]!.text).toContain('fetched after a drop');
    expect(imap.dropOnBodyFetch).toBe(0);
    void b;
  });

  it('stops cleanly while a watch and its connection are going down', async () => {
    await binding();
    pollers.start();
    await vi.waitFor(() => expect(imap.idling()).toBe(1), { timeout: 5_000 });
    const stopping = pollers.stop();
    imap.dropAll();
    await stopping;
  });
});
