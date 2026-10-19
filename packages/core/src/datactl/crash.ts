// Crash reporting (FR-121, ADR-097 D5; docs/12 §9): the Hub process's uncaught exceptions and
// unhandled rejections write a local report under `<dataDir>/crash`. A report holds no content:
// the error's type and code (never its message, which can quote user text), its stack frames with
// paths made relative (no home folder, no data folder, no user name) and redacted, the versions
// and the platform. Nothing is sent unless the owner turned `privacy.crashReports` on and named an
// endpoint; the preview is the exact text that would be sent.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NovaError,
  uuidv7,
  type CrashKind,
  type CrashReportBody,
  type CrashReportPreviewView,
  type CrashReportView,
} from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';

/** The folder Nova is installed in (four levels above this file): stack paths are made relative to it. */
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MAX_FRAMES = 40;
const MAX_FRAME = 300;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function crashDir(dataDir: string): string {
  return join(dataDir, 'crash');
}

interface StoredCrash {
  report: CrashReportBody;
  sentAt: string | null;
  lastError: string | null;
}

export interface CrashReportInput {
  dataDir: string;
  version: string;
  now?: () => Date;
  redactor?: Redactor;
  /** Tests: the home folder to hide. */
  home?: string;
}

function frameText(line: string, opts: CrashReportInput): string {
  let s = line.trim().replace(/file:\/\//g, '');
  const swaps: [string, string][] = [
    [resolve(opts.dataDir), '<data>'],
    [INSTALL_ROOT, ''],
    [opts.home ?? homedir(), '~'],
  ];
  for (const [from, to] of swaps) {
    if (!from || from === '/') continue;
    s = s.split(`${from}/`).join(to ? `${to}/` : '');
    s = s.split(from).join(to);
  }
  s = (opts.redactor ?? defaultRedactor).redactString(s);
  return s.length > MAX_FRAME ? `${s.slice(0, MAX_FRAME - 1)}…` : s;
}

/** The report for an error: its type, code and frames; never its message. */
export function buildCrashReport(
  err: unknown,
  kind: CrashKind,
  opts: CrashReportInput,
): CrashReportBody {
  const e = err instanceof Error ? err : null;
  const name = e?.name && /^[A-Za-z0-9_$.]{1,60}$/.test(e.name) ? e.name : e ? 'Error' : typeof err;
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,60}$/.test(rawCode) ? rawCode : null;
  // The stack starts with "<name>: <message>": skip as many lines as the message has (a message
  // line can look like a frame), then keep only frames.
  const messageLines = e ? Math.max(1, String(e.message).split('\n').length) : 0;
  const frames = (e?.stack ?? '')
    .split('\n')
    .slice(messageLines)
    .filter((l) => /^\s+at\s/.test(l))
    .slice(0, MAX_FRAMES)
    .map((l) => frameText(l, opts));
  const mem = process.memoryUsage();
  return {
    v: 1,
    id: uuidv7(),
    kind,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    error: { name, code, stack: frames },
    app: { name: 'nova-hub', version: opts.version },
    runtime: { node: process.version, platform: platform(), arch: arch(), release: release() },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / (1024 * 1024)),
    },
  };
}

/** Write a report to the crash folder synchronously (the process may be about to end). */
export function writeCrashDump(dataDir: string, report: CrashReportBody): string {
  const dir = crashDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${report.id}.json`);
  const stored: StoredCrash = { report, sentAt: null, lastError: null };
  writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
  return path;
}

/** Something that emits `uncaughtExceptionMonitor` (the process). */
export interface CrashSource {
  on(event: 'uncaughtExceptionMonitor', fn: (err: unknown, origin: string) => void): unknown;
  off(event: 'uncaughtExceptionMonitor', fn: (err: unknown, origin: string) => void): unknown;
}

/**
 * Write a report for every uncaught exception and unhandled rejection. It only observes
 * (`uncaughtExceptionMonitor`): the process still ends the way it would have. Returns the undo.
 */
export function installCrashReporting(
  opts: CrashReportInput & { source?: CrashSource; onWritten?: (path: string) => void },
): () => void {
  const source: CrashSource = opts.source ?? process;
  const fn = (err: unknown, origin: string) => {
    try {
      const kind: CrashKind =
        origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException';
      const path = writeCrashDump(opts.dataDir, buildCrashReport(err, kind, opts));
      opts.onWritten?.(path);
    } catch {
      // A failing crash report must never hide the crash itself.
    }
  };
  source.on('uncaughtExceptionMonitor', fn);
  return () => {
    source.off('uncaughtExceptionMonitor', fn);
  };
}

export interface CrashReportsOptions {
  dataDir: string;
  /** `privacy.crashReports`. */
  enabled: () => Promise<boolean>;
  /** `privacy.crashReportEndpoint` ('' for none). */
  endpoint: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** The stored reports: list, preview, send (only when on), delete. */
export class CrashReports {
  readonly #o: CrashReportsOptions;

  constructor(opts: CrashReportsOptions) {
    this.#o = opts;
  }

  #path(id: string): string {
    if (!ID.test(id)) throw new NovaError('not_found', 'no such crash report');
    return join(crashDir(this.#o.dataDir), `${id}.json`);
  }

  #read(id: string): StoredCrash {
    let text: string;
    try {
      text = readFileSync(this.#path(id), 'utf8');
    } catch {
      throw new NovaError('not_found', 'no such crash report');
    }
    try {
      return JSON.parse(text) as StoredCrash;
    } catch {
      throw new NovaError('not_found', 'the crash report is unreadable');
    }
  }

  #write(stored: StoredCrash): void {
    const path = this.#path(stored.report.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  list(): CrashReportView[] {
    let names: string[];
    try {
      names = readdirSync(crashDir(this.#o.dataDir));
    } catch {
      return [];
    }
    const out: CrashReportView[] = [];
    for (const n of names) {
      const id = n.endsWith('.json') ? n.slice(0, -5) : '';
      if (!ID.test(id)) continue;
      try {
        out.push(view(this.#read(id)));
      } catch {
        // unreadable: skipped
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  get(id: string): CrashReportView {
    return view(this.#read(id));
  }

  async preview(id: string): Promise<CrashReportPreviewView> {
    const stored = this.#read(id);
    const [enabled, endpoint] = await Promise.all([this.#o.enabled(), this.#o.endpoint()]);
    return {
      body: JSON.stringify(stored.report),
      endpoint: endpoint || null,
      wouldSend: enabled && !!endpoint,
      reason: !enabled ? 'off' : !endpoint ? 'no_endpoint' : null,
    };
  }

  /** Send one report now; refused while crash reports are off or no endpoint is set. */
  async send(id: string): Promise<CrashReportView> {
    const stored = this.#read(id);
    const p = await this.preview(id);
    if (!p.wouldSend || !p.endpoint)
      throw new NovaError(
        'policy_denied',
        p.reason === 'off'
          ? 'crash reports are off: turn on privacy.crashReports to send them'
          : 'no crash report endpoint is set',
        { details: { reason: p.reason === 'off' ? 'crash_reports_off' : 'no_endpoint' } },
      );
    const f = this.#o.fetch ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#o.timeoutMs ?? 10_000);
    timer.unref?.();
    try {
      const res = await f(p.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: p.body,
        redirect: 'error',
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`the endpoint answered ${res.status}`);
      stored.sentAt = (this.#o.now ?? (() => new Date()))().toISOString();
      stored.lastError = null;
    } catch (err) {
      stored.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.#write(stored);
      throw new NovaError('server_error', `the crash report was not sent: ${stored.lastError}`, {
        details: { reason: 'send_failed' },
      });
    } finally {
      clearTimeout(timer);
    }
    this.#write(stored);
    return view(stored);
  }

  /** Send every unsent report, when the owner turned sending on; returns how many went. */
  async sendPending(): Promise<number> {
    if (!(await this.#o.enabled()) || !(await this.#o.endpoint())) return 0;
    let sent = 0;
    for (const r of this.list()) {
      if (r.sentAt) continue;
      try {
        await this.send(r.id);
        sent++;
      } catch {
        // kept for the next try
      }
    }
    return sent;
  }

  delete(id: string): void {
    this.#read(id);
    rmSync(this.#path(id), { force: true });
  }

  deleteAll(): number {
    const all = this.list();
    for (const r of all) rmSync(this.#path(r.id), { force: true });
    return all.length;
  }
}

function view(s: StoredCrash): CrashReportView {
  return {
    id: s.report.id,
    kind: s.report.kind,
    createdAt: s.report.createdAt,
    errorName: s.report.error.name,
    sentAt: s.sentAt,
    lastError: s.lastError,
  };
}
