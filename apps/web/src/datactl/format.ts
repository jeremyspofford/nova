// Words for data controls (FR-105, FR-121) and spend caps and provider limits (FR-116, FR-115):
// every user-facing string of these views is a message here (FR-016), whole sentences only, read at
// render time: the Hub's refusal reasons in plain words, retention items, the secrets an import
// asks for again, crash report kinds, sizes and money in the active locale, cap states, and the
// cap-reached error a chat shows. The Hub's own words (an omission's reason, a sweep's error)
// stay as the Hub sent them.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type { ExportOmission, RetentionItem, SpendCapView, SpendPeriod } from '@nova/shared';
import { AUDIT_RETENTION_FLOOR_DAYS, DELETED_RECOVERY_DAYS } from '@nova/shared';
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

/** A size in the active locale ("1.5 MB"). */
export function formatSize(bytes: number): string {
  return fmt.bytes(bytes);
}

const usd = (v: number, digits = 2) =>
  fmt.number(v, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const MONEY_TEXT = defineMessages('datactl.money', {
  /** A cost too small to show in cents: "under $0.01". */
  under: 'under {amount}',
});

/** US dollars in the active locale ("$12.00"), "under $0.01" for a sliver. */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return MONEY_TEXT.under({ amount: usd(0.01) });
  return usd(v);
}

export const count = (n: number) => fmt.number(n);

/** A UTC date, "Nov 1, 2026" (caps reset on UTC days and months). */
export function formatUtcDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return fmt.date(t, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- the page --------------------------------------------------------------------------------

export const DATA_STRINGS = defineMessages('datactl', {
  title: 'Data',
  intro:
    'Everything on this Hub is yours. Export it, move it to another Hub, delete it, choose how long it is kept, and decide whether crash reports leave this machine.',
  privacy:
    'Nova never uses your data to train models, and it sends nothing about how you use it anywhere unless you turn something on here or in telemetry export.',
  overviewTitle: 'What this Hub holds',
  overviewLoadError: "Could not load this Hub's data overview.",
  overviewLoading: 'Loading what this Hub holds',
  hubName: "Hub's name",
  version: 'Nova version',
  rows: 'Rows',
  tables: 'Tables',
  files: 'Files',
  secrets: 'Stored keys and passwords',
  retry: 'Retry',
  cancel: 'Cancel',
  close: 'Close',
  // export
  exportTitle: 'Export',
  exportIntro:
    'Download one file with everything on this Hub: every account, chat, run, agent, memory, project, setting, file and the audit log.',
  passphrase: 'Passphrase (optional)',
  passphraseHint:
    'With a passphrase the file is encrypted and includes the stored keys and passwords. At least {min} characters; keep it safe, it cannot be recovered.',
  passphraseRepeat: 'Repeat the passphrase',
  passphraseShort: 'Use at least {min} characters.',
  passphraseMismatch: 'The two passphrases differ.',
  sealedConfirmHint:
    'A file with a passphrase carries every stored key and password on this Hub. Type the Hub’s name to confirm.',
  sealedNameMismatch: "That is not this Hub's name. Type it exactly as shown.",
  withoutPassphrase:
    'Without a passphrase, stored keys and passwords are left out (you enter them again after an import), and so are the Hub’s own keys, so paired devices must be added again.',
  exportButton: 'Export',
  exporting: 'Preparing the export',
  exportStarted:
    'Your download has started. The file is written as it downloads; keep this page open until it finishes.',
  exportFailed: 'Could not start the export.',
  // import
  importTitle: 'Import',
  importIntro:
    'Move a Hub here: import an export into this Hub. It must be empty: a new Hub, or one after Delete all.',
  importNotEmpty:
    'This Hub already holds data, so it cannot take an import. Delete all data first, or import into a new Hub.',
  importBlocking: 'Tables that hold data',
  importChoose: 'Choose an export file',
  uploading: 'Uploading',
  /** The uploaded file: its name and size. */
  uploadedAs: 'Uploaded: {file}',
  uploadFailed: 'Could not upload the file.',
  importEncrypted: 'This export is encrypted. Enter its passphrase to check it.',
  importPassphrase: 'Passphrase',
  checkButton: 'Check the file',
  checking: 'Checking',
  checkFailed: 'Could not check the file.',
  checkTitle: 'What the file holds',
  checkedStatus: 'The file was checked. What it holds is shown below.',
  exportedAt: 'Exported',
  fromVersion: 'From Nova',
  migrates: 'Made by an older Nova: its data is brought up to date as it is imported.',
  secretsIncluded: 'Stored keys and passwords included',
  secretsLeftOut: 'Stored keys and passwords left out',
  toReEnterTitle: 'You will enter these again',
  toReEnterNone: 'Nothing: every stored key and password is in the file.',
  /** A kind of stored secret and how many of them. */
  groupCount: '{group}: {n}',
  omittedTitle: 'Left out of the file',
  importButton: 'Import…',
  cancelImport: 'Choose another file',
  importConfirmTitle: 'Replace this Hub with the export?',
  importConfirm: 'Import and restart',
  importConfirmBody:
    'Everything in the file is written to this Hub, all or nothing, and each table is checked against the file. Then the Hub restarts. You stay signed in, as the owner from the export.',
  importDevices:
    'The file has no passphrase, so this Hub keeps its own keys: paired devices must be added again, and Relay set up again if you use it.',
  importFailed: 'The import failed. Nothing was changed.',
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
  deleteFailed: 'Nothing was deleted.',
  deleteDone: 'Everything was deleted.',
  // restart
  restarting: 'The Hub is restarting. This page reloads when it is back.',
  restartSlow: 'The Hub has not come back yet. Reload this page in a moment.',
  reloadPage: 'Reload the page',
  // retention
  retentionTitle: 'How long data is kept',
  retentionIntro:
    'Older items are deleted by a daily sweep. Pinned chats and what they hold are always kept.',
  retentionLoading: 'Loading the retention settings',
  retentionForever: 'Forever',
  retentionAuditFloor:
    'Audit entries are kept at least {days} days, and the log stays verifiable from the oldest entry kept.',
  retentionRecovery: 'A deleted chat can be recovered for {days} days, then it is purged.',
  lastSweep: 'Last sweep',
  nextSweep: 'Next sweep',
  noSweep: 'No sweep has run yet.',
  sweepButton: 'Sweep now…',
  sweepTitle: 'Delete what is past its time now?',
  sweepConfirm: 'Sweep now',
  sweepNothing: 'Nothing is due: a sweep now deletes nothing.',
  sweepFailed: 'The sweep failed.',
  retentionLoadError: 'Could not load the retention settings.',
  shortenConfirm: 'Keep less',
  saveFailed: 'Could not save.',
  /** A toast: the Hub's or the area's words after the colon. */
  saveFailedWhy: 'Could not save: {why}',
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
  crashEndpointSaved: 'Endpoint saved.',
  crashEndpointFailed: 'Could not save the endpoint.',
  crashEndpointIs: 'Endpoint: {endpoint}',
  crashOnTitle: 'Send crash reports?',
  crashOnBody:
    'Each report is sent exactly as its preview shows. Reports already on this Hub are sent now.',
  crashOnNoEndpoint: 'No endpoint is set yet: nothing is sent until you set one.',
  crashOnConfirm: 'Send crash reports',
  crashNone: 'No crash reports. The Hub has not crashed, or the reports were deleted.',
  crashLoading: 'Loading crash reports',
  /** A report: its error's name, then when it happened. */
  crashReportTitle: '{name}, {when}',
  crashSentAt: 'Sent {when}.',
  crashFailed: 'Not sent: {why}',
  crashPreview: 'Preview',
  crashPreviewTitle: 'Crash report',
  crashPreviewIntro: 'This is exactly what is sent, byte for byte.',
  crashPreviewLoading: 'Loading the preview',
  crashPreviewFailed: 'Could not load the preview.',
  crashSend: 'Send this report',
  crashSendFailed: 'The report was not sent.',
  crashSent: 'The report was sent.',
  crashDelete: 'Delete',
  crashDeleteFailed: 'Could not delete.',
  crashDeleted: 'Crash report deleted.',
  crashDeletedAll: '{n, plural, one {# crash report deleted.} other {# crash reports deleted.}}',
  crashDeleteTitle: 'Delete this crash report?',
  crashDeleteAll: 'Delete all reports…',
  crashDeleteAllTitle: 'Delete every crash report?',
  crashLoadError: 'Could not load the crash reports.',
  crashWhyOff: 'Not sent: crash reports are off.',
  crashWhyNoEndpoint: 'Not sent: no endpoint is set.',
  /** Followed by the endpoint's address. */
  crashWouldSend: 'It would be sent to this endpoint: {endpoint}',
  notSent: 'Not sent',
  ownerOnly: 'Only the owner of this Hub can manage its data.',
});

/** Counted nouns the page's sentences carry (each a whole phrase, for translation). */
const COUNTED = defineMessages('datactl.counted', {
  rows: '{n, plural, one {# row} other {# rows}}',
  tables: '{n, plural, one {# table} other {# tables}}',
  files: '{n, plural, one {# file} other {# files}}',
  secrets: '{n, plural, one {# stored key or password} other {# stored keys and passwords}}',
});

const SENTENCES = defineMessages('datactl.sentences', {
  holdsSecrets:
    '{n, plural, one {This Hub holds # stored key or password.} other {This Hub holds # stored keys and passwords.}}',
  deleted: 'Deleted {rows} in {tables}, {files} and {secrets}.',
  imported: 'Imported {rows} in {tables}, {files} and {secrets}. Every table matched the file.',
  deleteCounts: 'That is {rows} in {tables}, {files} ({size}) and {secrets}.',
  typeName: "Type the Hub's name, {name}, to confirm",
  importWrites:
    '{rows} in {tables} and {files} ({size}), exported {when}, are written to this Hub.',
  secretsCome:
    '{n, plural, one {# stored key or password comes with it.} other {# stored keys and passwords come with it.}}',
  /** Rows of an export: how many, in how many tables. */
  checkRows: '{n} in {tables}',
  /** How many files and their size. */
  sizeOf: '{n} ({size})',
  /** A file's name and size. */
  uploadedFile: '{name} ({size})',
  restoredOff: {
    mcpServers:
      '{n, plural, one {# MCP server that runs as a program here was turned off.} other {# MCP servers that run as programs here were turned off.}}',
    plugins: '{n, plural, one {# plugin was turned off.} other {# plugins were turned off.}}',
    agentAdapters:
      '{n, plural, one {# external agent program was turned off.} other {# external agent programs were turned off.}}',
    hooks: '{n, plural, one {# hook needs trusting again.} other {# hooks need trusting again.}}',
    sessions:
      '{n, plural, one {# other session was signed out.} other {# other sessions were signed out.}}',
  },
});

type Counts = { rows: number; tables: number; files: number; secrets: number };
const counted = (r: Counts) => ({
  rows: COUNTED.rows({ n: r.rows }),
  tables: COUNTED.tables({ n: r.tables }),
  files: COUNTED.files({ n: r.files }),
  secrets: COUNTED.secrets({ n: r.secrets }),
});

/** The page's sentences that carry numbers or names (whole sentences, for translation). */
export const DATA_TEXT = {
  holdsSecrets: (n: number) => SENTENCES.holdsSecrets({ n }),
  deleted: (r: Counts) => SENTENCES.deleted(counted(r)),
  imported: (r: Counts) => SENTENCES.imported(counted(r)),
  deleteCounts: (o: {
    rows: number;
    tables: number;
    files: { count: number; bytes: number };
    secrets: { count: number };
  }) =>
    SENTENCES.deleteCounts({
      ...counted({
        rows: o.rows,
        tables: o.tables,
        files: o.files.count,
        secrets: o.secrets.count,
      }),
      size: formatSize(o.files.bytes),
    }),
  typeName: (name: string) => SENTENCES.typeName({ name }),
  importWrites: (c: {
    rows: number;
    tables: unknown[];
    files: { count: number; bytes: number };
    when: string;
  }) =>
    SENTENCES.importWrites({
      rows: COUNTED.rows({ n: c.rows }),
      tables: COUNTED.tables({ n: c.tables.length }),
      files: COUNTED.files({ n: c.files.count }),
      size: formatSize(c.files.bytes),
      when: c.when,
    }),
  secretsCome: (n: number) => SENTENCES.secretsCome({ n }),
  checkRows: (rows: number, tables: number) =>
    SENTENCES.checkRows({ n: count(rows), tables: COUNTED.tables({ n: tables }) }),
  sizeOf: (n: number, bytes: number) => SENTENCES.sizeOf({ n: count(n), size: formatSize(bytes) }),
  uploadedFile: (name: string, bytes: number) =>
    SENTENCES.uploadedFile({ name, size: formatSize(bytes) }),
  restoredOff: (r: {
    mcpServers: number;
    plugins: number;
    agentAdapters: number;
    hooks: number;
    sessions: number;
  }): string[] =>
    (['mcpServers', 'plugins', 'agentAdapters', 'hooks', 'sessions'] as const)
      .filter((k) => r[k] > 0)
      .map((k) => SENTENCES.restoredOff[k]({ n: r[k] })),
};

// ---- refusals ----------------------------------------------------------------------------------

const REASON_TEXT = defineMessages('datactl.reasons', {
  busy: 'Another export, import or deletion is running. Try again when it finishes.',
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
  hub_only:
    'An export with a passphrase carries every stored key and password, so it can only be started from a browser signed in to the Hub, not from a paired device.',
  foreign_secret:
    'The file points to stored keys or passwords that it does not carry or that belong to a Hub itself, so it was refused. Nothing was imported.',
  unsafe_path:
    'The file names a folder or file outside where Nova keeps its data, so it was refused. Nothing was imported.',
  disk_full:
    'There is not enough free disk space on the Hub to import this file. Free some space and try again.',
  archive_inconsistent:
    'The file refers to data it does not hold. It may be damaged, or it was not made by Nova.',
  verify_failed:
    'What was written did not match the file, so nothing was imported. Try again; if it happens again, the file may be damaged.',
  crash_reports_off: 'Crash reports are off. Turn on sending first.',
  no_endpoint: 'No endpoint is set. Enter where crash reports go first.',
  send_failed: 'The endpoint did not take the report.',
  managed: "Your organization's policy does not allow this.",
});

const ERROR_TEXT = defineMessages('datactl.errors', {
  notFound: 'It is no longer there. Reload the page and try again.',
  validation: 'The Hub did not accept these values. Check them and try again.',
  forbidden: "You can't do this here.",
  somethingWrong: 'Something went wrong.',
});

/** A refusal's words by its reason, or undefined for one this client does not know. */
function reasonText(reason: string): string | undefined {
  if (reason === 'owner_only') return DATA_STRINGS.ownerOnly;
  if (reason === 'confirmation_mismatch') return DATA_STRINGS.sealedNameMismatch;
  return messageFor(REASON_TEXT, reason);
}

export function reasonOf(err: unknown): string | null {
  const r = err instanceof ApiError ? err.body.details?.reason : null;
  return typeof r === 'string' ? r : null;
}

/** A refusal or failure of the data and usage routes in plain words, never a raw code. */
export function dataErrorMessage(
  err: unknown,
  fallback: string = ERROR_TEXT.somethingWrong,
): string {
  const reason = reasonOf(err);
  const text = reason ? reasonText(reason) : undefined;
  if (text) return text;
  if (err instanceof ApiError) {
    if (err.body.code === 'not_found') return ERROR_TEXT.notFound;
    if (err.body.code === 'validation') return ERROR_TEXT.validation;
    if (err.status === 403) return ERROR_TEXT.forbidden;
  }
  return errorMessage(err, fallback);
}

// ---- retention ---------------------------------------------------------------------------------

/** Each kind of data's words; `confirm` is said before keeping it less long. */
export const RETENTION_TEXT = defineMessages('datactl.retention', {
  threads: {
    label: 'Chats',
    title: 'Keep chats for {period}?',
    hint: 'Chats untouched this long are deleted.',
    confirm:
      '{days, plural, one {Chats untouched for more than # day are deleted at the next daily sweep.} other {Chats untouched for more than # days are deleted at the next daily sweep.}}',
  },
  runs: {
    label: 'Work runs',
    title: 'Keep Work runs for {period}?',
    hint: 'Runs that ended this long ago are deleted with their plan and steps.',
    confirm:
      '{days, plural, one {Work runs that ended more than # day ago are deleted at the next daily sweep, with their plan and steps.} other {Work runs that ended more than # days ago are deleted at the next daily sweep, with their plan and steps.}}',
  },
  audit: {
    label: 'Audit log',
    title: 'Keep the audit log for {period}?',
    hint: 'Entries older than this are pruned. At least {floor} days.',
    confirm:
      '{days, plural, one {Audit entries older than # day are pruned at the next daily sweep. The log stays verifiable from the oldest entry kept.} other {Audit entries older than # days are pruned at the next daily sweep. The log stays verifiable from the oldest entry kept.}}',
  },
  artifacts: {
    label: 'Artifacts',
    title: 'Keep artifacts for {period}?',
    hint: 'Artifacts not changed this long are deleted with their versions and files.',
    confirm:
      '{days, plural, one {Artifacts not changed for more than # day are deleted at the next daily sweep, with their versions and files.} other {Artifacts not changed for more than # days are deleted at the next daily sweep, with their versions and files.}}',
  },
  traces: {
    label: 'Activity history',
    title: 'Keep activity history for {period}?',
    hint: 'The event log, agent browser traces, network checks and notification deliveries.',
    confirm:
      '{days, plural, one {Activity history older than # day is deleted at the next daily sweep.} other {Activity history older than # days is deleted at the next daily sweep.}}',
  },
  /** After the chats' confirmation. */
  recoverable:
    '{days, plural, one {A deleted chat can be recovered for # day.} other {A deleted chat can be recovered for # days.}}',
});

/** The hint under an item's choice. */
export function retentionHint(item: RetentionItem): string {
  return item === 'audit'
    ? RETENTION_TEXT.audit.hint({ floor: AUDIT_RETENTION_FLOOR_DAYS })
    : RETENTION_TEXT[item].hint;
}

/** What keeping `item` for `days` deletes, said before it is saved. */
export function retentionConfirmText(item: RetentionItem, days: number): string {
  const text = RETENTION_TEXT[item].confirm({ days });
  return item === 'threads'
    ? `${text} ${RETENTION_TEXT.recoverable({ days: DELETED_RECOVERY_DAYS })}`
    : text;
}

const PERIOD_TEXT = defineMessages('datactl.periods', {
  years: '{n, plural, one {# year} other {# years}}',
  months: '{n, plural, one {# month} other {# months}}',
  days: '{n, plural, one {# day} other {# days}}',
});

const PRESETS = [7, 30, 90, 180, 365, 730, 1825];

export function daysLabel(days: number): string {
  if (days === 365) return PERIOD_TEXT.years({ n: 1 });
  if (days === 730) return PERIOD_TEXT.years({ n: 2 });
  if (days === 1825) return PERIOD_TEXT.years({ n: 5 });
  if (days === 180) return PERIOD_TEXT.months({ n: 6 });
  return PERIOD_TEXT.days({ n: days });
}

/** The question before keeping `item` for `days`. */
export function retentionTitle(item: RetentionItem, days: number): string {
  return RETENTION_TEXT[item].title({ period: daysLabel(days) });
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

export const SWEEP_TEXT = defineMessages('datactl.sweep', {
  due: '{item}: {n} due now.',
  kept: 'Everything is kept.',
  sweptAt: '{trigger, select, manual {{when}, run by hand.} other {{when}, on schedule.}}',
  removed: 'Deleted: {what}.',
  removedNothing: 'Nothing was due.',
  failed: 'It stopped early: {why}',
  sweptSome: 'Sweep finished. Deleted: {what}.',
  sweptNone: 'Sweep finished. Nothing was due.',
  willDelete: 'This deletes now: {what}.',
  /** One kind of data and how many of its items: "Chats: 3". */
  itemCount: '{item}: {n}',
});

/** "Chats: 3, Work runs: 1" from a sweep's counts, or null when nothing. */
export function sweepCounts(counts: Partial<Record<RetentionItem, number>>): string | null {
  const parts = (Object.keys(RETENTION_TEXT) as (RetentionItem | 'recoverable')[])
    .filter((k): k is RetentionItem => k !== 'recoverable' && (counts[k] ?? 0) > 0)
    .map((k) => SWEEP_TEXT.itemCount({ item: RETENTION_TEXT[k].label, n: counts[k] ?? 0 }));
  return parts.length ? fmt.list(parts, { type: 'unit', style: 'short' }) : null;
}

// ---- secrets an import asks for again, and what an export leaves out ---------------------------

const SECRET_GROUP_TEXT = defineMessages('datactl.secretGroups', {
  provider: 'Model provider API keys',
  mcp: 'MCP server credentials',
  channel: 'Channel credentials',
  plugin: 'Plugin secrets',
  extension: 'Extension secrets',
  agentAdapter: 'External agent keys',
  network: 'Network credentials',
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
  other: 'Other stored secrets',
});

/** `secret://<kind>/…` kinds that share a group with another. */
const SECRET_KIND_ALIAS: Readonly<Record<string, string>> = {
  channels: 'channel',
  egress: 'network',
  'agent-adapter': 'agentAdapter',
};

/** `secret://provider/…` refs grouped into plain kinds with their counts, largest first. */
export function secretGroups(refs: readonly string[]): { label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const ref of refs) {
    const raw = /^secret:\/\/([^/]+)\//.exec(ref)?.[1] ?? '';
    const kind = SECRET_KIND_ALIAS[raw] ?? raw;
    const label =
      (kind !== 'other' && messageFor(SECRET_GROUP_TEXT, kind)) || SECRET_GROUP_TEXT.other;
    by.set(label, (by.get(label) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([label, n]) => ({ label, count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const OMISSION_TEXT = defineMessages('datactl.omission', {
  table: 'Table {ref}: {reason}.',
  file: 'File {ref}: {reason}.',
  secret: 'Secret {ref}: {reason}.',
});

/** What an export left out, in words (the reason is the Hub's; secrets are counted, not listed). */
export function omissionText(o: ExportOmission): string {
  return OMISSION_TEXT[o.kind]({ ref: o.ref, reason: o.reason });
}

// ---- crash reports -----------------------------------------------------------------------------

export const CRASH_KIND = defineMessages('datactl.crashKind', {
  uncaughtException: 'Uncaught error',
  unhandledRejection: 'Unhandled promise rejection',
});

// ---- spend caps --------------------------------------------------------------------------------

export const SPEND_STRINGS = defineMessages('datactl.spend', {
  title: 'Spend caps',
  intro:
    "Warn or stop when a provider's estimated cost reaches a limit you set, each day or each month (UTC). Local models cost nothing and have no cap.",
  none: 'Connect a cloud provider in Settings → Accounts to set a spend cap.',
  loading: 'Loading spend caps',
  loadError: 'Could not load spend caps.',
  set: 'Set a cap',
  edit: 'Change',
  remove: 'Remove…',
  removeTitle: 'Remove this spend cap?',
  removeConfirm: 'Remove cap',
  removeFailed: 'Could not remove the cap.',
  removeBody:
    'Calls to {provider} are no longer stopped or warned about by a cap. Usage is still counted.',
  noCap: 'No cap',
  editTitle: 'Spend cap for {provider}',
  meter: '{provider} spend against its cap',
  limit: 'Cap (US dollars)',
  period: 'Period',
  periodMonth: 'Each month (UTC)',
  periodDay: 'Each day (UTC)',
  warnAt: 'Warn at (% of the cap)',
  hardStop: 'Stop at the cap',
  hardStopHint:
    'Calls to this provider stop until the cap resets or you raise it. Off: you get a warning only.',
  save: 'Save cap',
  saveFailed: 'Could not save the cap.',
  cancel: 'Cancel',
  saved: 'Spend cap saved.',
  removed: 'Spend cap removed.',
  limitInvalid: 'Enter an amount above {min} and up to {max}.',
  warnInvalid: 'Warn at a share from {min} to {max}.',
  clearTitle: 'Usage records',
  clearIntro:
    'Clear your usage records to start the insights above again. Records a running Work run or goal still counts against its budget stay, and each spend cap keeps this period’s spend.',
  clearButton: 'Clear usage data…',
  clearConfirmTitle: 'Clear your usage data?',
  clearConfirm: 'Clear usage data',
  clearFailed: 'Could not clear usage data.',
  cleared: '{n, plural, one {# usage record cleared.} other {# usage records cleared.}}',
  limitsTitle: 'Limits and spend',
  limitsIntro:
    "Each provider account's plan and limits as the provider reports them, this month's estimated spend and its spend cap.",
  limitsLoading: 'Loading provider limits',
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
});

/** A provider account's plan and limits, as the provider reports them. */
export const LIMIT_TEXT = defineMessages('datactl.limits', {
  plan: 'Plan: {plan}.',
  used: '{used} of {limit} used.',
  limit: 'Limit: {limit}.',
  resets: 'Resets {date}.',
  /** What the provider reported, then when. */
  reportedAt: '{text} ({when})',
  spent: '{amount} this month.',
  none: 'No plan or limits reported.',
});

/** The period choices of a cap, in the active locale. */
export function periodOptions(): { value: SpendPeriod; label: string }[] {
  return [
    { value: 'month', label: SPEND_STRINGS.periodMonth },
    { value: 'day', label: SPEND_STRINGS.periodDay },
  ];
}

export interface CapStateSpec {
  text: string;
  icon: IconName;
  tone: 'ready' | 'needs_input' | 'blocked' | null;
}

const CAP_STATE_TEXT = defineMessages('datactl.capState', {
  stopped: 'Cap reached: calls stopped',
  warned: 'Cap reached: warning only',
  near: 'Near the cap',
  under: 'Under the cap',
});

export function capState(cap: Pick<SpendCapView, 'state' | 'hardStop'>): CapStateSpec {
  if (cap.state === 'reached')
    return cap.hardStop
      ? { text: CAP_STATE_TEXT.stopped, icon: 'stop', tone: 'blocked' }
      : { text: CAP_STATE_TEXT.warned, icon: 'alert', tone: 'needs_input' };
  if (cap.state === 'warning')
    return { text: CAP_STATE_TEXT.near, icon: 'alert', tone: 'needs_input' };
  return { text: CAP_STATE_TEXT.under, icon: 'check', tone: 'ready' };
}

const CAP_TEXT = defineMessages('datactl.cap', {
  spent: '{period, select, day {{spent} of {limit} today} other {{spent} of {limit} this month}}',
  rules:
    '{period, select, day {{limit} a day} other {{limit} a month}}; warns at {percent}; {stop, select, hard {stops calls at the cap} other {only warns at the cap}}. Resets {date}.',
});

/** "$12.00 of $50.00 this month" */
export function capSpentText(cap: SpendCapView): string {
  return CAP_TEXT.spent({
    period: cap.period,
    spent: formatUsd(cap.spentUsd),
    limit: formatUsd(cap.limitUsd),
  });
}

export function capRulesText(cap: SpendCapView): string {
  return CAP_TEXT.rules({
    period: cap.period,
    limit: formatUsd(cap.limitUsd),
    percent: fmt.percent(cap.warnAt),
    stop: cap.hardStop ? 'hard' : 'soft',
    date: formatUtcDate(cap.resetsAt),
  });
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
    return {
      error: SPEND_STRINGS.limitInvalid({ min: usd(0, 0), max: usd(1_000_000, 0) }),
      field: 'limit',
    };
  const warn = Number(d.warnPercent.trim().replace(/%$/, ''));
  if (!d.warnPercent.trim() || !Number.isFinite(warn) || warn < 5 || warn > 99)
    return {
      error: SPEND_STRINGS.warnInvalid({ min: fmt.percent(0.05), max: fmt.percent(0.99) }),
      field: 'warn',
    };
  return {
    body: {
      limitUsd: Math.round(limit * 100) / 100,
      period: d.period,
      warnAt: Math.round(warn) / 100,
      hardStop: d.hardStop,
    },
  };
}

const REPORTED_TEXT = defineMessages('datactl.reported', {
  overBudget: 'Out of credit or over its budget at the provider.',
  rateLimitedWait: 'Rate limited by the provider; it asked to wait {wait}.',
  rateLimited: 'Rate limited by the provider.',
});

/** A limit a provider reported, in words. */
export function reportedText(r: {
  code: 'over_budget' | 'rate_limited';
  retryAfterMs: number | null;
}): string {
  if (r.code === 'over_budget') return REPORTED_TEXT.overBudget;
  return r.retryAfterMs
    ? REPORTED_TEXT.rateLimitedWait({
        wait: fmt.duration(Math.ceil(r.retryAfterMs / 1000) * 1000),
      })
    : REPORTED_TEXT.rateLimited;
}

/**
 * A chat error that is a spend cap stopping the call, with the provider it names (null when it
 * names none): the error part's `details: {reason: 'spend_cap', provider}`
 * (`packages/core/src/profile/spend.ts` capReachedError). Parts stored before that field get the
 * old match: `over_budget` with the Hub's cap-reached sentence.
 */
export function capReachedProvider(
  code: string,
  message: string,
  details?: { reason: string; provider?: string } | null,
): string | null | undefined {
  if (details?.reason === 'spend_cap')
    return typeof details.provider === 'string' && details.provider ? details.provider : null;
  if (details?.reason) return undefined;
  if (code !== 'over_budget') return undefined;
  const m = /^The ([a-z][a-z0-9_-]*) spend cap of /.exec(message);
  if (m) return m[1] ?? null;
  return /spend cap/i.test(message) ? null : undefined;
}
