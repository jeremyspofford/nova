// Shared steps of the M8 journey (J10) and its demo: a Hub set up through onboarding (optionally
// with a managed policy file for tests), the SDK's sample extension packed as an unsigned `.novax`,
// the test policy file, the audit log, and reading a `.novaexport` (sealed or not) table by table
// so the data round trip can be checked against the export's own manifest.
//
// The managed policy for tests: the Hub honours NOVA_MANAGED_SETTINGS_FILE only when it runs with
// --allow-test-policy (or NODE_ENV=test), as a layer over the protected file, and only when the file
// belongs to the Hub's own user and nobody else can write it or a folder above it
// (packages/core/src/managed/source.ts). The file is written 0600 in a fresh 0700 folder under the
// system temp folder (sticky), so the Hub accepts it.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type APIResponse, type Page } from '@playwright/test';
import { folderBundleFiles, packBundle } from '../../packages/core/src/sdk/bundle.ts';
import { unsealFile } from '../../packages/core/src/datactl/seal.ts';
import { listZip, readZipEntry } from '../../packages/core/src/datactl/zip.ts';
import { startHub, type RunningHub } from './hub.ts';

/** The SDK's sample extension (packages/sdk/examples/hello). */
export const HELLO_DIR = resolve('packages/sdk/examples/hello');
export const HELLO_ID = 'com.example.hello';
export const HELLO_NAME = 'Hello extension';

/** The sample extension as an unsigned `.novax` (what `nova pack . --unsigned` writes). */
export function helloBundle(): Buffer {
  return Buffer.from(packBundle(folderBundleFiles(HELLO_DIR)).bytes);
}

/**
 * A Hub through onboarding (setup link, Finish setup, Skip setup); with `policy`, it runs with that
 * test policy file (NOVA_MANAGED_SETTINGS_FILE and --allow-test-policy).
 */
export async function setUpM8Hub(
  page: Page,
  port: number,
  opts: { policy?: string } = {},
): Promise<RunningHub> {
  const hub = await startHub({
    port,
    ...(opts.policy
      ? { env: { NOVA_MANAGED_SETTINGS_FILE: opts.policy }, args: ['--allow-test-policy'] }
      : {}),
  });
  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
  return hub;
}

// ---- UI text -----------------------------------------------------------------------------------

const CATALOG = JSON.parse(
  readFileSync(resolve('apps/web/src/i18n/catalog.en.json'), 'utf8'),
) as Record<string, string>;

/**
 * A UI message in English, from the web app's English catalog (`<namespace>.<key>`, written by
 * `npm run i18n:write` from the defineMessages calls), with its `{placeholders}` filled in. A
 * whole-message plural (`{n, plural, =0 {…} one {…} other {…}}`) picks its branch and fills `#`;
 * nested plurals and selects are not expanded here.
 */
export function en(id: string, params: Record<string, string | number> = {}): string {
  let message = CATALOG[id];
  if (message === undefined) throw new Error(`${id} is not in apps/web/src/i18n/catalog.en.json`);
  const plural = /^\{(\w+), plural, (.*)\}$/s.exec(message);
  if (plural) {
    const n = Number(params[plural[1]!]);
    const branches = new Map(
      [...plural[2]!.matchAll(/(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g)].map((m) => [
        m[1]!,
        m[2]!,
      ]),
    );
    const branch = branches.get(`=${n}`) ?? (n === 1 ? branches.get('one') : undefined);
    message = (branch ?? branches.get('other') ?? '').replace(/#/g, String(n));
  }
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** A string for a RegExp, matched literally. */
export const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- managed policy ----------------------------------------------------------------------------

/** A test policy file the Hub will trust (see the header); returns its path. */
export function policyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nova-e2e-policy-'));
  chmodSync(dir, 0o700);
  return join(dir, 'managed-settings.json');
}

/** Write (or replace) the policy, mode 0600. */
export function writePolicy(path: string, policy: unknown): void {
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---- Hub API reads -----------------------------------------------------------------------------

/** JSON from a Hub API call, failing with the body when the status is not 2xx. */
export async function json<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  const body = await res.text();
  expect(res.ok(), `${res.url()} → ${res.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

/** A refused Hub call: its status, code and `details.reason`. */
export async function refusal(
  res: APIResponse,
): Promise<{ status: number; code: string; reason: string | null }> {
  const body = (await res.json()) as {
    error?: { code?: string; details?: { reason?: string } };
  };
  return {
    status: res.status(),
    code: body.error?.code ?? '',
    reason: body.error?.details?.reason ?? null,
  };
}

export interface AuditLine {
  kind: string;
  action: string;
  actor: string;
  resource: string | null;
  decision: string | null;
  detail: Record<string, unknown> | null;
}

/** The audit log (Settings → Diagnostics → Export audit log), oldest first. */
export async function auditLog(page: Page, url: string): Promise<AuditLine[]> {
  const res = await page.request.get(`${url}/api/v1/audit/export`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine);
}

/** A setting's resolved value and whether it is locked. */
export async function settingView(
  page: Page,
  url: string,
  key: string,
): Promise<{ value: unknown; locked: boolean; source: string } | undefined> {
  const { settings } = await json<{
    settings: { key: string; value: unknown; locked: boolean; source: string }[];
  }>(await page.request.get(`${url}/api/v1/settings`));
  return settings.find((s) => s.key === key);
}

// ---- exports -----------------------------------------------------------------------------------

export interface ManifestTable {
  name: string;
  rows: number;
  sha256: string;
}

export interface ExportManifestJson {
  format: number;
  schemaVersion: number;
  encrypted: boolean;
  tables: ManifestTable[];
  blobs: { path: string; sha256: string; size: number }[];
  secrets: { count: number; sha256: string } | null;
  toReEnter: string[];
  omitted: { kind: string; ref: string; reason: string }[];
}

export interface ExportArchive {
  manifest: ExportManifestJson;
  /** The JSON lines of a table, as exported. */
  lines(table: string): string[];
}

const LIMITS = { maxEntries: 1e6, maxTotalBytes: 1e10 };

/** Read a `.novaexport` (opened with the passphrase when sealed): its manifest and tables. */
export async function readExport(file: string, passphrase?: string): Promise<ExportArchive> {
  let zip = file;
  if (passphrase !== undefined) {
    zip = join(mkdtempSync(join(tmpdir(), 'nova-e2e-unsealed-')), 'export.zip');
    await unsealFile(file, zip, passphrase);
  }
  const entries = listZip(zip, LIMITS);
  const read = (name: string): string => {
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new Error(`${name} is not in the export`);
    const parts: Buffer[] = [];
    readZipEntry(zip, entry, (c) => parts.push(Buffer.from(c)));
    return Buffer.concat(parts).toString('utf8');
  };
  const manifest = JSON.parse(read('manifest.json')) as ExportManifestJson;
  return {
    manifest,
    lines: (table) => read(`tables/${table}.jsonl`).split('\n').filter(Boolean),
  };
}

/** Save the next browser download of `page` (started by `start`) and return its path. */
export async function download(page: Page, start: () => Promise<void>): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent('download'), start()]);
  const path = join(mkdtempSync(join(tmpdir(), 'nova-e2e-export-')), file.suggestedFilename());
  await file.saveAs(path);
  return path;
}

/** The columns an import turns off or revokes (datactl vet.ts): compared without them. */
export const RESTORED_OFF_COLUMNS: Record<string, readonly string[]> = {
  mcp_server: ['enabled'],
  plugin_install: ['enabled'],
  agent_adapter: ['enabled'],
  hook: ['trust_state', 'trusted_hash', 'trusted_by', 'trusted_at'],
  auth_token: ['revoked_at'],
};
/** Logs only grow: the export, delete-all and import add their own entries after the archive's. */
export const LOG_TABLES: readonly string[] = ['audit_event', 'event'];
/** Sync state the Hub adds as it starts (its message watermark): the archive's rows stay as they were. */
export const GROWING_TABLES: readonly string[] = ['sync_meta'];

function withoutColumns(line: string, columns: readonly string[]): string {
  const row = JSON.parse(line) as Record<string, unknown>;
  for (const c of columns) delete row[c];
  return JSON.stringify(row);
}

/**
 * Where an export made after an import differs from the export that was imported, table by table
 * and file by file. Every table of `before` must be in `after` with the same rows and checksum,
 * except: the logs, which keep the archive's lines first and only grow; the sync state, which keeps
 * every archived row and may gain the Hub's own; and the columns an import turns off or revokes,
 * which are compared without those columns. Every file keeps its checksum. One line per difference.
 */
export function compareExports(before: ExportArchive, after: ExportArchive): string[] {
  const out: string[] = [];
  const tables = new Map(after.manifest.tables.map((t) => [t.name, t]));
  for (const t of before.manifest.tables) {
    const a = tables.get(t.name);
    if (!a) {
      out.push(`${t.name}: missing`);
      continue;
    }
    if (a.rows === t.rows && a.sha256 === t.sha256) continue;
    const was = t.rows ? before.lines(t.name) : [];
    const now = a.rows ? after.lines(t.name) : [];
    const off = RESTORED_OFF_COLUMNS[t.name];
    if (LOG_TABLES.includes(t.name)) {
      if (JSON.stringify(now.slice(0, was.length)) !== JSON.stringify(was))
        out.push(`${t.name}: the archive's entries changed`);
    } else if (GROWING_TABLES.includes(t.name)) {
      const missing = was.filter((l) => !now.includes(l));
      if (missing.length) out.push(`${t.name}: ${missing.length} archived rows missing or changed`);
    } else if (off) {
      const strip = (ls: string[]) => ls.map((l) => withoutColumns(l, off));
      if (JSON.stringify(strip(now)) !== JSON.stringify(strip(was)))
        out.push(`${t.name}: rows differ beyond ${off.join(', ')}`);
    } else out.push(`${t.name}: ${t.rows} rows before, ${a.rows} after, checksum differs`);
  }
  const blobs = new Map(after.manifest.blobs.map((b) => [b.path, b.sha256]));
  for (const b of before.manifest.blobs)
    if (blobs.get(b.path) !== b.sha256) out.push(`file ${b.path}: missing or changed`);
  return out;
}

/** Rows per table in an export's manifest. */
export function rowsOf(archive: ExportArchive): Record<string, number> {
  return Object.fromEntries(archive.manifest.tables.map((t) => [t.name, t.rows]));
}

// ---- the sample extension ----------------------------------------------------------------------

/** Install the sample extension through the Hub's API (setup), unverified and on. */
export async function installHello(page: Page, url: string): Promise<void> {
  const preview = await json<{ previewId: string }>(
    await page.request.post(`${url}/api/v1/extensions/preview`, {
      data: {
        source: {
          kind: 'upload',
          bundle: helloBundle().toString('base64'),
          fileName: 'hello-1.0.0.novax',
        },
      },
    }),
  );
  await json(
    await page.request.post(`${url}/api/v1/extensions`, {
      data: { previewId: preview.previewId, confirmSideload: true, enable: true },
    }),
  );
}
