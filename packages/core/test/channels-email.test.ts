// Email channels (FR-110, docs/13 §4) against local IMAP and SMTP servers (no internet): the
// mailbox password only in the vault and TLS unless the server is on this machine; mail read
// read-only past a cursor (old mail and a reset folder are not replayed); a sender counts as their
// mapped identity only with an authenticated From; machine-written mail and our own replies never
// start a turn; replies thread by Message-ID under "Re:"; attachments become thread attachments;
// approvals are answered only by a signed one-use link (never by reply text), and only the
// owner's private conversation gets one; IDLE wakes the poller.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type SettingKey } from '@nova/shared';
import {
  ChannelPollers,
  ImapReader,
  approvalCode,
  parseAuthResults,
  parseMail,
  senderAuthenticated,
  stripComments,
  stripQuoted,
} from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import { FakeApprovals } from './fixtures/channels/approvals.ts';
import {
  mail,
  startFakeImap,
  startFakeSmtp,
  type FakeImap,
  type FakeSmtp,
} from './fixtures/channels/mail-servers.ts';

let env: ServiceEnv;
let imap: FakeImap;
let smtp: FakeSmtp;
let approvals: FakeApprovals;
let pollers: ChannelPollers;
let dataDir: string;

const OWNER = 'jeremy@home.example';
const ADDRESS = 'nova@example.com';
const PASS = 'dmarc=pass header.from=home.example';

const setting = <K extends SettingKey>(key: K) =>
  Promise.resolve(
    (key === 'channels.email.pollSeconds'
      ? 15
      : SETTINGS[key].default) as (typeof SETTINGS)[K]['default'],
  );

beforeEach(async () => {
  imap = await startFakeImap();
  smtp = await startFakeSmtp();
  dataDir = mkdtempSync(join(tmpdir(), 'nova-email-'));
  env = await serviceEnv({ publicBase: 'https://hub.example.com', dataDir });
  approvals = new FakeApprovals();
  env.service.useApprovals(approvals);
  pollers = new ChannelPollers({
    service: env.service,
    db: env.db,
    setting,
    backoffMs: 50,
  });
});

afterEach(async () => {
  await pollers.stop();
  await env.service.close();
  env.db.close();
  await imap.close();
  await smtp.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const mailbox = (over: Record<string, unknown> = {}) => ({
  address: ADDRESS,
  imapHost: '127.0.0.1',
  imapPort: imap.port,
  imapSecurity: 'none',
  smtpHost: '127.0.0.1',
  smtpPort: smtp.port,
  smtpSecurity: 'none',
  mode: 'polling',
  // The authserv-id the test mail's Authentication-Results headers carry.
  authservId: 'mx.example.com',
  ...over,
});

async function binding(over: Record<string, unknown> = {}) {
  return env.service.create(ACCOUNT, {
    kind: 'email',
    externalRef: OWNER,
    label: 'Jeremy by email',
    agentId: 'agent-1',
    audience: 'private',
    credentials: { password: imap.password },
    config: mailbox(),
    ...over,
  } as never);
}

async function owner() {
  await env.service.addIdentity(ACCOUNT, { kind: 'email', externalId: OWNER, role: 'owner' });
}

/** Connect, read once so the cursor starts at the folder's end. */
async function ready(over: Record<string, unknown> = {}) {
  await owner();
  const b = await binding(over);
  await env.service.setEnabled(ACCOUNT, b.id, true);
  imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'old mail before the binding', auth: PASS }));
  expect(await pollers.pollOnce(b.id)).toBe(0);
  return b;
}

async function poll(bindingId: string) {
  const n = await pollers.pollOnce(bindingId);
  if (!env.turns.hold) await env.service.idle();
  return n;
}

describe('parsing mail', () => {
  const ctx = {
    address: ADDRESS,
    senderCheck: 'dmarc' as 'dmarc' | 'none',
    authservId: 'mx.example.com',
    receivedAt: '2026-10-17T12:00:00Z',
  };
  const parse = (raw: string, c = ctx) => parseMail(Buffer.from(raw), c);

  it('trusts only the receiving server, parsed per RFC 8601 (the review probes)', async () => {
    const trust = { authservId: 'mx.home.example' };
    const ok = (line: string, from = 'owner@victim.example', t: object = trust) =>
      senderAuthenticated([`Authentication-Results: ${line}`], from, t);
    // DMARC with its own header.from; DKIM with an aligned header.d, in the same result.
    expect(ok('mx.home.example; dmarc=pass header.from=victim.example')).toBe(true);
    expect(ok('mx.home.example; dkim=pass header.d=victim.example')).toBe(true);
    expect(ok('mx.home.example; dkim=pass header.d=victim.example', 'a@mail.victim.example')).toBe(
      true,
    );
    expect(ok('mx.home.example 1; dmarc = pass (p=reject) header.from = Victim.Example')).toBe(
      true,
    );
    // Probe 1: a header the sender brought, from a server that is not ours.
    expect(ok('mx.evil.example; dmarc=pass header.from=victim.example')).toBe(false);
    // Probe 2: "dmarc=pass" inside a comment the sender influences; the real verdict is fail.
    expect(
      ok(
        'mx.home.example; spf=pass (domain of "x dmarc=pass header.from=victim.example"@evil.example designates 1.2.3.4) smtp.mailfrom=evil.example; dmarc=fail header.from=victim.example',
      ),
    ).toBe(false);
    // Probe 3: dmarc=pass without header.from, and DKIM for another domain.
    expect(ok('mx.home.example; dkim=pass header.d=evil.example; dmarc=pass')).toBe(false);
    // header.from of another domain; a parent-less DKIM domain; a pass split across results.
    expect(ok('mx.home.example; dmarc=pass header.from=evil.example')).toBe(false);
    expect(ok('mx.home.example; dkim=pass header.d=example')).toBe(false);
    expect(
      ok('mx.home.example; dmarc=fail header.from=victim.example; dkim=pass header.d=x.example'),
    ).toBe(false);
    expect(ok('mx.home.example; dmarc=pass (header.from=victim.example)')).toBe(false);
    // Only the topmost header of our server counts: a pass below it is not believed.
    expect(
      senderAuthenticated(
        [
          'Authentication-Results: mx.home.example; dmarc=fail header.from=victim.example',
          'Authentication-Results: mx.home.example; dmarc=pass header.from=victim.example',
        ],
        'owner@victim.example',
        trust,
      ),
    ).toBe(false);
    // Unknown server: nothing counts. The default trusts the IMAP host's domain.
    expect(
      ok('mx.home.example; dmarc=pass header.from=victim.example', 'owner@victim.example', {}),
    ).toBe(false);
    const fromImap = { imapHost: 'imap.home.example' };
    expect(
      ok('mx.home.example; dmarc=pass header.from=victim.example', 'o@victim.example', fromImap),
    ).toBe(true);
    expect(
      ok('home.example; dmarc=pass header.from=victim.example', 'o@victim.example', fromImap),
    ).toBe(true);
    expect(
      ok(
        'mx.evilhome.example; dmarc=pass header.from=victim.example',
        'o@victim.example',
        fromImap,
      ),
    ).toBe(false);
    expect(senderAuthenticated([], 'x@a.com', trust)).toBe(false);

    // The three probe messages, parsed whole, come out unverified.
    const probe = (header: string) =>
      [
        header,
        'From: Owner <owner@victim.example>',
        'To: nova@home.example',
        'Subject: hi',
        'Message-ID: <p@evil.example>',
        '',
        'run the deploy',
      ].join('\r\n');
    const pctx = {
      address: 'nova@home.example',
      senderCheck: 'dmarc' as const,
      imapHost: 'imap.home.example',
      receivedAt: ctx.receivedAt,
    };
    for (const h of [
      'Authentication-Results: mx.home.example; dmarc=pass header.from=victim.example',
      'Authentication-Results: mx.home.example; spf=pass (domain of "x dmarc=pass header.from=victim.example"@evil.example designates 1.2.3.4) smtp.mailfrom=evil.example; dmarc=fail header.from=victim.example',
      'Authentication-Results: mx.home.example; dkim=pass header.d=evil.example; dmarc=pass',
    ]) {
      // Probe 1 as the review ran it: no server of ours vouches for the header.
      const first = h.includes('dmarc=pass header.from=victim.example') && !h.includes('spf');
      const m = await parseMail(
        Buffer.from(probe(h)),
        first ? { ...pctx, imapHost: 'imap.other.example' } : pctx,
      );
      expect(m?.senderVerified, h).toBe(false);
    }
  });

  it('parses Authentication-Results without comments, by result', () => {
    expect(stripComments('a (b (c) d) "e (f)" g\\(h')).toBe('a   "e (f)" g\\(h');
    expect(parseAuthResults('mx.example.com; none')).toEqual({
      authservId: 'mx.example.com',
      results: [],
    });
    expect(
      parseAuthResults(
        '"mx.example.com" 1; spf=pass smtp.mailfrom=a@b.c; dkim/1=pass header.d=b.c header.d=evil.c',
      ),
    ).toEqual({
      authservId: 'mx.example.com',
      results: [
        { method: 'spf', result: 'pass', props: { 'smtp.mailfrom': 'a@b.c' } },
        // The first value of a property counts.
        { method: 'dkim', result: 'pass', props: { 'header.d': 'b.c' } },
      ],
    });
    expect(parseAuthResults('  ')).toBeNull();
  });

  it('reads sender, conversation, audience, threading and text', async () => {
    const m = (await parse(
      mail({
        from: `Jeremy <${OWNER}>`,
        to: ADDRESS,
        subject: 'Plans',
        text: 'Can you book it?\n\nOn Sat, Oct 17, 2026 Nova wrote:\n> earlier text',
        messageId: 'm2@home.example',
        inReplyTo: 'm1@example.com',
        references: '<root@home.example> <m1@example.com>',
        auth: PASS,
      }),
    ))!;
    expect(m).toMatchObject({
      kind: 'email',
      conversation: OWNER,
      visibility: 'private',
      sender: { externalId: OWNER, displayName: 'Jeremy' },
      addressed: true,
      text: 'Can you book it?',
      messageId: 'm2@home.example',
      threadRef: 'root@home.example',
      subject: 'Plans',
      senderVerified: true,
    });
    // Others on the mail make it shared; a Cc only copies the mailbox in.
    const cc = (await parse(mail({ from: OWNER, to: 'sam@x.example', cc: ADDRESS, text: 'fyi' })))!;
    expect(cc).toMatchObject({ visibility: 'shared', addressed: false, senderVerified: false });
    const list = (await parse(
      mail({
        from: OWNER,
        to: 'team@lists.example',
        text: 'hello list',
        headers: { 'List-Post': '<mailto:team@lists.example>' },
      }),
    ))!;
    expect(list).toMatchObject({
      conversation: 'team@lists.example',
      visibility: 'shared',
      addressed: true,
    });
    expect(stripQuoted('a\n> b\nc\n-----Original Message-----\nd')).toBe('a\nc');
  });

  it('ignores machine-written mail, our own replies and our own address', async () => {
    expect(
      await parse(
        mail({
          from: OWNER,
          to: ADDRESS,
          text: 'away',
          headers: { 'Auto-Submitted': 'auto-replied' },
        }),
      ),
    ).toBeNull();
    expect(
      await parse(mail({ from: OWNER, to: ADDRESS, text: 'x', headers: { Precedence: 'bulk' } })),
    ).toBeNull();
    expect(
      await parse(
        mail({ from: OWNER, to: ADDRESS, text: 'x', headers: { 'X-Nova-Channel': '1' } }),
      ),
    ).toBeNull();
    expect(await parse(mail({ from: ADDRESS, to: ADDRESS, text: 'x' }))).toBeNull();
    expect(await parse('not a mail at all')).toBeNull();
    expect(
      (
        await parse(
          mail({ from: OWNER, to: ADDRESS, text: 'x', headers: { 'Auto-Submitted': 'no' } }),
        )
      )?.text,
    ).toBe('x');
    // With senderCheck none the server adds no results and the From is taken as is.
    expect(
      (await parse(mail({ from: OWNER, to: ADDRESS, text: 'x' }), { ...ctx, senderCheck: 'none' }))
        ?.senderVerified,
    ).toBe(true);
  });
});

describe('email bindings', () => {
  it('keeps the password in the vault, needs the mailbox, and TLS off this machine', async () => {
    const b = await binding();
    expect(JSON.stringify(b)).not.toContain(imap.password);
    expect(b).toMatchObject({
      kind: 'email',
      credentials: [{ name: 'password', set: true }],
      inboundPath: null,
    });
    expect(b.config).toMatchObject({ address: ADDRESS, imapPort: String(imap.port) });
    await expect(
      binding({ externalRef: 'a@b.example', config: mailbox({ imapHost: 'mail.example.com' }) }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      binding({ externalRef: 'a@b.example', config: { address: ADDRESS } }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.service.update(ACCOUNT, b.id, { config: { smtpHost: 'smtp.example.com' } }),
    ).rejects.toMatchObject({ code: 'validation' });
    // A second correspondent of the mailbox shares it and its settings.
    const other = await env.service.create(ACCOUNT, {
      kind: 'email',
      externalRef: 'Sam@Work.example',
      shareCredentialsWith: b.id,
    } as never);
    expect(other).toMatchObject({ externalRef: 'sam@work.example', sharesCredentialsWith: b.id });
    expect(other.config).toMatchObject({ address: ADDRESS, imapHost: '127.0.0.1' });
  });

  it('connects by logging in to both servers, and reports a refused login', async () => {
    const b = await binding();
    expect((await env.service.setEnabled(ACCOUNT, b.id, true)).statusDetail).toBeNull();
    expect(imap.logins.at(-1)).toEqual({ user: ADDRESS, ok: true });
    await env.service.update(ACCOUNT, b.id, { credentials: { password: 'wrong' } });
    const bad = await env.service.setEnabled(ACCOUNT, b.id, true);
    expect(bad.statusDetail).toMatch(/refused the login/);
    expect(bad.statusDetail).not.toContain('wrong');
  });
});

describe('reading and replying', () => {
  it('starts from new mail, answers in the thread under Re:, and ignores its own reply', async () => {
    const b = await ready();
    imap.deliver(
      mail({
        from: OWNER,
        to: ADDRESS,
        subject: 'Plans',
        text: 'Book a table for two',
        messageId: 'q1@home.example',
        auth: PASS,
      }),
    );
    expect(await poll(b.id)).toBe(1);
    expect(env.turns.calls).toHaveLength(1);
    expect(env.turns.calls[0]!.text).toContain('(the owner) wrote in a direct message on email');
    expect(env.turns.calls[0]!.text).toContain('Book a table for two');
    expect(env.turns.calls[0]!.authority).toEqual({ kind: 'none', origin: 'channel' });
    const sent = smtp.sent.at(-1)!;
    expect(sent.to).toEqual([OWNER]);
    expect(sent.data).toMatch(/^Subject: Re: Plans$/m);
    expect(sent.data).toMatch(/^In-Reply-To: <q1@home\.example>$/m);
    expect(sent.data).toMatch(/^References: <q1@home\.example>$/m);
    expect(sent.data).toMatch(/^Auto-Submitted: auto-replied$/m);
    expect(sent.data).toMatch(/^X-Nova-Channel: 1$/m);
    expect(sent.data).toMatch(/^Message-ID: <[0-9a-f-]+@example\.com>$/m);
    // Our reply landing in the mailbox (a Cc to ourselves) starts nothing.
    imap.deliver(sent.data);
    expect(await poll(b.id)).toBe(0);
    expect(env.turns.calls).toHaveLength(1);
    // Nothing is read twice.
    expect(await poll(b.id)).toBe(0);
  });

  it('does not take an unauthenticated From for the owner', async () => {
    const b = await ready();
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'trust me', auth: null }));
    await poll(b.id);
    expect(env.turns.calls).toHaveLength(0);
    expect(env.service.messages(ACCOUNT, b.id, { limit: 5 })[0]).toMatchObject({
      status: 'ignored',
      reason: 'unverified_sender',
    });
  });

  it('keeps attachments as thread attachments and says which were refused', async () => {
    const b = await ready();
    imap.deliver(
      mail({
        from: OWNER,
        to: ADDRESS,
        text: 'notes attached',
        auth: PASS,
        attachment: {
          name: 'notes.txt',
          mime: 'text/plain',
          content: Buffer.from('agenda: lunch'),
        },
      }),
    );
    imap.deliver(
      mail({
        from: OWNER,
        to: ADDRESS,
        text: 'a zip',
        auth: PASS,
        attachment: { name: 'a.zip', mime: 'application/zip', content: Buffer.from('PK...') },
      }),
    );
    await poll(b.id);
    const [first, second] = env.turns.calls;
    expect(first!.attachmentIds).toHaveLength(1);
    const row = env.db.raw
      .prepare('SELECT name, mime, thread_id, origin FROM attachment WHERE id = ?')
      .get(first!.attachmentIds![0]!) as Record<string, string>;
    expect(row).toMatchObject({
      name: 'notes.txt',
      mime: 'text/plain',
      thread_id: first!.threadId,
      origin: 'import',
    });
    expect(second!.attachmentIds).toBeUndefined();
    expect(second!.text).toContain('[Attachments not accepted: a.zip');
  });

  it('starts over at the end when the folder UIDs are reset', async () => {
    const b = await ready();
    imap.reset(99);
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'replayed?', auth: PASS }));
    expect(await poll(b.id)).toBe(0);
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'fresh', auth: PASS }));
    expect(await poll(b.id)).toBe(1);
  });

  it('records a reply the SMTP server refused', async () => {
    const b = await ready();
    smtp.failNext = '554 5.7.1 rejected';
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'hello', auth: PASS }));
    await poll(b.id);
    expect(env.service.messages(ACCOUNT, b.id, { direction: 'out', limit: 5 })[0]).toMatchObject({
      status: 'failed',
    });
    // Sending directly (a test message) says why.
    smtp.failNext = '554 5.7.1 rejected';
    await expect(env.service.test(ACCOUNT, b.id)).rejects.toMatchObject({ code: 'server_error' });
  });

  it('IDLE wakes the poller loop when mail arrives', async () => {
    const b = await ready({ config: mailbox({ mode: 'idle' }) });
    pollers.start();
    await vi.waitFor(() => expect(imap.commands).toContain('IDLE'), { timeout: 5_000 });
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'are you awake?', auth: PASS }));
    await vi.waitFor(() => expect(env.turns.calls).toHaveLength(1), { timeout: 5_000 });
    expect(env.turns.calls[0]!.text).toContain('are you awake?');
    void b;
  });
});

describe('approvals by email', () => {
  async function held(over: Record<string, unknown> = {}) {
    const b = await ready(over);
    env.turns.hold = true;
    imap.deliver(
      mail({
        from: OWNER,
        to: ADDRESS,
        subject: 'Post',
        text: 'post the update',
        messageId: 'p1@home.example',
        auth: PASS,
      }),
    );
    await poll(b.id);
    const call = env.turns.calls.at(-1)!;
    const turnId = env.service.messages(ACCOUNT, b.id, { direction: 'in', limit: 1 })[0]!.turnId!;
    return { b, threadId: call.threadId, turnId };
  }

  function linkOf(data: string): string {
    const m =
      /https:\/\/hub\.example\.com\/api\/v1\/channels\/approval-links\/([A-Za-z0-9._-]+)/.exec(
        data.replace(/=\r\n/g, ''),
      );
    expect(m).not.toBeNull();
    return m![1]!;
  }

  it('sends a signed one-use link; reply text never answers; the link answers once', async () => {
    const { b, threadId, turnId } = await held();
    const a = approvals.add(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const prompt = smtp.sent.at(-1)!;
    expect(prompt.data).toContain(`Approval needed: ${a.action}`);
    expect(prompt.data).toMatch(/^In-Reply-To: <p1@home\.example>$/m);
    const token = linkOf(prompt.data);
    // A reply with the code is refused: email text never answers.
    env.turns.hold = false;
    imap.deliver(
      mail({ from: OWNER, to: ADDRESS, text: `allow ${approvalCode(a.id)}`, auth: PASS }),
    );
    // (The first turn is still held: read without waiting for it.)
    await pollers.pollOnce(b.id);
    expect(env.service.messages(ACCOUNT, b.id, { direction: 'in', limit: 1 })[0]).toMatchObject({
      status: 'answered',
      reason: 'refused:link_required',
    });
    expect(smtp.sent.at(-1)!.data).toContain('answered with the link');
    expect(approvals.decided).toEqual([]);
    // Opening the link shows the choices and changes nothing.
    expect(await env.service.approvalLinkView(token)).toMatchObject({
      action: a.action,
      options: ['allow_once', 'allow_session', 'deny_continue', 'deny_stop'],
      label: 'Jeremy by email',
    });
    await expect(env.service.answerByLink(token, 'handoff')).rejects.toMatchObject({
      code: 'validation',
    });
    expect(await env.service.answerByLink(token, 'allow_once')).toEqual({
      decision: 'allow_once',
      text: 'Allowed once.',
    });
    expect(approvals.decided).toEqual([
      { id: a.id, decision: 'allow_once', by: `channel:${b.id}` },
    ]);
    expect(env.audit.find((x) => x.action === 'channel.approval.answered')).toMatchObject({
      detail: { via: 'link' },
    });
    await expect(env.service.answerByLink(token, 'allow_once')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(env.service.approvalLinkView(token)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses tampered, expired and stale links alike', async () => {
    const { threadId, turnId } = await held();
    const a = approvals.add(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const token = linkOf(smtp.sent.at(-1)!.data);
    const [id, exp, sig] = token.split('.') as [string, string, string];
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      `${id}.${exp}.${flipped}`,
      `${id}.${Number(exp) + 60}.${sig}`,
      'nonsense',
      `${id}.${exp}`,
    ])
      await expect(env.service.answerByLink(bad, 'allow_once')).rejects.toMatchObject({
        code: 'not_found',
      });
    // Past the link's lifetime (channels.approvalLinkMinutes, default 60).
    env.clock.advance(61 * 60_000);
    await expect(env.service.answerByLink(token, 'allow_once')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(approvals.decided).toEqual([]);
  });

  it('never sends a link to a shared conversation, nor for a Nova-only approval', async () => {
    const { threadId, turnId } = await held({ audience: 'shared' });
    const a = approvals.add(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const shared = smtp.sent.at(-1)!.data;
    expect(shared).not.toContain('approval-links');
    expect(shared).not.toContain(a.action);
    expect(shared).toContain('can only be answered in Nova');
    const c = approvals.add(threadId, { tier: 'confirm_at_action' });
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: c.id,
    });
    expect(smtp.sent.at(-1)!.data).not.toContain('approval-links');
  });

  it('a decided approval or a disconnected binding makes its link stale', async () => {
    const { b, threadId, turnId } = await held();
    const a = approvals.add(threadId);
    await env.service.onApprovalRequested({
      accountId: ACCOUNT,
      threadId,
      turnId,
      approvalId: a.id,
    });
    const token = linkOf(smtp.sent.at(-1)!.data);
    await env.service.setEnabled(ACCOUNT, b.id, false);
    await expect(env.service.approvalLinkView(token)).rejects.toMatchObject({ code: 'not_found' });
    await env.service.setEnabled(ACCOUNT, b.id, true);
    await approvals.decide(ACCOUNT, { approvalId: a.id, decision: 'deny_continue' }, 'user');
    await expect(env.service.answerByLink(token, 'allow_once')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('review hardening', () => {
  it('turning the sender check off must be confirmed, is audited, and marks each message', async () => {
    await owner();
    await expect(binding({ config: mailbox({ senderCheck: 'none' }) })).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'confirmSenderCheckNone' },
    });
    const b = await binding();
    await expect(
      env.service.update(ACCOUNT, b.id, { config: { senderCheck: 'none' } }),
    ).rejects.toMatchObject({ details: { reason: 'confirm_required' } });
    await env.service.update(
      ACCOUNT,
      b.id,
      { config: { senderCheck: 'none' } },
      { confirmSenderCheckNone: true },
    );
    expect(env.audit.filter((a) => a.action === 'channel.email.sender_check_off')).toEqual([
      expect.objectContaining({
        resource: `channel_binding:${b.id}`,
        detail: expect.objectContaining({ address: ADDRESS }),
      }),
    ]);
    // Already off: a later change needs no new confirmation and is not audited again.
    await env.service.update(ACCOUNT, b.id, { label: 'renamed' });
    expect(env.audit.filter((a) => a.action === 'channel.email.sender_check_off')).toHaveLength(1);
    await env.service.setEnabled(ACCOUNT, b.id, true);
    await pollers.pollOnce(b.id);
    imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'no auth header', auth: null }));
    await poll(b.id);
    expect(env.turns.calls).toHaveLength(1);
    expect(env.service.messages(ACCOUNT, b.id, { direction: 'in', limit: 1 })[0]).toMatchObject({
      status: 'started',
      reason: 'sender_unchecked',
    });
    // Confirmed at creation too (and audited).
    const c = await binding({
      externalRef: 'sam@work.example',
      config: mailbox({ senderCheck: 'none' }),
      confirmSenderCheckNone: true,
    });
    expect(
      env.audit.filter((a) => a.action === 'channel.email.sender_check_off').at(-1),
    ).toMatchObject({
      resource: `channel_binding:${c.id}`,
    });
  });

  it('downloads only the messages a round keeps, and none over the size cap', async () => {
    const reader = new ImapReader({ maxMessageBytes: 4096 });
    const access = {
      host: imap.host,
      port: imap.port,
      security: 'none' as const,
      username: imap.user,
      password: imap.password,
      folder: 'INBOX',
    };
    const start = await reader.fetchNew(access, null, 50, AbortSignal.timeout(10_000));
    const big = imap.deliver(mail({ from: OWNER, to: ADDRESS, text: 'x'.repeat(10_000) }));
    for (let i = 0; i < 54; i++) imap.deliver(mail({ from: OWNER, to: ADDRESS, text: `n${i}` }));
    const first = await reader.fetchNew(access, start.cursor, 50, AbortSignal.timeout(10_000));
    expect(first.skipped).toEqual([{ uid: big, size: expect.any(Number) }]);
    expect(first.messages).toHaveLength(49);
    // Only the kept, small messages were downloaded; the cursor stops at the 50th.
    expect(imap.bodiesSent).toEqual(first.messages.map((m) => m.uid));
    expect(imap.bodiesSent).not.toContain(big);
    expect(first.cursor.lastUid).toBe(big + 49);
    const second = await reader.fetchNew(access, first.cursor, 50, AbortSignal.timeout(10_000));
    expect(second.messages.map((m) => m.uid)).toEqual([
      big + 50,
      big + 51,
      big + 52,
      big + 53,
      big + 54,
    ]);
    expect(imap.bodiesSent).toHaveLength(54);
  });
});
