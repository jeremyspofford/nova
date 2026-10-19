// Settings → Data: how long data is kept (FR-105: per item, the audit floor, keeping less asks
// first, a sweep says what it deletes; managed policy locks with its source) and crash reports
// (FR-121: local reports, the exact preview, sending only when turned on with an endpoint, the
// endpoint's refusal, delete).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CrashReportsSection } from '../src/datactl/CrashReportsSection.tsx';
import { RetentionSection } from '../src/datactl/RetentionSection.tsx';
import { crashReport, renderWithDatactl } from './fakes-m8-datactl.ts';
import { lockPolicy } from './fakes-m8-managed.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const select = (label: string) => screen.getByLabelText<HTMLSelectElement>(label);
const optionLabels = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);

describe('retention', () => {
  it('keeps less only after a confirmation, keeps more at once, and never offers less than the audit floor', async () => {
    const { hub, api } = await renderWithDatactl(<RetentionSection />, {
      datactl: { due: { threads: 5, runs: 0, audit: 0, artifacts: 0, traces: 0 } },
    });
    await screen.findByLabelText('Chats');
    expect(select('Chats').value).toBe('forever');
    expect(optionLabels(select('Audit log'))).toEqual(['Forever', '1 year', '2 years', '5 years']);
    expect(optionLabels(select('Chats'))).toContain('30 days');
    expect(screen.getByText(/Audit entries are kept at least 365 days/)).toBeTruthy();

    await userEvent.selectOptions(select('Chats'), '30');
    const dialog = screen.getByRole('dialog', { name: 'Keep chats for 30 days?' });
    expect(dialog.textContent).toContain(
      'Chats untouched for more than 30 days are deleted at the next daily sweep.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(hub.state.settings['retention.threadsDays']).toBeUndefined();

    await userEvent.selectOptions(select('Chats'), '30');
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep less' }),
    );
    await waitFor(() => expect(hub.state.settings['retention.threadsDays']).toBe(30));
    expect(await screen.findByText('Chats: 5 due now.')).toBeTruthy();
    expect(api.getRetention.mock.calls.length).toBeGreaterThan(1);

    // Keeping more needs no confirmation.
    await userEvent.selectOptions(select('Chats'), 'forever');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(hub.state.settings['retention.threadsDays']).toBeNull());
  });

  it('sweeps now after saying what it deletes', async () => {
    const { api } = await renderWithDatactl(<RetentionSection />, {
      settings: { 'retention.threadsDays': 30, 'retention.tracesDays': 7 },
      datactl: { due: { threads: 5, runs: 0, audit: 0, artifacts: 0, traces: 2 } },
    });
    expect(await screen.findByText('No sweep has run yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sweep now…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete what is past its time now?' });
    expect(dialog.textContent).toContain('This deletes now: Chats: 5, Activity history: 2.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sweep now' }));
    expect(api.sweepRetention).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Sweep finished. Deleted: Chats: 5, Activity history: 2.'),
    ).toBeTruthy();
    expect(await screen.findByText(/run by hand\. Deleted: Chats: 5/)).toBeTruthy();
  });

  it('locks an item managed policy sets, naming its source', async () => {
    const view = lockPolicy({
      settings: [{ key: 'retention.auditDays', value: 400, channel: 'local', derivedFrom: null }],
    });
    await renderWithDatactl(<RetentionSection />, { managed: { view } });
    const audit = await screen.findByLabelText<HTMLSelectElement>('Audit log');
    expect(audit.disabled).toBe(true);
    expect(audit.value).toBe('400');
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(await screen.findByText('(policy file)')).toBeTruthy();
    expect(select('Chats').disabled).toBe(false);
  });
});

describe('crash reports', () => {
  it('lists reports and previews exactly what would be sent, which is nothing while off', async () => {
    const { state, api } = await renderWithDatactl(<CrashReportsSection />);
    expect(await screen.findByText('Uncaught error')).toBeTruthy();
    expect(screen.getByText('Not sent')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Send crash reports' }).getAttribute('aria-checked'),
    ).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Crash report' });
    const body = await within(dialog).findByLabelText('Crash report');
    expect(body.textContent).toBe(state.crash[0]!.body);
    expect(dialog.textContent).toContain('Not sent: crash reports are off.');
    expect(
      within(dialog).getByRole('button', { name: 'Send this report' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(api.sendCrashReport).not.toHaveBeenCalled();
  });

  it('turns sending on after saying where reports go, checks the endpoint, then sends from the preview', async () => {
    const { hub, api } = await renderWithDatactl(<CrashReportsSection />);
    await screen.findByText('Uncaught error');
    await userEvent.click(screen.getByRole('switch', { name: 'Send crash reports' }));
    let dialog = screen.getByRole('dialog', { name: 'Send crash reports?' });
    expect(dialog.textContent).toContain(
      'No endpoint is set yet: nothing is sent until you set one.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send crash reports' }));
    await waitFor(() => expect(hub.state.settings['privacy.crashReports']).toBe(true));

    const field = screen.getByLabelText('Endpoint');
    await userEvent.type(field, 'http://crash.example.com/r');
    await userEvent.click(screen.getByRole('button', { name: 'Save endpoint' }));
    expect(screen.getByText(/Enter an https:\/\/ address/)).toBeTruthy();
    expect(hub.state.settings['privacy.crashReportEndpoint']).toBeUndefined();
    await userEvent.clear(field);
    await userEvent.type(field, 'https://crash.example.com/r');
    await userEvent.click(screen.getByRole('button', { name: 'Save endpoint' }));
    await waitFor(() =>
      expect(hub.state.settings['privacy.crashReportEndpoint']).toBe('https://crash.example.com/r'),
    );

    // Preview, then send exactly that.
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    dialog = screen.getByRole('dialog', { name: 'Crash report' });
    expect(await within(dialog).findByText('https://crash.example.com/r')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send this report' }));
    expect(api.sendCrashReport).toHaveBeenCalledWith('crash-1');
    expect(await within(dialog).findByText('The report was sent.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/^Sent /)).toBeTruthy();
  });

  it("keeps the endpoint's refusal in the preview", async () => {
    await renderWithDatactl(<CrashReportsSection />, {
      settings: {
        'privacy.crashReports': true,
        'privacy.crashReportEndpoint': 'https://crash.example.com/r',
      },
      datactl: { endpointStatus: 502 },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Crash report' });
    await within(dialog).findByText('https://crash.example.com/r');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send this report' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The endpoint did not take the report.',
    );
  });

  it('deletes one report or all of them after asking', async () => {
    const { api } = await renderWithDatactl(<CrashReportsSection />, {
      datactl: {
        crash: [
          crashReport('crash-1'),
          crashReport('crash-2', { errorName: 'RangeError', kind: 'unhandledRejection' }),
        ],
      },
    });
    await screen.findByText('Unhandled promise rejection');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    let dialog = screen.getByRole('dialog', { name: 'Delete this crash report?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(api.deleteCrashReport).toHaveBeenCalledWith('crash-1');
    await waitFor(() => expect(screen.queryByText('Uncaught error')).toBeNull());

    api.listCrashReports.mockResolvedValueOnce({
      items: [crashReport('crash-2').report, crashReport('crash-3').report],
      enabled: false,
      endpoint: null,
    });
    // A settings change about crash reports reloads the list.
    await userEvent.click(screen.getByRole('switch', { name: 'Send crash reports' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Send crash reports' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all reports…' }));
    dialog = screen.getByRole('dialog', { name: 'Delete every crash report?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(api.deleteAllCrashReports).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        'No crash reports. The Hub has not crashed, or the reports were deleted.',
      ),
    ).toBeTruthy();
  });

  it('locks sending and the endpoint when managed policy sets them', async () => {
    const view = lockPolicy({
      settings: [
        { key: 'privacy.crashReports', value: false, channel: 'local', derivedFrom: null },
        { key: 'privacy.crashReportEndpoint', value: '', channel: 'local', derivedFrom: null },
      ],
    });
    await renderWithDatactl(<CrashReportsSection />, { managed: { view } });
    const sw = await screen.findByRole('switch', { name: 'Send crash reports' });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Endpoint').disabled).toBe(true);
    expect(screen.getAllByText('Managed by your organization')).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText('(policy file)')).toHaveLength(2));
  });
});
