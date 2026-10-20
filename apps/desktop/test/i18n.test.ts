// The shell's language (FR-016): which locale it picks, where translations come from, and that
// every word it writes goes through messages (checked in the pseudo-locales).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShellShortcutView, ShellStatusItemView } from '@nova/shared';
import { loadLocale, localeDirection, setCatalogLoader, setLocale } from '@nova/i18n';
import { isUnlocalized } from '@nova/i18n/residue';
import { noTextReason } from '../src/capture/index.ts';
import { parseConnectInput, refusalMessage, replacementMessage } from '../src/connect.ts';
import { reasonMessage } from '../src/local-runtime.ts';
import { CATALOG_DIR, catalogDirLoader, resolveDesktopLocale } from '../src/locale.ts';
import { parseAccelerator, shortcutProblems } from '../src/shortcuts.ts';
import { quickRows, statusMenuLabel, statusSummary } from '../src/status.ts';
import {
  CAPTURE_TEXT,
  CONFIG_TEXT,
  MENU_TEXT,
  SHELL_TEXT,
  STATUS_TEXT,
  draftNotes,
  pageText,
} from '../src/text.ts';

afterEach(() => {
  setLocale('en');
  setCatalogLoader(null);
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fail with the offenders when any string still has plain English letters outside `data`. */
function expectLocalized(strings: readonly string[], data: readonly string[] = []) {
  expect(strings.filter((s) => isUnlocalized(s, data))).toEqual([]);
}

const item = (over: Partial<ShellStatusItemView> = {}): ShellStatusItemView => ({
  kind: 'thread',
  id: 't1',
  title: 'Plan the trip',
  status: 'needs_input',
  reason: null,
  path: '/chat/t1',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

describe('choosing the language', () => {
  it('follows the Hub setting, else the system languages, never a pseudo-locale for system', () => {
    expect(resolveDesktopLocale('ar', ['en-US'])).toBe('ar');
    expect(resolveDesktopLocale('en-XA', ['ar'])).toBe('en-XA');
    expect(resolveDesktopLocale('system', ['ar-EG', 'en'])).toBe('ar');
    expect(resolveDesktopLocale(null, ['fr-FR', 'en_GB'])).toBe('en');
    expect(resolveDesktopLocale(undefined, ['fr-FR'])).toBe('en');
    expect(resolveDesktopLocale('xx', ['en-XA', 'ar'])).toBe('en');
    expect(resolveDesktopLocale(null, [])).toBe('en');
  });

  it('reads the web app’s catalogs from a folder; a missing folder means English', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-desktop-i18n-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'ar'));
    writeFileSync(
      join(dir, 'ar', 'desktop.menu.json'),
      JSON.stringify({ quickChat: 'دردشة سريعة' }),
    );
    expect(await catalogDirLoader(dir)('fr')).toEqual([]);
    setCatalogLoader(catalogDirLoader(dir));
    await loadLocale('ar');
    setLocale('ar');
    expect(MENU_TEXT.quickChat).toBe('دردشة سريعة');
    // Not translated: English.
    expect(MENU_TEXT.newTask).toBe('New task');
    expect(CATALOG_DIR.replace(/\\/g, '/')).toMatch(/apps\/web\/src\/i18n\/locales$/);
  });

  it('runs right to left in Arabic and ar-XB', () => {
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('ar-XB')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });
});

describe('every word the shell writes, in the pseudo-locales', () => {
  const words = () => {
    const shortcuts: ShellShortcutView[] = [
      {
        action: 'quickChat',
        accelerator: 'Control+Alt+N',
        label: 'Ctrl+Alt+N',
        registered: false,
        problem: 'conflict',
      },
      {
        action: 'attachWindow',
        accelerator: 'Control+Alt+A',
        label: 'Ctrl+Alt+A',
        registered: false,
        problem: 'duplicate',
      },
      { action: 'quickChat', accelerator: 'X', label: 'X', registered: false, problem: 'invalid' },
    ];
    const reasons = ['format', 'bad', 'mod', 'two', 'reserved'].map((k) => {
      const raw = {
        format: 'N',
        bad: 'Control+Alt+Nope',
        mod: 'Hyper+Alt+N',
        two: 'Control+N',
        reserved: 'Control+Alt+Delete',
      }[k]!;
      const r = parseAccelerator(raw);
      return r.ok ? '' : r.reason;
    });
    const refusals = (
      [
        'invalid_input',
        'insecure_transport',
        'unreachable',
        'identity_unavailable',
        'bad_response',
        'untrusted_certificate',
        'pin_mismatch',
        'bad_signature',
        'not_listed',
        'expired',
      ] as const
    ).flatMap((r) => [refusalMessage(r, 'https://hub.local:7443'), refusalMessage(r, null)]);
    const inputs = [
      parseConnectInput({ link: 'nonsense' }),
      parseConnectInput({ url: '' }),
      parseConnectInput({ url: 'https://hub.local:7443', pin: 'short' }),
    ].map((r) => ('message' in r ? r.message : ''));
    return [
      ...Object.values(pageText('connect')),
      ...Object.values(pageText('quick')),
      ...Object.values(pageText('attach')),
      ...Object.values(MENU_TEXT).filter((v): v is string => typeof v === 'string'),
      ...Object.values(SHELL_TEXT).filter((v): v is string => typeof v === 'string'),
      ...Object.values(SHELL_TEXT.windows),
      ...Object.values(CAPTURE_TEXT).filter((v): v is string => typeof v === 'string'),
      CONFIG_TEXT.damaged,
      statusSummary([item(), item({ status: 'blocked' })]),
      statusSummary([item(), item()]),
      statusSummary([item({ status: 'blocked' })]),
      statusMenuLabel(item({ kind: 'run' })),
      ...quickRows([item({ kind: 'agent' }), item({ reason: 'waiting on Pat' })]).flatMap((r) => [
        r.status,
        r.detail,
        r.label,
      ]),
      STATUS_TEXT.newChat,
      ...shortcutProblems(shortcuts),
      ...reasons,
      ...refusals,
      ...inputs,
      ...(['no_novad', 'no_access', 'scope_missing', 'no_model_server', 'failed'] as const).map(
        (r) => reasonMessage(r),
      ),
      reasonMessage('failed', 'timeout'),
      noTextReason('darwin'),
      noTextReason('win32'),
      noTextReason('linux'),
      replacementMessage({
        current: 'https://a.local',
        next: 'https://b.local',
        fingerprint: 'abc123',
      }),
      ...Object.values(
        draftNotes({
          appName: 'Editor',
          windowTitle: 'notes.txt',
          redactions: [{ count: 2 }],
          passwordFieldsSkipped: 1,
        }),
      ),
      draftNotes({
        appName: '',
        windowTitle: 'notes.txt',
        redactions: [],
        passwordFieldsSkipped: 0,
      }).source,
    ];
  };
  // Fixture data, key names typed as Electron accelerators, and code the user types.
  const DATA = [
    'Plan the trip',
    'waiting on Pat',
    'Ctrl+Alt+N',
    'Ctrl+Alt+A',
    'Control+Alt+Nope',
    'Control+Alt+Delete',
    'Control+Alt+N',
    'Hyper',
    'Nope',
    'notes.txt',
    'Editor',
    'timeout',
    '--user',
    'abc123',
    // The invalid shortcut's key, as the user typed it.
    'X',
  ];

  it('writes no English of its own in en-XA', () => {
    setLocale('en-XA');
    expectLocalized(words(), DATA);
  });

  it('writes no English of its own in ar-XB', () => {
    setLocale('ar-XB');
    expectLocalized(words(), DATA);
  });

  it('keeps English unchanged', () => {
    expect(statusSummary([item(), item({ status: 'blocked' })])).toBe(
      'Nova: 1 needs input, 1 blocked',
    );
    expect(statusSummary([item(), item()])).toBe('Nova: 2 need input');
    expect(statusSummary([])).toBe('Nova');
    expect(statusMenuLabel(item())).toBe('Needs input: Plan the trip (Chat)');
    expect(quickRows([item({ reason: 'waiting' })])[0]?.label).toBe(
      'Needs input: Plan the trip, waiting',
    );
    expect(
      draftNotes({
        appName: '',
        windowTitle: 'x',
        redactions: [{ count: 1 }],
        passwordFieldsSkipped: 2,
      }),
    ).toEqual({
      source: 'From the window "x"',
      redactions: '1 secret was masked before attaching. 2 password fields were left out.',
    });
  });
});
