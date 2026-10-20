// Data controls, spend caps and provider limits in the pseudo-locale (FR-016): every word of
// Settings → Data (what the Hub holds, export, import and its check, delete-all, retention and
// sweeps, crash reports and their preview, the restart), the spend caps and their editor, provider
// limits, and the cap-reached link comes from messages. The Hub's name, table and file names,
// provider account labels, report bodies and the Hub's own reasons are data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { CapReachedAction } from '../src/datactl/CapReached.tsx';
import { CrashReportsSection } from '../src/datactl/CrashReportsSection.tsx';
import { DataPage } from '../src/datactl/DataPage.tsx';
import { startDownload } from '../src/datactl/download.ts';
import { ProviderLimitsSection } from '../src/datactl/ProviderLimits.tsx';
import { RetentionSection } from '../src/datactl/RetentionSection.tsx';
import { SpendCapsSection } from '../src/datactl/SpendCaps.tsx';
import {
  DATA_STRINGS,
  DATA_TEXT,
  RETENTION_TEXT,
  SPEND_STRINGS,
  capRulesText,
  formatUsd,
  parseCapDraft,
  retentionConfirmText,
  sweepCounts,
} from '../src/datactl/format.ts';
import { PROVIDER_NAMES } from '../src/providers/names.ts';
import { cap, crashReport, plainArchive, renderWithDatactl } from './fakes-m8-datactl.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  resetTestLocale,
  unlocalizedResidue,
} from './i18n.ts';
import { resetDom } from './render.tsx';

vi.mock('../src/datactl/download.ts', () => ({ startDownload: vi.fn() }));

beforeEach(() => vi.mocked(startDownload).mockClear());
afterEach(() => {
  resetDom();
  resetTestLocale();
});

/** Fails on any word in `text` that is not pseudo-localized. */
function expectLocalizedText(text: string, data: readonly string[] = []) {
  expect(unlocalizedResidue(text, data), text).not.toMatch(/[A-Za-z]/);
}

/** The fixture Hub's name and provider account labels. */
const DATA = ['nova-hub', 'Work Anthropic', 'Desk Ollama'];
const restart = { delayMs: 0, intervalMs: 0, tries: 1, reload: vi.fn() };

describe('Settings → Data in en-XA', () => {
  it('shows what the Hub holds, the export, the import, retention, crash reports and delete-all', async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(<DataPage restart={restart} />, {
      datactl: {
        crash: [
          crashReport('crash-1'),
          crashReport('crash-2', {
            kind: 'unhandledRejection',
            sentAt: '2026-10-14T09:00:00.000Z',
          }),
          crashReport('crash-3', { lastError: 'connect ECONNREFUSED' }),
        ],
        lastSweep: {
          id: 'sweep-1',
          skipped: {},
          startedAt: '2026-10-14T03:00:00.000Z',
          finishedAt: '2026-10-14T03:00:01.000Z',
          trigger: 'manual',
          removed: { threads: 2, traces: 5 },
          error: null,
        },
      },
    });
    await screen.findByRole('region', { name: DATA_STRINGS.overviewTitle });
    await screen.findByText('nova-hub');
    await screen.findByRole('region', { name: DATA_STRINGS.retentionTitle });
    await screen.findAllByText('TypeError', { exact: false });
    expectFullyLocalized(document.body, {
      data: [...DATA, 'TypeError', 'connect ECONNREFUSED'],
    });

    // The passphrase fields of a sealed export, and the delete-all confirmation.
    await userEvent.type(screen.getByLabelText(DATA_STRINGS.passphrase), 'a passphrase!');
    expectFullyLocalized(document.body, {
      data: [...DATA, 'TypeError', 'connect ECONNREFUSED'],
    });
    await userEvent.click(screen.getByRole('button', { name: DATA_STRINGS.deleteButton }));
    const dialog = screen.getByRole('dialog', { name: DATA_STRINGS.deleteConfirmTitle });
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('checks an uploaded file and asks before importing it', async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(<DataPage restart={restart} />, {
      datactl: {
        overview: {
          hubName: 'nova-hub',
          hubVersion: '0.8.0',
          schemaVersion: 51,
          tables: 180,
          rows: 3,
          files: { count: 0, bytes: 0 },
          secrets: { count: 0 },
          empty: true,
          blockingTables: [],
        },
        archives: { 'hub.novaexport': plainArchive() },
      },
    });
    const input = await screen.findByLabelText<HTMLInputElement>(DATA_STRINGS.importChoose);
    await userEvent.upload(
      input,
      new File(['archive-bytes'], 'hub.novaexport', { type: 'application/octet-stream' }),
    );
    await screen.findByText(DATA_STRINGS.checkTitle);
    const reason = "the Hub's own keys travel only in an archive sealed with a passphrase";
    // `trust_ca` is a table's name; TypeError the crash report's error name.
    expectFullyLocalized(document.body, {
      data: [...DATA, 'hub.novaexport', 'trust_ca', 'TypeError', reason],
    });
    await userEvent.click(screen.getByRole('button', { name: DATA_STRINGS.importButton }));
    const dialog = screen.getByRole('dialog', { name: DATA_STRINGS.importConfirmTitle });
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('previews a crash report and asks before turning sending on', async () => {
    await activateTestLocale('en-XA');
    const { state } = await renderWithDatactl(<CrashReportsSection />, {
      settings: { 'privacy.crashReportEndpoint': 'https://crash.example.com/report' },
    });
    await screen.findByText(DATA_STRINGS.crashPreview);
    await userEvent.click(screen.getByRole('button', { name: DATA_STRINGS.crashPreview }));
    const preview = screen.getByRole('dialog', { name: DATA_STRINGS.crashPreviewTitle });
    await within(preview).findByText(DATA_STRINGS.crashWhyOff);
    // The report body is the exact JSON that would be sent.
    expectFullyLocalized(preview, { data: [state.crash[0]!.body] });
    await userEvent.click(within(preview).getByRole('button', { name: DATA_STRINGS.close }));
    await userEvent.click(screen.getByRole('switch', { name: DATA_STRINGS.crashSwitch }));
    const ask = screen.getByRole('dialog', { name: DATA_STRINGS.crashOnTitle });
    expectFullyLocalized(ask);
  });

  it('asks before keeping data less long', async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(<RetentionSection />, {
      datactl: { due: { threads: 5, runs: 0, audit: 0, artifacts: 0, traces: 2 } },
    });
    const chats = await screen.findByLabelText<HTMLSelectElement>(RETENTION_TEXT.threads.label);
    await userEvent.selectOptions(chats, '30');
    expectFullyLocalized(screen.getByRole('dialog'));
    expectLocalizedText(retentionConfirmText('threads', 1));
    expectLocalizedText(sweepCounts({ threads: 3, runs: 1 }) ?? '');
  });
});

describe('spend caps and provider limits in en-XA', () => {
  it('shows the caps, a cap being edited and the clear-usage section', async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(<SpendCapsSection />, {
      datactl: {
        caps: [cap('anthropic', 50, 45), cap('openai', 10, 12, { period: 'day', hardStop: false })],
      },
    });
    await screen.findByRole('region', { name: SPEND_STRINGS.title });
    const anthropicName = PROVIDER_NAMES.anthropic!;
    await screen.findByText(anthropicName);
    expectFullyLocalized(document.body, { data: DATA });
    const anthropic = screen.getByRole('group', { name: anthropicName });
    await userEvent.click(within(anthropic).getByRole('button', { name: SPEND_STRINGS.edit }));
    expectFullyLocalized(document.body, { data: DATA });
    const bad = parseCapDraft({ limit: '0', period: 'month', warnPercent: '80', hardStop: true });
    expect('error' in bad).toBe(true);
    if ('error' in bad) expectLocalizedText(bad.error);
  });

  it("shows each account's plan, limits and spend", async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(<ProviderLimitsSection />, {
      datactl: {
        limits: [
          {
            providerAccountId: 'pa1',
            provider: 'anthropic',
            label: 'Work Anthropic',
            active: true,
            local: false,
            entitlements: {
              plan: 'Team',
              limit: 1000,
              used: 250,
              resetAt: '2026-11-01T00:00:00.000Z',
            },
            lastReported: {
              code: 'rate_limited',
              message: 'slow down',
              at: '2026-10-15T11:00:00.000Z',
              retryAfterMs: 30_000,
            },
            spentThisMonthUsd: 12.5,
          },
          {
            providerAccountId: 'pa2',
            provider: 'ollama',
            label: 'Desk Ollama',
            active: true,
            local: true,
            entitlements: null,
            lastReported: null,
            spentThisMonthUsd: 0,
          },
        ],
        caps: [cap('anthropic', 50, 45)],
      },
    });
    await screen.findByText('Work Anthropic');
    // "Team" is the provider's plan name.
    expectFullyLocalized(document.body, { data: [...DATA, 'Team'] });
  });

  it('localizes the cap-reached link and the helper sentences', async () => {
    await activateTestLocale('en-XA');
    await renderWithDatactl(
      <CapReachedAction
        code="over_budget"
        message="capped"
        details={{ reason: 'spend_cap', provider: 'openai' }}
      />,
    );
    await screen.findByRole('link', { name: SPEND_STRINGS.raiseCap });
    expectFullyLocalized(document.body);
    expectLocalizedText(formatUsd(0.004));
    expectLocalizedText(capRulesText(cap('openai', 10, 2, { period: 'day' })));
    expectLocalizedText(
      DATA_TEXT.deleted({ rows: 1, tables: 2, files: 3, secrets: 1 }) +
        DATA_TEXT.restoredOff({
          mcpServers: 1,
          plugins: 2,
          agentAdapters: 1,
          hooks: 3,
          sessions: 1,
        }).join(' '),
    );
  });
});
