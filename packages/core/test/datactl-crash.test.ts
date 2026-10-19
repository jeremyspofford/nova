// Crash reporting (FR-121, ADR-097 D5): a crash writes a local report with no content; the preview
// is byte for byte what is sent; nothing is sent while reports are off or no endpoint is set.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CrashReports,
  buildCrashReport,
  crashDir,
  installCrashReporting,
  writeCrashDump,
} from '../src/index.ts';

let dir: string;
let server: Server;
let endpointUrl: string;
let received: string[];
let enabled: boolean;
let endpoint: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-crash-'));
  received = [];
  enabled = false;
  endpoint = '';
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      received.push(body);
      res.writeHead(received.length === 99 ? 500 : 204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  endpointUrl = `http://127.0.0.1:${addr.port}/crash`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function reports(): CrashReports {
  return new CrashReports({
    dataDir: dir,
    enabled: () => Promise.resolve(enabled),
    endpoint: () => Promise.resolve(endpoint),
  });
}

/** An error whose message and stack carry things that must never leave: text, paths, a key. */
function nasty(): Error {
  const err = new TypeError('the user wrote: my diary entry about the surprise party');
  err.stack = [
    'TypeError: the user wrote: my diary entry about the surprise party',
    `    at parse (${join(dir, 'blobs', 'x.ts')}:1:2)`,
    `    at load (${homedir()}/secret-project/file.ts:3:4)`,
    '    at run (file:///opt/nova/apps/hub/src/main.ts:5:6)',
    '    at token (sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789:1:1)',
  ].join('\n');
  (err as NodeJS.ErrnoException).code = 'ERR_TEST';
  return err;
}

describe('crash reports', () => {
  it('writes a local report without content when the process crashes', () => {
    const source = new EventEmitter();
    const written: string[] = [];
    const off = installCrashReporting({
      dataDir: dir,
      version: '0.8.0',
      source,
      onWritten: (p) => written.push(p),
    });
    source.emit('uncaughtExceptionMonitor', nasty(), 'uncaughtException');
    source.emit('uncaughtExceptionMonitor', 'a plain string reason', 'unhandledRejection');
    off();
    source.emit('uncaughtExceptionMonitor', nasty(), 'uncaughtException');
    expect(written).toHaveLength(2);
    expect(readdirSync(crashDir(dir))).toHaveLength(2);
    const text = written.map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(text).not.toContain('diary');
    expect(text).not.toContain(dir);
    expect(text).not.toContain(homedir());
    expect(text).not.toContain('sk-ant-api03');
    const list = reports().list();
    expect(list.map((r) => r.kind).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    const first = JSON.parse(readFileSync(written[0]!, 'utf8')) as {
      report: { error: { name: string; code: string; stack: string[] }; runtime: { node: string } };
    };
    expect(first.report.error).toMatchObject({ name: 'TypeError', code: 'ERR_TEST' });
    expect(first.report.error.stack[0]).toBe('at parse (<data>/blobs/x.ts:1:2)');
    expect(first.report.error.stack[1]).toBe('at load (~/secret-project/file.ts:3:4)');
    expect(first.report.runtime.node).toBe(process.version);
  });

  it('keeps no line of the message, even one that looks like a frame', () => {
    const err = new Error('first line\n    at diary (/home/someone/secret-diary.txt:1:1)\nlast');
    err.stack = [
      'Error: first line',
      '    at diary (/home/someone/secret-diary.txt:1:1)',
      'last',
      '    at real (file:///opt/nova/packages/core/src/x.ts:2:3)',
    ].join('\n');
    const r = buildCrashReport(err, 'uncaughtException', { dataDir: dir, version: '1' });
    expect(r.error.stack).toEqual(['at real (/opt/nova/packages/core/src/x.ts:2:3)']);
    expect(JSON.stringify(r)).not.toContain('diary');
  });

  it('sends nothing while off or without an endpoint; the preview is what is sent', async () => {
    const report = buildCrashReport(nasty(), 'uncaughtException', { dataDir: dir, version: '1' });
    writeCrashDump(dir, report);
    const r = reports();
    expect(await r.preview(report.id)).toMatchObject({ wouldSend: false, reason: 'off' });
    await expect(r.send(report.id)).rejects.toMatchObject({
      details: { reason: 'crash_reports_off' },
    });
    expect(await r.sendPending()).toBe(0);
    enabled = true;
    expect(await r.preview(report.id)).toMatchObject({ wouldSend: false, reason: 'no_endpoint' });
    await expect(r.send(report.id)).rejects.toMatchObject({ details: { reason: 'no_endpoint' } });
    expect(received).toEqual([]);

    endpoint = endpointUrl;
    const preview = await r.preview(report.id);
    expect(preview).toMatchObject({ wouldSend: true, reason: null, endpoint: endpointUrl });
    const sent = await r.send(report.id);
    expect(sent.sentAt).not.toBeNull();
    expect(received).toEqual([preview.body]);
    expect(JSON.parse(preview.body)).toEqual(report);
    // Sent once: the pending sweep skips it.
    expect(await r.sendPending()).toBe(0);
  });

  it('sends pending reports, records a failed send, deletes', async () => {
    const a = buildCrashReport(new Error('x'), 'uncaughtException', { dataDir: dir, version: '1' });
    const b = buildCrashReport(new Error('y'), 'unhandledRejection', {
      dataDir: dir,
      version: '1',
    });
    writeCrashDump(dir, a);
    writeCrashDump(dir, b);
    enabled = true;
    endpoint = 'http://127.0.0.1:9/never';
    const r = reports();
    await expect(r.send(a.id)).rejects.toMatchObject({ details: { reason: 'send_failed' } });
    expect(r.get(a.id).lastError).toBeTruthy();
    endpoint = endpointUrl;
    expect(await r.sendPending()).toBe(2);
    expect(received).toHaveLength(2);
    r.delete(a.id);
    expect(() => r.get(a.id)).toThrow(/no such crash report/);
    expect(() => r.get('../../etc/passwd')).toThrow(/no such crash report/);
    expect(r.deleteAll()).toBe(1);
    expect(r.list()).toEqual([]);
  });
});
