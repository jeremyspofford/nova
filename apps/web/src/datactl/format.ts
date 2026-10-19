// Words for data controls (FR-105, FR-121) and spend caps and provider limits (FR-116, FR-115):
// every user-facing string of these views in one place, whole sentences only (i18n), the Hub's
// refusal reasons in plain words, retention items, the secrets an import asks for again, crash
// report kinds, sizes and money, cap states, and the cap-reached error a chat shows.
import type {
  CrashKind,
  ExportOmission,
  RetentionItem,
  SpendCapView,
  SpendPeriod,
} from '@nova/shared';
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  DELETED_RECOVERY_DAYS,
  EXPORT_PASSPHRASE_MIN,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';

/** Settings → Data. */
export const DATA_PATH = '/settings/data';

/** Where a provider's spend cap is set (Settings → Profile & usage, the Spend caps section). */
export function capPath(provider?: string | null): string {
  return `/settings/profile${provider ? `?cap=${encodeURIComponent(provider)}` : ''}#spend-caps`;
}

export const providerName = (kind: string) => PROVIDER_NAMES[kind] ?? kind;

// ---- sizes, money and counts -------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return 'under $0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const count = (n: number) => n.toLocaleString('en-US');

/** A UTC date, "Nov 1, 2026" (caps reset on UTC days and months). */
export function formatUtcDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ---- the page --------------------------------------------------------------------------------

export const DATA_STRINGS = {
  title: 'Data',
  intro:
    'Everything on this Hub is yours. Export it, move it to another Hub, delete it, choose how long it is kept, and decide whether crash reports leave this machine.',
  privacy:
    'Nova never uses your data to train models, and it sends nothing about how you use it anywhere unless you turn something on here or in telemetry export.',
  overviewTitle: 'What this Hub holds',
  overviewLoadError: "Could not load this Hub's data overview.",
  hubName: "Hub's name",
  version: 'Nova version',
  rows: 'Rows',
  tables: 'Tables',
  files: 'Files',
  secrets: 'Stored keys and passwords',
  // export
  exportTitle: 'Export',
  exportIntro:
    'Download one file with everything on this Hub: every account, chat, run, agent, memory, project, setting, file and the audit log.',
  passphrase: 'Passphrase (optional)',
  passphraseHint: `With a passphrase the file is encrypted and includes the stored keys and passwords. At least ${EXPORT_PASSPHRASE_MIN} characters; keep it safe, it cannot be recovered.`,
  passphraseRepeat: 'Repeat the passphrase',
  passphraseShort: `Use at least ${EXPORT_PASSPHRASE_MIN} characters.`,
  passphraseMismatch: 'The two passphrases differ.',
  withoutPassphrase:
    'Without a passphrase, stored keys and passwords are left out (you enter them again after an import), and so are the Hub’s own keys, so paired devices must be added again.',
  exportButton: 'Export',
  exporting: 'Preparing the export',
  exportStarted:
    'Your download has started. The file is written as it downloads; keep this page open until it finishes.',
  // import
  importTitle: 'Import',
  importIntro:
    'Move a Hub here: import an export into this Hub. It must be empty: a new Hub, or one after Delete all.',
  importNotEmpty:
    'This Hub already holds data, so it cannot take an import. Delete all data first, or import into a new Hub.',
  importBlocking: 'Tables that hold data',
  importChoose: 'Choose an export file',
  importFile: 'Export file',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  importEncrypted: 'This export is encrypted. Enter its passphrase to check it.',
  importPassphrase: 'Passphrase',
  checkButton: 'Check the file',
  checking: 'Checking',
  checkTitle: 'What the file holds',
  checkedStatus: 'The file was checked. What it holds is shown below.',
  exportedAt: 'Exported',
  fromVersion: 'From Nova',
  migrates: 'Made by an older Nova: its data is brought up to date as it is imported.',
  secretsIncluded: 'Stored keys and passwords included',
  secretsLeftOut: 'Stored keys and passwords left out',
  toReEnterTitle: 'You will enter these again',
  toReEnterNone: 'Nothing: every stored key and password is in the file.',
  omittedTitle: 'Left out of the file',
  importButton: 'Import…',
  cancelImport: 'Choose another file',
  importConfirmTitle: 'Replace this Hub with the export?',
  importConfirm: 'Import and restart',
  importConfirmBody:
    'Everything in the file is written to this Hub, all or nothing, and each table is checked against the file. Then the Hub restarts. You stay signed in, as the owner from the export.',
  importDevices:
    'The file has no passphrase, so this Hub keeps its own keys: paired devices must be added again, and Relay set up again if you use it.',
  importDone: 'The import is done and verified.',
  restoredOffTitle: 'Turned off until you turn them on again',
  importRestoredOff:
    'What a file cannot vouch for comes back off: MCP servers that run as programs here, plugins and external agent programs are turned off, hooks need trusting again, and every other signed-in session is signed out.',
  // delete-all
  deleteTitle: 'Delete all data',
  deleteIntro:
    'Delete everything on this Hub and start again from an empty Hub. Export first if you may need any of it.',
  deleteButton: 'Delete all data…',
  deleteConfirmTitle: 'Delete everything on this Hub?',
  deleteWhat:
    'Every account, chat, run, agent, memory, project, setting, file, device pairing, stored key and password, and the audit log on this Hub is deleted.',
  deleteKept:
    'Your owner account and this browser’s session stay, so you remain signed in. A new audit log starts with this deletion. Then the Hub restarts.',
  deleteNoUndo: 'This cannot be undone.',
  deleteConfirm: 'Delete everything and restart',
  deleteDone: 'Everything was deleted.',
  // restart
  restarting: 'The Hub is restarting. This page reloads when it is back.',
  restartSlow: 'The Hub has not come back yet. Reload this page in a moment.',
  reloadPage: 'Reload the page',
  // retention
  retentionTitle: 'How long data is kept',
  retentionIntro:
    'Older items are deleted by a daily sweep. Pinned chats and what they hold are always kept.',
  retentionForever: 'Forever',
  retentionAuditFloor: `Audit entries are kept at least ${AUDIT_RETENTION_FLOOR_DAYS} days, and the log stays verifiable from the oldest entry kept.`,
  retentionRecovery: `A deleted chat can be recovered for ${DELETED_RECOVERY_DAYS} days, then it is purged.`,
  lastSweep: 'Last sweep',
  nextSweep: 'Next sweep',
  noSweep: 'No sweep has run yet.',
  sweepButton: 'Sweep now…',
  sweepTitle: 'Delete what is past its time now?',
  sweepConfirm: 'Sweep now',
  sweepNothing: 'Nothing is due: a sweep now deletes nothing.',
  retentionLoadError: 'Could not load the retention settings.',
  shortenConfirm: 'Keep less',
  // crash reports
  crashTitle: 'Crash reports',
  crashIntro:
    'When the Hub crashes it writes a report here. A report holds the error type, a stack trace with paths relative to Nova, the versions and the platform. Never chats, files, settings or message text.',
  crashSwitch: 'Send crash reports',
  crashSwitchHint:
    'Off: nothing leaves this machine. On: each report is sent to the endpoint below, and reports already here are sent.',
  crashEndpoint: 'Endpoint',
  crashEndpointHint:
    'Where reports go: an https:// address you choose (http:// only to this machine). Empty: nowhere.',
  crashEndpointInvalid:
    'Enter an https:// address (http:// only to this machine), without a user name, password, query or fragment.',
  crashEndpointSave: 'Save endpoint',
  crashOnTitle: 'Send crash reports?',
  crashOnBody:
    'Each report is sent exactly as its preview shows. Reports already on this Hub are sent now.',
  crashOnNoEndpoint: 'No endpoint is set yet: nothing is sent until you set one.',
  crashOnConfirm: 'Send crash reports',
  crashNone: 'No crash reports. The Hub has not crashed, or the reports were deleted.',
  crashPreview: 'Preview',
  crashPreviewTitle: 'Crash report',
  crashPreviewIntro: 'This is exactly what is sent, byte for byte.',
  crashSend: 'Send this report',
  crashSent: 'The report was sent.',
  crashDelete: 'Delete',
  crashDeleteTitle: 'Delete this crash report?',
  crashDeleteAll: 'Delete all reports…',
  crashDeleteAllTitle: 'Delete every crash report?',
  crashLoadError: 'Could not load the crash reports.',
  crashWhyOff: 'Not sent: crash reports are off.',
  crashWhyNoEndpoint: 'Not sent: no endpoint is set.',
  crashWouldSend: 'It would be sent to this endpoint',
  notSent: 'Not sent',
  ownerOnly: 'Only the owner of this Hub can manage its data.',
} as const;

/** The page's sentences that carry numbers or names (whole sentences, for translation). */
export const DATA_TEXT = {
  holdsSecrets: (n: number) => `This Hub holds ${count(n)} stored keys and passwords.`,
  deleted: (r: { rows: number; tables: number; files: number; secrets: number }) =>
    `Deleted ${count(r.rows)} rows in ${count(r.tables)} tables, ${count(r.files)} files and ${count(r.secrets)} stored keys and passwords.`,
  imported: (r: { rows: number; tables: number; files: number; secrets: number }) =>
    `Imported ${count(r.rows)} rows in ${count(r.tables)} tables, ${count(r.files)} files and ${count(r.secrets)} stored keys and passwords. Every table matched the file.`,
  deleteCounts: (o: {
    rows: number;
    tables: number;
    files: { count: number; bytes: number };
    secrets: { count: number };
  }) =>
    `That is ${count(o.rows)} rows in ${count(o.tables)} tables, ${count(o.files.count)} files (${formatSize(o.files.bytes)}) and ${count(o.secrets.count)} stored keys and passwords.`,
  typeName: (name: string) => `Type the Hub's name, ${name}, to confirm`,
  importWrites: (c: {
    rows: number;
    tables: unknown[];
    files: { count: number; bytes: number };
    when: string;
  }) =>
    `${count(c.rows)} rows in ${count(c.tables.length)} tables and ${count(c.files.count)} files (${formatSize(c.files.bytes)}), exported ${c.when}, are written to this Hub.`,
  secretsCome: (n: number) => `${count(n)} stored keys and passwords come with it.`,
  checkRows: (rows: number, tables: number) => `${count(rows)} in ${count(tables)} tables`,
  sizeOf: (n: number, bytes: number) => `${count(n)} (${formatSize(bytes)})`,
  uploadedFile: (name: string, bytes: number) => `${name} (${formatSize(bytes)})`,
  restoredOff: (r: {
    mcpServers: number;
    plugins: number;
    agentAdapters: number;
    hooks: number;
    sessions: number;
  }): string[] =>
    [
      r.mcpServers === 1
        ? '1 MCP server that runs as a program here was turned off.'
        : r.mcpServers
          ? `${count(r.mcpServers)} MCP servers that run as programs here were turned off.`
          : null,
      r.plugins === 1
        ? '1 plugin was turned off.'
        : r.plugins
          ? `${count(r.plugins)} plugins were turned off.`
          : null,
      r.agentAdapters === 1
        ? '1 external agent program was turned off.'
        : r.agentAdapters
          ? `${count(r.agentAdapters)} external agent programs were turned off.`
          : null,
      r.hooks === 1
        ? '1 hook needs trusting again.'
        : r.hooks
          ? `${count(r.hooks)} hooks need trusting again.`
          : null,
      r.sessions === 1
        ? '1 other session was signed out.'
        : r.sessions
          ? `${count(r.sessions)} other sessions were signed out.`
          : null,
    ].filter((x): x is string => x !== null),
};

// ---- refusals ----------------------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  owner_only: DATA_STRINGS.ownerOnly,
  busy: 'Another export, import or deletion is running. Try again when it finishes.',
  confirmation_mismatch: "That is not this Hub's name. Type it exactly as shown.",
  too_large: 'The file is too large to import.',
  empty: 'The file is empty.',
  content_type: 'The file could not be sent. Try again.',
  passphrase_required: 'This export is encrypted. Enter its passphrase.',
  wrong_passphrase: 'The passphrase is wrong, or the file was changed after it was exported.',
  archive_damaged: 'The file is not a complete Nova export. It may be damaged or cut short.',
  unsupported_format: 'This export is in a format this version of Nova cannot read.',
  newer_schema: 'This export comes from a newer version of Nova. Update this Hub first.',
  checksum_mismatch: 'Part of the export does not match its checksum: the file is damaged.',
  hub_not_empty: 'This Hub already holds data. Delete all data first, then import.',
  ticket_expired: 'The download link expired. Start the export again.',
  crash_reports_off: 'Crash reports are off. Turn on sending first.',
  no_endpoint: 'No endpoint is set. Enter where crash reports go first.',
  send_failed: 'The endpoint did not take the report.',
  managed: "Your organization's policy does not allow this.",
};

export function reasonOf(err: unknown): string | null {
  const r = err instanceof ApiError ? err.body.details?.reason : null;
  return typeof r === 'string' ? r : null;
}

/** A refusal or failure of the data and usage routes in plain words, never a raw code. */
export function dataErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  const reason = reasonOf(err);
  if (reason && REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (err instanceof ApiError) {
    if (err.body.code === 'not_found')
      return 'It is no longer there. Reload the page and try again.';
    if (err.body.code === 'validation')
      return 'The Hub did not accept these values. Check them and try again.';
    if (err.status === 403) return "You can't do this here.";
  }
  return errorMessage(err, fallback);
}

// ---- retention ---------------------------------------------------------------------------------

export const RETENTION_TEXT: Record<
  RetentionItem,
  {
    label: string;
    hint: string;
    title: (days: number) => string;
    confirm: (days: number) => string;
  }
> = {
  threads: {
    label: 'Chats',
    title: (d) => `Keep chats for ${daysLabel(d)}?`,
    hint: 'Chats untouched this long are deleted.',
    confirm: (d) =>
      `Chats untouched for more than ${d} days are deleted at the next daily sweep. A deleted chat can be recovered for ${DELETED_RECOVERY_DAYS} days.`,
  },
  runs: {
    label: 'Work runs',
    title: (d) => `Keep Work runs for ${daysLabel(d)}?`,
    hint: 'Runs that ended this long ago are deleted with their plan and steps.',
    confirm: (d) =>
      `Work runs that ended more than ${d} days ago are deleted at the next daily sweep, with their plan and steps.`,
  },
  audit: {
    label: 'Audit log',
    title: (d) => `Keep the audit log for ${daysLabel(d)}?`,
    hint: `Entries older than this are pruned. At least ${AUDIT_RETENTION_FLOOR_DAYS} days.`,
    confirm: (d) =>
      `Audit entries older than ${d} days are pruned at the next daily sweep. The log stays verifiable from the oldest entry kept.`,
  },
  artifacts: {
    label: 'Artifacts',
    title: (d) => `Keep artifacts for ${daysLabel(d)}?`,
    hint: 'Artifacts not changed this long are deleted with their versions and files.',
    confirm: (d) =>
      `Artifacts not changed for more than ${d} days are deleted at the next daily sweep, with their versions and files.`,
  },
  traces: {
    label: 'Activity history',
    title: (d) => `Keep activity history for ${daysLabel(d)}?`,
    hint: 'The event log, agent browser traces, network checks and notification deliveries.',
    confirm: (d) => `Activity history older than ${d} days is deleted at the next daily sweep.`,
  },
};

const PRESETS = [7, 30, 90, 180, 365, 730, 1825];

export function daysLabel(days: number): string {
  if (days === 365) return '1 year';
  if (days === 730) return '2 years';
  if (days === 1825) return '5 years';
  if (days === 180) return '6 months';
  return days === 1 ? '1 day' : `${days} days`;
}

/** The choices for an item: forever, then presets at or above its floor, plus its current value. */
export function retentionOptions(
  floorDays: number,
  current: number | null,
): { value: string; label: string }[] {
  const days = PRESETS.filter((d) => d >= floorDays);
  if (current !== null && !days.includes(current)) days.push(current);
  days.sort((a, b) => a - b);
  return [
    { value: 'forever', label: DATA_STRINGS.retentionForever },
    ...days.map((d) => ({ value: String(d), label: daysLabel(d) })),
  ];
}

export const SWEEP_TEXT = {
  due: (n: number, label: string) => `${label}: ${count(n)} due now.`,
  kept: 'Everything is kept.',
  sweptAt: (when: string, trigger: 'schedule' | 'manual') =>
    trigger === 'manual' ? `${when}, run by hand.` : `${when}, on schedule.`,
  removed: (what: string) => `Deleted: ${what}.`,
  removedNothing: 'Nothing was due.',
  failed: (why: string) => `It stopped early: ${why}`,
  swept: (what: string | null) =>
    what ? `Sweep finished. Deleted: ${what}.` : 'Sweep finished. Nothing was due.',
  willDelete: (what: string) => `This deletes now: ${what}.`,
};

/** "Chats: 3, Work runs: 1" from a sweep's counts, or null when nothing. */
export function sweepCounts(counts: Partial<Record<RetentionItem, number>>): string | null {
  const parts = (Object.keys(RETENTION_TEXT) as RetentionItem[])
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${RETENTION_TEXT[k].label}: ${count(counts[k] ?? 0)}`);
  return parts.length ? parts.join(', ') : null;
}

// ---- secrets an import asks for again, and what an export leaves out ---------------------------

const SECRET_GROUPS: Record<string, string> = {
  provider: 'Model provider API keys',
  mcp: 'MCP server credentials',
  channel: 'Channel credentials',
  channels: 'Channel credentials',
  plugin: 'Plugin secrets',
  extension: 'Extension secrets',
  'agent-adapter': 'External agent keys',
  network: 'Network credentials',
  egress: 'Network credentials',
  team: 'Sign-in provider secrets',
  code: 'Code session credentials',
  cloud: 'Cloud runner credentials',
  oob: 'Out-of-band management passwords',
  devices: 'Device credentials',
  browser: 'Browser site credentials',
  telemetry: 'Telemetry export headers',
  trigger: 'Trigger secrets',
  schedule: 'Schedule secrets',
  import: 'Import credentials',
};

/** `secret://provider/…` refs grouped into plain kinds with their counts, largest first. */
export function secretGroups(refs: readonly string[]): { label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const ref of refs) {
    const kind = /^secret:\/\/([^/]+)\//.exec(ref)?.[1] ?? '';
    const label = SECRET_GROUPS[kind] ?? 'Other stored secrets';
    by.set(label, (by.get(label) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([label, n]) => ({ label, count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** What an export left out, in words (secrets are counted, not listed one by one). */
export function omissionText(o: ExportOmission): string {
  switch (o.kind) {
    case 'table':
      return `Table ${o.ref}: ${o.reason}.`;
    case 'file':
      return `File ${o.ref}: ${o.reason}.`;
    case 'secret':
      return `Secret ${o.ref}: ${o.reason}.`;
  }
}

// ---- crash reports -----------------------------------------------------------------------------

export const CRASH_KIND: Record<CrashKind, string> = {
  uncaughtException: 'Uncaught error',
  unhandledRejection: 'Unhandled promise rejection',
};

// ---- spend caps --------------------------------------------------------------------------------

export const SPEND_STRINGS = {
  title: 'Spend caps',
  intro:
    "Warn or stop when a provider's estimated cost reaches a limit you set, each day or each month (UTC). Local models cost nothing and have no cap.",
  none: 'Connect a cloud provider in Settings → Accounts to set a spend cap.',
  loadError: 'Could not load spend caps.',
  set: 'Set a cap',
  edit: 'Change',
  remove: 'Remove…',
  removeTitle: 'Remove this spend cap?',
  removeConfirm: 'Remove cap',
  noCap: 'No cap',
  limit: 'Cap (US dollars)',
  period: 'Period',
  warnAt: 'Warn at (% of the cap)',
  hardStop: 'Stop at the cap',
  hardStopHint:
    'Calls to this provider stop until the cap resets or you raise it. Off: you get a warning only.',
  save: 'Save cap',
  cancel: 'Cancel',
  saved: 'Spend cap saved.',
  removed: 'Spend cap removed.',
  limitInvalid: 'Enter an amount above $0 and up to $1,000,000.',
  warnInvalid: 'Warn at a share from 5% to 99%.',
  clearTitle: 'Usage records',
  clearIntro:
    'Clear your usage records to start the insights above again. Records a running Work run or goal still counts against its budget stay, and each spend cap keeps this period’s spend.',
  clearButton: 'Clear usage data…',
  clearConfirmTitle: 'Clear your usage data?',
  clearConfirm: 'Clear usage data',
  limitsTitle: 'Limits and spend',
  limitsIntro:
    "Each provider account's plan and limits as the provider reports them, this month's estimated spend and its spend cap.",
  limitsLoadError: 'Could not load provider limits.',
  localNoCost: 'Local: no cost and no cap.',
  thisMonth: 'This month',
  plan: 'Plan',
  reported: 'Last limit reported',
  noneReported: 'None reported',
  changeCap: 'Change the cap',
  setCap: 'Set a cap',
  raiseCap: 'Raise the cap',
  capReachedTitle: 'Spend cap reached',
} as const;

export const PERIOD_OPTIONS: { value: SpendPeriod; label: string }[] = [
  { value: 'month', label: 'Each month (UTC)' },
  { value: 'day', label: 'Each day (UTC)' },
];

export interface CapStateSpec {
  text: string;
  icon: IconName;
  tone: 'ready' | 'needs_input' | 'blocked' | null;
}

export function capState(cap: Pick<SpendCapView, 'state' | 'hardStop'>): CapStateSpec {
  if (cap.state === 'reached')
    return cap.hardStop
      ? { text: 'Cap reached: calls stopped', icon: 'stop', tone: 'blocked' }
      : { text: 'Cap reached: warning only', icon: 'alert', tone: 'needs_input' };
  if (cap.state === 'warning') return { text: 'Near the cap', icon: 'alert', tone: 'needs_input' };
  return { text: 'Under the cap', icon: 'check', tone: 'ready' };
}

/** "$12.00 of $50.00 this month" */
export function capSpentText(cap: SpendCapView): string {
  const per = cap.period === 'day' ? 'today' : 'this month';
  return `${formatUsd(cap.spentUsd)} of ${formatUsd(cap.limitUsd)} ${per}`;
}

export function capRulesText(cap: SpendCapView): string {
  const per = cap.period === 'day' ? 'a day' : 'a month';
  const stop = cap.hardStop ? 'stops calls at the cap' : 'only warns at the cap';
  return `${formatUsd(cap.limitUsd)} ${per}; warns at ${Math.round(cap.warnAt * 100)}%; ${stop}. Resets ${formatUtcDate(cap.resetsAt)}.`;
}

export interface CapDraft {
  limit: string;
  period: SpendPeriod;
  warnPercent: string;
  hardStop: boolean;
}

export function capDraft(cap: SpendCapView | null): CapDraft {
  return cap
    ? {
        limit: String(cap.limitUsd),
        period: cap.period,
        warnPercent: String(Math.round(cap.warnAt * 100)),
        hardStop: cap.hardStop,
      }
    : { limit: '', period: 'month', warnPercent: '80', hardStop: true };
}

/** The cap request from the form, or the first problem with it. */
export function parseCapDraft(
  d: CapDraft,
):
  | { body: { limitUsd: number; period: SpendPeriod; warnAt: number; hardStop: boolean } }
  | { error: string; field: 'limit' | 'warn' } {
  const limit = Number(d.limit.trim().replace(/^\$/, '').replace(/,/g, ''));
  if (!d.limit.trim() || !Number.isFinite(limit) || limit <= 0 || limit > 1_000_000)
    return { error: SPEND_STRINGS.limitInvalid, field: 'limit' };
  const warn = Number(d.warnPercent.trim().replace(/%$/, ''));
  if (!d.warnPercent.trim() || !Number.isFinite(warn) || warn < 5 || warn > 99)
    return { error: SPEND_STRINGS.warnInvalid, field: 'warn' };
  return {
    body: {
      limitUsd: Math.round(limit * 100) / 100,
      period: d.period,
      warnAt: Math.round(warn) / 100,
      hardStop: d.hardStop,
    },
  };
}

/** A limit a provider reported, in words. */
export function reportedText(r: {
  code: 'over_budget' | 'rate_limited';
  retryAfterMs: number | null;
}): string {
  if (r.code === 'over_budget') return 'Out of credit or over its budget at the provider.';
  return r.retryAfterMs
    ? `Rate limited by the provider; it asked to wait ${Math.ceil(r.retryAfterMs / 1000)} s.`
    : 'Rate limited by the provider.';
}

/**
 * A chat error that is a spend cap stopping the call (`over_budget` with the Hub's cap-reached
 * sentence, `packages/core/src/profile/spend.ts` capReachedError), with the provider it names.
 */
export function capReachedProvider(code: string, message: string): string | null | undefined {
  if (code !== 'over_budget') return undefined;
  const m = /^The ([a-z][a-z0-9_-]*) spend cap of /.exec(message);
  if (m) return m[1] ?? null;
  return /spend cap/i.test(message) ? null : undefined;
}
