// The capture module (M7, docs/11 §4 "Observation"): what is masked in URLs, headers and bodies,
// which bodies are read at all, the bounds of the console and network buffers, and how they read.
import { describe, expect, it } from 'vitest';
import { Redactor } from '@nova/security';
import {
  CAPTURE_BODY_MAX_BYTES,
  CONSOLE_TEXT_MAX,
  ConsoleLog,
  NetworkLog,
  bodyPolicy,
  bodyText,
  formatConsole,
  formatNetwork,
  isTextType,
  mimeOf,
  redactHeaders,
  redactUrl,
} from '../src/browser/capture.ts';

const r = new Redactor();
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('URLs', () => {
  it('drop credentials and the fragment, and mask secret-looking parameters one at a time', () => {
    expect(redactUrl('https://ada:pw@a.example/p?q=mugs&token=abc&page=2#access_token=x', r)).toBe(
      'https://a.example/p?q=mugs&token=[REDACTED]&page=2',
    );
    for (const k of ['code', 'state', 'api_key', 'X-Amz-Signature', 'session_id', 'sig', 'otp'])
      expect(redactUrl(`https://a.example/?${k}=v&keep=1`, r)).toBe(
        `https://a.example/?${k}=[REDACTED]&keep=1`,
      );
    // A secret pattern in the path or a value is masked; the encoding of the rest is kept.
    expect(redactUrl(`https://a.example/keys/${KEY}?q=a%20b`, r)).toBe(
      'https://a.example/keys/[REDACTED]?q=a%20b',
    );
    expect(redactUrl(`https://a.example/?note=${encodeURIComponent(`key ${KEY}`)}&x`, r)).toBe(
      'https://a.example/?note=key [REDACTED]&x',
    );
    expect(redactUrl('not a url with sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB', r)).toBe(
      'not a url with [REDACTED]',
    );
    expect(redactUrl(`https://a.example/${'x'.repeat(3_000)}`, r)).toHaveLength(2_000);
  });

  it('mask what the session itself filled (a password from the private form)', () => {
    const mine = new Redactor();
    mine.addLiteral('hunter2-hunter2');
    expect(redactUrl('https://a.example/echo?v=hunter2-hunter2', mine)).toBe(
      'https://a.example/echo?v=[REDACTED]',
    );
  });
});

describe('headers', () => {
  it('mask cookies, authorization and token-like values; keep the rest, clipped and bounded', () => {
    const out = redactHeaders(
      {
        Cookie: 'sid=1',
        'Set-Cookie': 'sid=1; HttpOnly',
        Authorization: 'Basic YWRhOnB3',
        'Proxy-Authorization': 'Basic eA==',
        'X-Auth-Token': 'abc',
        'X-CSRF-Token': 'abc',
        'X-Amz-Security-Token': 'abc',
        'X-Api-Key': 'abc',
        'WWW-Authenticate': 'Basic realm="x"',
        ':authority': 'a.example',
        'Content-Type': 'text/html',
        'X-Note': `uses ${KEY}`,
        'X-Long': 'v'.repeat(1_000),
      },
      r,
    );
    for (const h of [
      'cookie',
      'set-cookie',
      'authorization',
      'proxy-authorization',
      'x-auth-token',
      'x-csrf-token',
      'x-amz-security-token',
      'x-api-key',
    ])
      expect(out[h]).toBe('[REDACTED]');
    expect(out['www-authenticate']).toBe('Basic realm="x"');
    expect(out[':authority']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
    expect(out['x-note']).toBe('uses [REDACTED]');
    expect(out['x-long']).toHaveLength(300);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`h${i}`, 'v']));
    expect(Object.keys(redactHeaders(many, r))).toHaveLength(40);
  });
});

describe('bodies', () => {
  it('are read only for text types under the cap, and never for responses without one', () => {
    for (const t of [
      'text/html',
      'text/plain',
      'application/json',
      'application/problem+json',
      'application/atom+xml',
      'application/javascript',
      'image/svg+xml',
    ])
      expect(isTextType(t)).toBe(true);
    for (const t of ['image/png', 'application/octet-stream', 'application/pdf', 'video/mp4', null])
      expect(isTextType(t)).toBe(false);
    expect(mimeOf('Application/JSON; charset=utf-8')).toBe('application/json');
    expect(mimeOf('')).toBeNull();
    const cap = CAPTURE_BODY_MAX_BYTES;
    // Without a declared length the driver waits for the received size (`declared: false`).
    expect(bodyPolicy(200, { 'Content-Type': 'text/html' }, cap)).toEqual({
      read: true,
      declared: false,
    });
    expect(bodyPolicy(200, { 'content-type': 'text/html', 'content-length': '10' }, cap)).toEqual({
      read: true,
      declared: true,
    });
    expect(bodyPolicy(200, { 'content-type': 'text/event-stream' }, cap)).toEqual({
      read: false,
      omitted: 'binary',
    });
    expect(bodyPolicy(200, { 'content-type': 'image/png' }, cap)).toEqual({
      read: false,
      omitted: 'binary',
    });
    expect(
      bodyPolicy(200, { 'content-type': 'text/html', 'content-length': String(cap + 1) }, cap),
    ).toEqual({ read: false, omitted: 'too_large' });
    for (const status of [301, 204, 304, 101])
      expect(bodyPolicy(status, { 'content-type': 'text/html' }, cap)).toEqual({
        read: false,
        omitted: 'none',
      });
    expect(bodyPolicy(200, { 'content-type': 'text/html' }, 0)).toEqual({
      read: false,
      omitted: 'unavailable',
    });
  });

  it('are masked: JSON by key, text by pattern; too large ones are dropped', () => {
    const json = Buffer.from(
      JSON.stringify({ user: { name: 'Ada', password: 'pw1', access_token: 'tok' }, n: [KEY] }),
    );
    expect(bodyText(json, 'application/json', r).body).toBe(
      '{"user":{"name":"Ada","password":"[REDACTED]","access_token":"[REDACTED]"},"n":["[REDACTED]"]}',
    );
    expect(bodyText(Buffer.from('{oops'), 'application/json', r)).toEqual({
      body: '{oops',
      omitted: null,
    });
    expect(bodyText(Buffer.from(`key=${KEY}`), 'text/plain', r).body).toBe('key=[REDACTED]');
    expect(bodyText(new Uint8Array(CAPTURE_BODY_MAX_BYTES + 1), 'text/plain', r)).toEqual({
      body: null,
      omitted: 'too_large',
    });
    expect(bodyText(new Uint8Array([0xff, 0xfe, 0x41]), 'text/plain', r).body).toBe('��A');
  });
});

describe('the console buffer', () => {
  const now = () => new Date('2026-10-17T12:00:00Z');

  it('is bounded, counts what it dropped, maps levels and clips text', () => {
    const log = new ConsoleLog({ now, redactor: r, max: 3 });
    log.push({ level: 'warn', text: 'w', source: 'console' }, 'https://a.example/?token=x');
    log.push({ level: 'assert', text: 'a', source: 'console' }, 'about:blank');
    log.push({ level: 'weird', text: 'x'.repeat(5_000), source: 'console' }, null);
    log.push(
      { level: 'trace', text: 't', source: 'console', url: 'https://a.example/app.js', line: 7 },
      null,
    );
    const all = log.entries();
    expect(all.dropped).toBe(1);
    expect(all.items.map((e) => e.level)).toEqual(['error', 'log', 'debug']);
    expect(all.items[0]!.pageUrl).toBeNull();
    expect(all.items[1]!.text).toHaveLength(CONSOLE_TEXT_MAX);
    expect(all.items[2]).toMatchObject({ url: 'https://a.example/app.js', line: 7, seq: 4 });
    expect(log.entries({ limit: 1 }).items.map((e) => e.seq)).toEqual([4]);
    expect(log.entries({ levels: ['error'] }).total).toBe(1);
    expect(log.entries({ after: 3 }).items.map((e) => e.seq)).toEqual([4]);
    log.clear();
    expect(log.size).toBe(0);
    const first = new ConsoleLog({ now, redactor: r });
    first.push({ level: 'log', text: 'hi', source: 'console' }, 'https://a.example/?token=x');
    expect(first.entries().items[0]!.pageUrl).toBe('https://a.example/?token=[REDACTED]');
  });

  it('reads as numbered lines within a budget', () => {
    const log = new ConsoleLog({ now, redactor: r });
    expect(formatConsole(log.entries(), 1_000)).toContain('(none)');
    for (let i = 0; i < 50; i++)
      log.push({ level: 'log', text: `line ${i}`, source: 'console' }, null);
    const out = formatConsole(log.entries(), 400);
    expect(out).toContain('#1 [2026-10-17T12:00:00.000Z] log: line 0');
    expect(out).toContain('… (more messages did not fit)');
    expect(out.length).toBeLessThan(500);
  });
});

describe('the network buffer', () => {
  it('merges events by request, is bounded, ignores late or foreign events', () => {
    let t = Date.parse('2026-10-17T12:00:00Z');
    const log = new NetworkLog({ now: () => new Date(t), redactor: r, max: 2 });
    const req = (id: string, url: string) =>
      log.apply({
        phase: 'request',
        id,
        method: 'post',
        url,
        resourceType: 'xhr',
        navigation: false,
        headers: { Cookie: 'a=b' },
      });
    req('a', 'https://a.example/1');
    req('x', 'data:text/plain,hi');
    t += 50;
    log.apply({
      phase: 'response',
      id: 'a',
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
    });
    log.apply({ phase: 'body', id: 'a', body: new Uint8Array(Buffer.from('hello')) });
    log.apply({ phase: 'done', id: 'a', failure: null });
    req('b', 'https://a.example/2');
    log.apply({
      phase: 'response',
      id: 'b',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
    });
    // A driver that sends a body of a binary type anyway: not kept.
    log.apply({ phase: 'body', id: 'b', body: new Uint8Array([1, 2, 3]) });
    req('c', 'https://a.example/3');
    log.apply({ phase: 'done', id: 'a', failure: 'late' });
    log.apply({ phase: 'body', id: 'zzz', body: null });
    const out = log.entries();
    expect(out.dropped).toBe(1);
    expect(out.items.map((e) => e.url)).toEqual(['https://a.example/2', 'https://a.example/3']);
    expect(out.items[0]).toMatchObject({ body: null, bodyOmitted: 'binary', status: 200 });
    expect(out.items[0]!.requestHeaders).toEqual({ cookie: '[REDACTED]' });
    expect(out.items[1]).toMatchObject({ status: null, method: 'POST' });
  });

  it('times requests, marks blocked ones, and reads within a budget', () => {
    let t = 0;
    const log = new NetworkLog({ now: () => new Date(t), redactor: r });
    log.apply({
      phase: 'request',
      id: '1',
      method: 'GET',
      url: 'https://ads.example/p',
      resourceType: 'image',
      navigation: false,
      headers: {},
    });
    t = 30;
    log.apply({ phase: 'done', id: '1', failure: 'net::ERR_BLOCKED_BY_CLIENT' });
    log.apply({
      phase: 'request',
      id: '2',
      method: 'GET',
      url: 'https://a.example/x',
      resourceType: 'fetch',
      navigation: false,
      headers: {},
    });
    log.apply({ phase: 'done', id: '2', failure: 'net::ERR_CONNECTION_RESET' });
    const items = log.entries().items;
    expect(items[0]).toMatchObject({ blocked: true, durationMs: 30 });
    expect(items[1]).toMatchObject({ blocked: false, failure: 'net::ERR_CONNECTION_RESET' });
    const text = formatNetwork(log.entries(), { details: false, maxChars: 10_000 });
    expect(text).toContain(
      '#1 GET https://ads.example/p -> blocked (not on the allow list) (image, 30 ms)',
    );
    expect(text).toContain('-> failed: net::ERR_CONNECTION_RESET');
    for (let i = 3; i < 200; i++)
      log.apply({
        phase: 'request',
        id: String(i),
        method: 'GET',
        url: `https://a.example/${i}`,
        resourceType: 'fetch',
        navigation: false,
        headers: {},
      });
    expect(formatNetwork(log.entries(), { details: true, maxChars: 2_000 })).toContain(
      '… (more requests did not fit)',
    );
    expect(
      formatNetwork(new NetworkLog({ now: () => new Date(0), redactor: r }).entries(), {
        details: false,
        maxChars: 100,
      }),
    ).toContain('(none)');
  });
});
