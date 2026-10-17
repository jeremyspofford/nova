import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { exampleField } from '../src/settings/CommandRules.tsx';
import { isAbsolutePath, profileSummary } from '../src/settings/PermissionsPage.tsx';
import { ruleSummary } from '../src/settings/PolicyRules.tsx';
import { lines, parsePattern, patternText } from '../src/settings/policy-text.ts';
import { createHub } from './fakes.ts';
import { BUILTIN_PROFILES, m3State } from './fakes-m3.ts';
import { commandRule, grant, policyRule, toolView } from './fakes-settings.ts';
import { project, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });
const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;

describe('permission helpers', () => {
  it('parses and prints command patterns, lines and paths', () => {
    expect(parsePattern(' git  status|diff  ')).toEqual({ pattern: ['git', ['status', 'diff']] });
    expect(parsePattern('   ')).toEqual({ error: 'Enter the words the command starts with.' });
    expect(parsePattern('git status|')).toEqual({ error: '“status|” has an empty alternative.' });
    expect(patternText(['rm', ['-r', '-rf']])).toBe('rm -r|-rf');
    expect(lines(' a \n\n b\n')).toEqual(['a', 'b']);
    expect(isAbsolutePath('/home/sam')).toBe(true);
    expect(isAbsolutePath('C:\\Users\\sam')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('notes')).toBe(false);
    expect(isAbsolutePath('~/notes')).toBe(false);
    expect(profileSummary(BUILTIN_PROFILES[1]!)).toBe('write project; no network.');
    expect(
      profileSummary({
        ...BUILTIN_PROFILES[1]!,
        fs: [],
        network: { mode: 'allowlist', allow: ['pypi.org'], deny: [] },
        requiresSubstrate: 'vm_or_container',
      }),
    ).toBe('no files; network: pypi.org; only inside a VM or container.');
    expect(ruleSummary({ match: {} })).toBe('every action');
    expect(
      ruleSummary({ match: { tool: 'email.send', effects: ['external_communication'] } }),
    ).toBe('tool email.send · sends messages to others');
  });

  it('finds which examples field a Hub validation error names', () => {
    const v = (message: string, details?: Record<string, unknown>) =>
      new ApiError(400, { code: 'validation', message, retryable: false, details });
    expect(exampleField(v('x', { field: 'notMatchExamples' }))).toBe('notMatchExamples');
    expect(exampleField(v('Match example "git x" does not match'))).toBe('matchExamples');
    expect(exampleField(v('Not-match example "git push" matches'))).toBe('notMatchExamples');
    expect(exampleField(v('pattern is empty'))).toBeNull();
    expect(exampleField(fail('Match example'))).toBeNull();
    expect(exampleField(new Error('x'))).toBeNull();
  });
});

describe('Settings → Permissions: folders, profile and policy (FR-190)', () => {
  it('adds, changes and removes folders, and rejects a relative or repeated path', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/permissions' });
    expect(
      await screen.findByText(
        /Hub’s own workspace folder is always included|Hub's own workspace folder is always included/,
      ),
    ).toBeTruthy();
    const path = screen.getByRole('textbox', { name: 'Folder path' });
    await userEvent.type(path, 'notes');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText(/Enter a full path on the Hub/)).toBeTruthy();
    await userEvent.clear(path);
    await userEvent.type(path, '/home/sam/notes');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Access' }), 'write');
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Notes');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() =>
      expect(hub.state.settings['tools.roots']).toEqual([
        { path: '/home/sam/notes', access: 'write', label: 'Notes' },
      ]),
    );
    expect(await screen.findByText('/home/sam/notes added.')).toBeTruthy();
    expect((path as HTMLInputElement).value).toBe('');

    await userEvent.type(path, '/home/sam/notes');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText('This folder is already listed.')).toBeTruthy();

    const row = screen.getByRole('listitem', { name: 'Notes' });
    await userEvent.selectOptions(
      within(row).getByRole('combobox', { name: 'Access to /home/sam/notes' }),
      'read',
    );
    await waitFor(() =>
      expect(hub.state.settings['tools.roots']).toEqual([
        { path: '/home/sam/notes', access: 'read', label: 'Notes' },
      ]),
    );
    hub.state.failNext.setSetting = fail('Disk full');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove /home/sam/notes' }));
    expect(await screen.findByText('Could not save the folders: Disk full')).toBeTruthy();
    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'Notes' })).getByRole('button', {
        name: 'Remove /home/sam/notes',
      }),
    );
    await waitFor(() => expect(hub.state.settings['tools.roots']).toEqual([]));
    expect(screen.getByText(/No extra folders/)).toBeTruthy();
  });

  it('picks the permission profile and approval policy', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/permissions' });
    const workspace = await screen.findByRole<HTMLInputElement>('radio', { name: 'workspace' });
    expect(workspace.checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'read-only' }));
    await waitFor(() => expect(hub.state.settings['tools.permissionProfile']).toBe('read-only'));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Use tool defaults' }).checked).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Ask every time' }));
    await waitFor(() => expect(hub.state.settings['tools.approvalPolicy']).toBe('ask_always'));
  });

  it('shows managed folders, profile and policy as locked', async () => {
    const hub = createHub({
      managed: {
        'tools.roots': [{ path: '/srv/shared', access: 'read' }],
        'tools.permissionProfile': 'read-only',
        'tools.approvalPolicy': 'ask_always',
      },
    });
    hub.state.failNext.listProfiles = fail('Profiles unavailable');
    await renderApp({ hub, path: '/settings/permissions' });
    expect(await screen.findByText('Profiles unavailable')).toBeTruthy();
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).toBeNull();
    const row = screen.getByRole('listitem', { name: '/srv/shared' });
    expect(
      within(row).getByRole<HTMLButtonElement>('button', { name: 'Remove /srv/shared' }).disabled,
    ).toBe(true);
    // The current profile still shows while the list is unavailable.
    const ro = screen.getByRole<HTMLInputElement>('radio', { name: 'read-only' });
    expect(ro.checked).toBe(true);
    expect(ro.disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ask every time' }).disabled).toBe(
      true,
    );
  });
});

describe('Settings → Permissions: rules (FR-084 partial)', () => {
  it('lists, adds, edits, disables and deletes rules; managed rules are read-only', async () => {
    const p = project({ name: 'Billing' });
    const hub = createHub({
      workspace: workspaceState({ projects: [p] }),
      m3: m3State({
        rules: [
          policyRule({ id: 'r1', label: 'Ask before writing', match: { tool: 'fs.write' } }),
          policyRule({
            id: 'r2',
            label: 'No purchases',
            effect: 'deny',
            source: 'managed',
            match: { effects: ['purchase'] },
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/permissions' });
    const managed = await screen.findByRole('listitem', { name: 'No purchases' });
    expect(within(managed).getByText('Never take this action')).toBeTruthy();
    expect(within(managed).getByText('Managed by your organization')).toBeTruthy();
    expect(within(managed).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(
      within(managed).getByRole<HTMLButtonElement>('switch', { name: 'Use rule: No purchases' })
        .disabled,
    ).toBe(true);

    // Add: a rule must match something.
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    let dialog = screen.getByRole('dialog', { name: 'Add a rule' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(within(dialog).getByText(/so the rule matches something/)).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Hand off email');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Hand off to you' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Tool' }), 'email.send');
    await userEvent.click(within(dialog).getByText('Kinds of action'));
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Sends messages to others' }),
    );
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Applies to' }),
      'project',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(within(dialog).getByText('Choose a project.')).toBeTruthy();
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Project' }), p.id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(hub.api.createPolicyRule).toHaveBeenCalledWith({
        scopeKind: 'project',
        scopeRef: p.id,
        match: { tool: 'email.send', effects: ['external_communication'] },
        effect: 'handoff',
        priority: 100,
        label: 'Hand off email',
      }),
    );
    expect(await screen.findByText('Rule added.')).toBeTruthy();
    const added = screen.getByRole('listitem', { name: 'Hand off email' });
    expect(within(added).getByText('Project: Billing')).toBeTruthy();

    // Edit the first rule's effect.
    const first = screen.getByRole('listitem', { name: 'Ask before writing' });
    await userEvent.click(within(first).getByRole('button', { name: 'Edit' }));
    dialog = screen.getByRole('dialog', { name: 'Edit rule' });
    await userEvent.click(
      within(dialog).getByRole('radio', { name: 'Take action without asking' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(hub.api.updatePolicyRule).toHaveBeenCalledWith('r1', {
        scopeKind: 'global',
        match: { tool: 'fs.write' },
        effect: 'allow',
        priority: 100,
        label: 'Ask before writing',
      }),
    );
    expect(await within(first).findByText('Take action without asking')).toBeTruthy();

    // Disable, with a failure first.
    hub.state.failNext.updatePolicyRule = fail('Locked');
    const sw = within(first).getByRole('switch', { name: 'Use rule: Ask before writing' });
    await userEvent.click(sw);
    expect(await screen.findByText('Could not change the rule: Locked')).toBeTruthy();
    await userEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));

    // Delete after confirming.
    await userEvent.click(within(first).getByRole('button', { name: 'Delete' }));
    dialog = screen.getByRole('dialog', { name: 'Delete this rule?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Rule deleted.')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Ask before writing' })).toBeNull();
  });

  it('reports a failed save in the rule form and a failed delete', async () => {
    const hub = createHub({ m3: m3State({ rules: [policyRule({ id: 'r1' })] }) });
    hub.state.failNext.listPolicyRules = fail('Policy store offline');
    await renderApp({ hub, path: '/settings/permissions' });
    const rules = section('Rules');
    expect(await within(rules).findByText('Policy store offline')).toBeTruthy();
    await userEvent.click(within(rules).getByRole('button', { name: 'Retry' }));
    const row = await within(rules).findByRole('listitem', { name: 'tool fs.write' });
    hub.state.failNext.createPolicyRule = fail('Rule limit reached');
    await userEvent.click(within(rules).getByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a rule' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Resource' }),
      '*.shop.example',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText('Rule limit reached')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    hub.state.failNext.deletePolicyRule = fail('Busy');
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this rule?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(await screen.findByText('Could not delete the rule: Busy')).toBeTruthy();
  });
});

describe('Settings → Permissions: command rules (FR-191)', () => {
  it('adds a rule, shows the failing example inline, and tests commands live', async () => {
    const hub = createHub({ m3: m3State({ commandRules: [commandRule({ id: 'c1' })] }) });
    await renderApp({ hub, path: '/settings/permissions' });
    const existing = await screen.findByRole('listitem', { name: 'git status|diff' });
    expect(within(existing).getByText('Run without asking')).toBeTruthy();
    expect(within(existing).getByText('Matches: git status')).toBeTruthy();
    expect(within(existing).getByText('Does not match: git push')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add command rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a command rule' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add command rule' }));
    expect(within(dialog).getByText('Enter the words the command starts with.')).toBeTruthy();
    expect(within(dialog).getByText(/at least one command this rule should match/)).toBeTruthy();
    expect(
      within(dialog).getByText(/at least one command this rule should not match/),
    ).toBeTruthy();

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Command starts with' }),
      'rm -r|-rf',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Never run' }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Why' }),
      'Use fs.delete instead.',
    );
    const should = within(dialog).getByRole('textbox', { name: 'Commands it should match' });
    const shouldNot = within(dialog).getByRole('textbox', { name: 'Commands it should not match' });
    await userEvent.type(should, 'rm -rf build{Enter}rm build');
    await userEvent.type(shouldNot, 'rmdir build');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add command rule' }));
    // The Hub rejects the example that does not match; the message sits under that field.
    const err = await within(dialog).findByText(
      'Match example "rm build" does not match the rule.',
    );
    expect(should.getAttribute('aria-invalid')).toBe('true');
    expect(should.getAttribute('aria-describedby')).toContain(err.id);
    await userEvent.clear(should);
    await userEvent.type(should, 'rm -rf build');
    expect(should.getAttribute('aria-invalid')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add command rule' }));
    await waitFor(() =>
      expect(hub.api.createCommandRule).toHaveBeenLastCalledWith({
        scopeKind: 'global',
        pattern: ['rm', ['-r', '-rf']],
        decision: 'deny',
        justification: 'Use fs.delete instead.',
        matchExamples: ['rm -rf build'],
        notMatchExamples: ['rmdir build'],
        priority: 100,
      }),
    );
    expect(await screen.findByText('Command rule added.')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'rm -r|-rf' })).toBeTruthy();

    // Test a command: debounced, asks the Hub.
    const tester = screen.getByRole('textbox', { name: 'Test a command' });
    await userEvent.type(tester, 'git diff --stat');
    expect(
      await screen.findByText(
        'Run without asking (rule git status|diff): Read-only Git inspection.',
      ),
    ).toBeTruthy();
    await userEvent.clear(tester);
    await userEvent.type(tester, 'ls -la');
    expect(await screen.findByText('No command rule matches. No rule matches')).toBeTruthy();
    hub.state.failNext.testCommandRules = fail('Parser crashed');
    await userEvent.type(tester, 'h');
    expect(await screen.findByText('Parser crashed')).toBeTruthy();
  });

  it('edits, disables and deletes a command rule; a not-match failure is shown on its field', async () => {
    const hub = createHub({
      m3: m3State({
        commandRules: [
          commandRule({ id: 'c1' }),
          commandRule({ id: 'c2', pattern: ['sudo'], decision: 'ask', source: 'managed' }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/permissions' });
    const managed = await screen.findByRole('listitem', { name: 'sudo' });
    expect(within(managed).queryByRole('button', { name: 'Edit' })).toBeNull();
    const row = screen.getByRole('listitem', { name: 'git status|diff' });
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit command rule' });
    const shouldNot = within(dialog).getByRole('textbox', { name: 'Commands it should not match' });
    await userEvent.type(shouldNot, '{Enter}git diff');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save command rule' }));
    expect(
      await within(dialog).findByText('Not-match example "git diff" matches the rule.'),
    ).toBeTruthy();
    expect(shouldNot.getAttribute('aria-invalid')).toBe('true');
    await userEvent.clear(shouldNot);
    await userEvent.type(shouldNot, 'git push');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Ask first' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save command rule' }));
    expect(await screen.findByText('Command rule saved.')).toBeTruthy();
    expect(within(row).getByText('Ask first')).toBeTruthy();

    const sw = within(row).getByRole('switch', { name: 'Use command rule: git status|diff' });
    await userEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    hub.state.failNext.deleteCommandRule = fail('Nope');
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this command rule?' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    expect(await screen.findByText('Could not delete the command rule: Nope')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this command rule?' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    expect(await screen.findByText('Command rule deleted.')).toBeTruthy();
    expect(hub.state.m3.commandRules.map((r) => r.id)).toEqual(['c2']);
  });
});

describe('Settings → Permissions: remembered approvals and preview (FR-100, FR-048)', () => {
  it('lists grants and revokes one, reporting a failure', async () => {
    const hub = createHub({
      m3: m3State({
        grants: [
          grant({ id: 'g1', label: 'Tool fs.write' }),
          grant({
            id: 'g2',
            label: 'Commands starting with npm test',
            duration: 'session',
            scopeKind: 'project',
            scopeRef: 'billing',
            expiresAt: '2026-10-02T12:00:00Z',
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/permissions' });
    const g1 = await screen.findByRole('listitem', { name: 'Tool fs.write' });
    expect(within(g1).getByText('Until you revoke it')).toBeTruthy();
    const g2 = screen.getByRole('listitem', { name: 'Commands starting with npm test' });
    expect(within(g2).getByText('For this session')).toBeTruthy();
    expect(within(g2).getByText('In this project (billing)')).toBeTruthy();
    expect(within(g2).getByText(/^Expires /)).toBeTruthy();

    hub.state.failNext.revokeGrant = fail('Already gone');
    await userEvent.click(within(g1).getByRole('button', { name: 'Revoke Tool fs.write' }));
    expect(await screen.findByText('Could not revoke Tool fs.write: Already gone')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Tool fs.write' })).toBeTruthy();
    await userEvent.click(within(g1).getByRole('button', { name: 'Revoke Tool fs.write' }));
    expect(
      await screen.findByText('Revoked: Tool fs.write. Nova asks again next time.'),
    ).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Tool fs.write' })).toBeNull();
    expect(hub.state.m3.grants.map((g) => g.id)).toEqual(['g2']);
  });

  it('shows an empty grants list and retries a failed load', async () => {
    const hub = createHub();
    hub.state.failNext.listGrants = fail('Grants offline');
    await renderApp({ hub, path: '/settings/permissions' });
    const grants = section('Remembered approvals');
    expect(await within(grants).findByText('Grants offline')).toBeTruthy();
    await userEvent.click(within(grants).getByRole('button', { name: 'Retry' }));
    expect(await within(grants).findByText('No remembered approvals')).toBeTruthy();
  });

  it('previews a decision without running anything', async () => {
    const hub = createHub({
      m3: m3State({
        tools: [
          toolView({
            name: 'fs.write',
            effective: {
              effect: 'ask',
              reason: 'Tool default for fs.write: ask.',
              tier: 'pre_approvable',
            },
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/permissions' });
    const preview = section('Preview a decision');
    const button = within(preview).getByRole<HTMLButtonElement>('button', { name: 'Preview' });
    expect(button.disabled).toBe(true);
    await userEvent.type(within(preview).getByRole('combobox', { name: 'Tool' }), 'fs.write');
    const args = within(preview).getByRole('textbox', { name: 'Arguments (JSON, optional)' });
    await userEvent.type(args, 'not json');
    await userEvent.click(button);
    expect(within(preview).getByText(/Arguments must be JSON/)).toBeTruthy();
    expect(hub.api.previewPolicy).not.toHaveBeenCalled();
    await userEvent.clear(args);
    await userEvent.type(args, '{{"path": "a.md"}');
    await userEvent.click(within(preview).getByRole('checkbox', { name: /As if you asked/ }));
    await userEvent.click(button);
    await waitFor(() =>
      expect(hub.api.previewPolicy).toHaveBeenCalledWith({
        tool: 'fs.write',
        userAsked: false,
        args: { path: 'a.md' },
      }),
    );
    const status = within(preview).getByRole('status');
    expect(await within(status).findByText('Tool default for fs.write: ask.')).toBeTruthy();
    expect(within(status).getByText('Asks first')).toBeTruthy();
    expect(within(status).getByText('Tier: Pre-approvable')).toBeTruthy();
    expect(within(status).getByText('Decided by: tool_default')).toBeTruthy();

    hub.state.failNext.previewPolicy = fail('Engine unavailable');
    await userEvent.click(button);
    expect(await within(preview).findByText('Engine unavailable')).toBeTruthy();
    expect(within(status).queryByText('Asks first')).toBeNull();
  });
});
