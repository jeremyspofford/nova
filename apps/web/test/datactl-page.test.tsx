// Settings → Data (FR-105; docs/12 §9; J10 step 3): what the Hub holds; the export (with and
// without a passphrase, through the one-use ticket); delete-all (exactly what goes, the Hub's name
// typed, refusals kept in the dialog, then the restart); the import into an empty Hub (upload,
// check, passphrase, what must be entered again, the confirmation, the restart) and its
// refusals; the member's owner-only notice.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DataPage } from '../src/datactl/DataPage.tsx';
import { startDownload } from '../src/datactl/download.ts';
import {
  plainArchive,
  renderWithDatactl,
  sealedArchive,
  type M8DatactlState,
} from './fakes-m8-datactl.ts';
import { resetDom } from './render.tsx';

vi.mock('../src/datactl/download.ts', () => ({ startDownload: vi.fn() }));

afterEach(() => resetDom());
beforeEach(() => vi.mocked(startDownload).mockClear());

const region = (name: string) => screen.getByRole('region', { name });
const reload = vi.fn();
const restart = { delayMs: 0, intervalMs: 0, tries: 3, reload };

async function page(opts: Parameters<typeof renderWithDatactl>[1] = {}) {
  reload.mockClear();
  const r = await renderWithDatactl(<DataPage restart={restart} />, opts);
  await screen.findByRole('region', { name: 'What this Hub holds' });
  await within(region('What this Hub holds')).findByText('nova-hub');
  return r;
}

const emptyHub = (): Partial<M8DatactlState> => ({
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
});

async function upload(name: string, body = 'archive-bytes') {
  const input = screen.getByLabelText<HTMLInputElement>('Choose an export file');
  await userEvent.upload(input, new File([body], name, { type: 'application/octet-stream' }));
}

describe('what the Hub holds and the export', () => {
  it('shows the overview and exports without a passphrase through a one-use ticket', async () => {
    const { api } = await page();
    const stats = region('What this Hub holds');
    expect(within(stats).getByText('12,345')).toBeTruthy();
    expect(within(stats).getByText('30 MB')).toBeTruthy();
    expect(screen.getByText(/Nova never uses your data to train models/)).toBeTruthy();
    const exp = region('Export');
    expect(exp.textContent).toContain('stored keys and passwords are left out');
    expect(exp.textContent).toContain('This Hub holds 4 stored keys and passwords.');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(api.createExportTicket).toHaveBeenCalledWith(undefined, undefined);
    await waitFor(() =>
      expect(startDownload).toHaveBeenCalledWith(
        '/api/v1/data/export/download?ticket=ticket-1-abcdefghijklmnopqrstuvwxyz',
      ),
    );
    expect(within(exp).getByRole('status').textContent).toContain('Your download has started.');
  });

  it('checks the passphrase before sealing the export with it', async () => {
    const { api } = await page();
    const exp = region('Export');
    await userEvent.type(within(exp).getByLabelText('Passphrase (optional)'), 'short');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(within(exp).getByText('Use at least 12 characters.')).toBeTruthy();
    await userEvent.type(within(exp).getByLabelText('Passphrase (optional)'), ' but longer now');
    await userEvent.type(within(exp).getByLabelText('Repeat the passphrase'), 'something else');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(within(exp).getByText('The two passphrases differ.')).toBeTruthy();
    expect(api.createExportTicket).not.toHaveBeenCalled();
    await userEvent.clear(within(exp).getByLabelText('Repeat the passphrase'));
    await userEvent.type(
      within(exp).getByLabelText('Repeat the passphrase'),
      'short but longer now',
    );
    // A sealed export carries every stored key: the Hub's name is typed first.
    const name = within(exp).getByLabelText("Type the Hub's name, nova-hub, to confirm");
    expect(exp.textContent).toContain('carries every stored key and password on this Hub');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(
      within(exp).getByText("That is not this Hub's name. Type it exactly as shown."),
    ).toBeTruthy();
    expect(api.createExportTicket).not.toHaveBeenCalled();
    await userEvent.type(name, ' NOVA-hub ');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(api.createExportTicket).toHaveBeenCalledWith('short but longer now', 'NOVA-hub');
    await waitFor(() => expect(startDownload).toHaveBeenCalled());
    expect(within(exp).getByLabelText<HTMLInputElement>('Passphrase (optional)').value).toBe('');
    expect(within(exp).queryByLabelText(/Type the Hub's name/)).toBeNull();
  });

  it('says why the Hub refused a sealed export: a paired device, or a name that changed', async () => {
    const { api, state } = await page({ datactl: { deviceSession: true } });
    const exp = region('Export');
    await userEvent.type(within(exp).getByLabelText('Passphrase (optional)'), 'a long passphrase');
    await userEvent.type(within(exp).getByLabelText('Repeat the passphrase'), 'a long passphrase');
    await userEvent.type(within(exp).getByLabelText(/Type the Hub's name/), 'nova-hub');
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect((await within(exp).findByRole('alert')).textContent).toBe(
      'An export with a passphrase carries every stored key and password, so it can only be started from a browser signed in to the Hub, not from a paired device.',
    );
    expect(api.createExportTicket).toHaveBeenCalledWith('a long passphrase', 'nova-hub');
    expect(startDownload).not.toHaveBeenCalled();

    // The Hub was renamed meanwhile: its refusal sits at the name field.
    state.deviceSession = false;
    state.overview = { ...state.overview, hubName: 'renamed-hub' };
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(
      await within(exp).findByText("That is not this Hub's name. Type it exactly as shown."),
    ).toBeTruthy();
    // Only the field's error is left: the earlier refusal went away.
    expect(
      within(exp)
        .getAllByRole('alert')
        .map((a) => a.textContent),
    ).toEqual(["That is not this Hub's name. Type it exactly as shown."]);
    expect(startDownload).not.toHaveBeenCalled();

    // Without a passphrase nothing is confirmed, from anywhere.
    state.deviceSession = true;
    await userEvent.clear(within(exp).getByLabelText('Passphrase (optional)'));
    await userEvent.click(within(exp).getByRole('button', { name: 'Export' }));
    expect(api.createExportTicket).toHaveBeenLastCalledWith(undefined, undefined);
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
  });

  it('says why an export could not start', async () => {
    await page({
      prepare: (m) =>
        m.createExportTicket.mockRejectedValueOnce(
          new ApiError(409, {
            code: 'conflict',
            message: 'busy',
            retryable: false,
            details: { reason: 'busy' },
          }),
        ),
    });
    await userEvent.click(within(region('Export')).getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Another export, import or deletion is running. Try again when it finishes.',
    );
    expect(startDownload).not.toHaveBeenCalled();
  });
});

describe('delete all', () => {
  it('says exactly what goes, needs the name typed, then restarts and reloads', async () => {
    const { api, hub } = await page();
    await userEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete everything on this Hub?' });
    expect(dialog.textContent).toContain(
      'That is 12,345 rows in 180 tables, 40 files (30 MB) and 4 stored keys and passwords.',
    );
    expect(dialog.textContent).toContain('Your owner account and this browser’s session stay');
    expect(dialog.textContent).toContain('This cannot be undone.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const go = within(dialog).getByRole('button', { name: 'Delete everything and restart' });
    expect(go.hasAttribute('disabled')).toBe(true);
    const name = within(dialog).getByLabelText("Type the Hub's name, nova-hub, to confirm");
    await userEvent.type(name, 'nova');
    expect(go.hasAttribute('disabled')).toBe(true);
    await userEvent.type(name, '-HUB ');
    expect(go.hasAttribute('disabled')).toBe(false);
    await userEvent.click(go);
    expect(api.deleteAllData).toHaveBeenCalledWith('nova-HUB');
    expect(await screen.findByText('Everything was deleted.')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Everything was deleted.' }),
    );
    expect(
      screen.getByText(
        'Deleted 12,345 rows in 180 tables, 40 files and 4 stored keys and passwords.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/The Hub is restarting/)).toBeTruthy();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(hub.api.hello).toHaveBeenCalled();
  });

  it('changes nothing on Cancel, and keeps a refusal in the dialog', async () => {
    const { api, state } = await page();
    await userEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    let dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.deleteAllData).not.toHaveBeenCalled();

    state.busy = true;
    await userEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    dialog = screen.getByRole('dialog');
    // The field starts empty again.
    const name = within(dialog).getByLabelText<HTMLInputElement>(/Type the Hub's name/);
    expect(name.value).toBe('');
    await userEvent.type(name, 'nova-hub');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete everything and restart' }),
    );
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another export, import or deletion is running. Try again when it finishes.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();

    // The Hub's name changed meanwhile: its refusal in words.
    state.busy = false;
    state.overview = { ...state.overview, hubName: 'other-hub' };
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete everything and restart' }),
    );
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "That is not this Hub's name. Type it exactly as shown.",
    );
  });

  it('offers a reload when the Hub does not come back', async () => {
    const { hub } = await page();
    hub.api.hello.mockRejectedValue(new TypeError('Failed to fetch'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Type the Hub's name/), 'nova-hub');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete everything and restart' }),
    );
    expect(
      await screen.findByText('The Hub has not come back yet. Reload this page in a moment.'),
    ).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('import', () => {
  it('checks a file on a Hub that holds data, says what must be entered again, and refuses the import', async () => {
    const { api } = await page();
    const imp = region('Import');
    expect(imp.textContent).toContain('This Hub already holds data, so it cannot take an import.');
    await upload('nova-2026-10-10.novaexport');
    expect(api.uploadImport).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.checkImport).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000001',
        undefined,
      ),
    );
    expect(await within(imp).findByText('What the file holds')).toBeTruthy();
    expect(within(imp).getByText('940 in 2 tables')).toBeTruthy();
    expect(within(imp).getByText('12 (5 MB)')).toBeTruthy();
    expect(within(imp).getByText('Model provider API keys: 2')).toBeTruthy();
    expect(within(imp).getByText('MCP server credentials: 1')).toBeTruthy();
    expect(within(imp).getByText(/Table trust_ca:/)).toBeTruthy();
    expect(within(imp).queryByText(/Secret secret:/)).toBeNull();
    expect(within(imp).getByRole('button', { name: 'Import…' }).hasAttribute('disabled')).toBe(
      true,
    );

    await userEvent.click(within(imp).getByRole('button', { name: 'Choose another file' }));
    expect(api.removeImportUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(within(imp).getByLabelText('Choose an export file')).toBeTruthy();
  });

  it('imports a sealed export into an empty Hub after its passphrase and a confirmation', async () => {
    const { api } = await page({
      datactl: {
        ...emptyHub(),
        archives: { 'sealed.novaexport': sealedArchive('correct horse battery') },
      },
    });
    const imp = region('Import');
    expect(imp.textContent).not.toContain('already holds data');
    await upload('sealed.novaexport');
    expect(
      await within(imp).findByText('This export is encrypted. Enter its passphrase to check it.'),
    ).toBeTruthy();
    expect(api.checkImport).not.toHaveBeenCalled();
    await userEvent.type(within(imp).getByLabelText('Passphrase'), 'wrong one');
    await userEvent.click(within(imp).getByRole('button', { name: 'Check the file' }));
    expect((await within(imp).findByRole('alert')).textContent).toBe(
      'The passphrase is wrong, or the file was changed after it was exported.',
    );
    await userEvent.clear(within(imp).getByLabelText('Passphrase'));
    await userEvent.type(within(imp).getByLabelText('Passphrase'), 'correct horse battery');
    await userEvent.click(within(imp).getByRole('button', { name: 'Check the file' }));
    expect(await within(imp).findByText('Stored keys and passwords included')).toBeTruthy();
    await userEvent.click(within(imp).getByRole('button', { name: 'Import…' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace this Hub with the export?' });
    expect(dialog.textContent).toContain('940 rows in 2 tables and 12 files (5 MB), exported');
    expect(dialog.textContent).toContain('3 stored keys and passwords come with it.');
    expect(dialog.textContent).not.toContain('paired devices must be added again');
    expect(dialog.textContent).toContain('hooks need trusting again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import and restart' }));
    expect(api.importData).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'correct horse battery',
    );
    expect(await screen.findByText('The import is done and verified.')).toBeTruthy();
    expect(screen.getByText(/Every table matched the file./)).toBeTruthy();
    expect(screen.getByText('Turned off until you turn them on again')).toBeTruthy();
    expect(
      screen.getByText('1 MCP server that runs as a program here was turned off.'),
    ).toBeTruthy();
    expect(screen.getByText('2 plugins were turned off.')).toBeTruthy();
    expect(screen.getByText('3 hooks need trusting again.')).toBeTruthy();
    expect(screen.getByText('1 other session was signed out.')).toBeTruthy();
    expect(screen.queryByText(/external agent program/)).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('says what an import without a passphrase leaves to enter again', async () => {
    const { api } = await page({ datactl: emptyHub() });
    await upload('plain.novaexport');
    const imp = region('Import');
    await within(imp).findByText('What the file holds');
    await userEvent.click(within(imp).getByRole('button', { name: 'Import…' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Model provider API keys: 2');
    expect(dialog.textContent).toContain('paired devices must be added again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import and restart' }));
    expect(api.importData).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', undefined);
    expect(await screen.findByText('The import is done and verified.')).toBeTruthy();
    expect(screen.getByText('You will enter these again')).toBeTruthy();
    expect(screen.getByText(/paired devices must be added again/)).toBeTruthy();
  });

  it('puts every refusal in words: damaged, newer, empty, and a Hub that filled up', async () => {
    const { api, state } = await page({
      datactl: {
        ...emptyHub(),
        archives: {
          'bad.novaexport': {
            ...plainArchive(),
            refuse: { reason: 'archive_damaged', message: 'the archive has no manifest' },
          },
          'newer.novaexport': {
            ...plainArchive(),
            refuse: { reason: 'newer_schema', message: 'newer' },
          },
        },
      },
    });
    const imp = region('Import');
    await upload('bad.novaexport');
    expect((await within(imp).findByRole('alert')).textContent).toBe(
      'The file is not a complete Nova export. It may be damaged or cut short.',
    );
    await userEvent.click(within(imp).getByRole('button', { name: 'Choose another file' }));
    await upload('newer.novaexport');
    expect((await within(imp).findByRole('alert')).textContent).toBe(
      'This export comes from a newer version of Nova. Update this Hub first.',
    );
    await userEvent.click(within(imp).getByRole('button', { name: 'Choose another file' }));
    await upload('empty.novaexport', '');
    expect((await within(imp).findByRole('alert')).textContent).toBe('The file is empty.');

    // Checked while empty, but something wrote to the Hub before the import.
    await upload('ok.novaexport');
    await within(imp).findByText('What the file holds');
    state.overview = { ...state.overview, empty: false, blockingTables: ['thread'] };
    await userEvent.click(within(imp).getByRole('button', { name: 'Import…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import and restart' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This Hub already holds data. Delete all data first, then import.',
    );
    expect(api.importData).toHaveBeenCalledTimes(1);
  });

  it('puts the vetting refusals in words: unsafe paths, a full disk, secrets it may not name', async () => {
    const { api } = await page({
      datactl: {
        ...emptyHub(),
        archives: {
          'paths.novaexport': {
            ...plainArchive(),
            refuse: {
              reason: 'unsafe_path',
              message: 'the archive puts a plugin outside the plugins folder',
            },
          },
          'big.novaexport': {
            ...plainArchive(),
            refuse: {
              reason: 'disk_full',
              message: 'not enough free disk space to import: 900 MiB needed, 12 MiB free',
            },
          },
          'refs.novaexport': {
            ...plainArchive(),
            refuseImport: {
              reason: 'foreign_secret',
              message: 'the archive names a secret this Hub holds and the archive does not carry',
            },
          },
        },
      },
    });
    const imp = region('Import');
    await upload('paths.novaexport');
    expect((await within(imp).findByRole('alert')).textContent).toBe(
      'The file names a folder or file outside where Nova keeps its data, so it was refused. Nothing was imported.',
    );
    await userEvent.click(within(imp).getByRole('button', { name: 'Choose another file' }));
    await upload('big.novaexport');
    expect((await within(imp).findByRole('alert')).textContent).toBe(
      'There is not enough free disk space on the Hub to import this file. Free some space and try again.',
    );
    await userEvent.click(within(imp).getByRole('button', { name: 'Choose another file' }));

    // Checked clean, refused while applying: the refusal stays in the dialog, nothing changed.
    await upload('refs.novaexport');
    await within(imp).findByText('What the file holds');
    await userEvent.click(within(imp).getByRole('button', { name: 'Import…' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace this Hub with the export?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import and restart' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The file points to stored keys or passwords that it does not carry or that belong to a Hub itself, so it was refused. Nothing was imported.',
    );
    expect(api.importData).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('The import is done and verified.')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a member', () => {
  it('sees the owner-only notice and no data controls', async () => {
    await renderWithDatactl(<DataPage restart={restart} />, { as: 'member' });
    expect(await screen.findByText('Only the owner of this Hub can change this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete all data…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('gets the refusal in words if the Hub refuses the overview', async () => {
    await renderWithDatactl(<DataPage restart={restart} />, {
      prepare: (m) =>
        m.getDataOverview.mockRejectedValueOnce(
          new ApiError(403, {
            code: 'policy_denied',
            message: 'owner only',
            retryable: false,
            details: { reason: 'owner_only' },
          }),
        ),
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Only the owner of this Hub can manage its data.',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
