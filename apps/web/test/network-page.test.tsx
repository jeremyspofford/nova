// Settings → Network (FR-102, FR-193; docs/11 §7, docs/12 §8): the access level and host lists
// for every sandbox, checked as the Hub checks them (no bare *, wildcards only as the leftmost
// label); managed policy locks them; HTTPS inspection and its certificate; rules for one agent,
// run or session (hooks kept on save, removal confirmed); proxy credentials with write-only
// values; and the decision log (causes in words, filters, more, live, allow from a block).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { parseHostEntries } from '../src/network/HostListEditor.tsx';
import { NetworkPage } from '../src/network/NetworkPage.tsx';
import { effectiveMode, hookFromDraft } from '../src/network/ScopeRules.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  credentialView,
  decisionView,
  renderWithComputers,
  scopeView,
  type M6ComputersState,
} from './fakes-m6-computers.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const AGENTS = [
  { id: 'ag1', name: 'Research' },
  { id: 'ag2', name: 'Ops' },
];

/** The open event stream that listens for `name` (each view follows its own events). */
const stream = (name: string) => {
  const s = [...FakeEventSource.all]
    .reverse()
    .find((x) => !x.closed && x.url.includes('/events/stream') && x.listeners.has(name));
  if (!s) throw new Error(`no stream for ${name}`);
  return s;
};
const region = (name: string) => screen.getByRole('region', { name });

async function openNetwork(
  computers: Partial<M6ComputersState> = {},
  opts: Omit<Parameters<typeof renderWithComputers>[1], 'computers'> = {},
) {
  const r = await renderWithComputers(<NetworkPage />, {
    computers: { agents: AGENTS, ...computers },
    ...opts,
  });
  await screen.findByRole('heading', { name: 'Network', level: 2 });
  return r;
}

describe('host patterns (FR-193)', () => {
  it('accepts hosts, IPs and leftmost wildcards, normalized; refuses the rest', () => {
    expect(parseHostEntries('API.Example.com. , *.example.org 10.0.0.1', [])).toEqual({
      ok: true,
      hosts: ['api.example.com', '*.example.org', '10.0.0.1'],
    });
    expect(parseHostEntries('*', [])).toEqual({
      ok: false,
      error: 'A bare * is not allowed: name the hosts.',
    });
    expect(parseHostEntries('api.*.example.com', [])).toMatchObject({ ok: false });
    expect(parseHostEntries('*.com', [])).toEqual({
      ok: false,
      error: 'A wildcard cannot cover a whole top-level domain: *.com.',
    });
    expect(parseHostEntries('a.test', ['A.test'])).toEqual({
      ok: false,
      error: 'a.test is already in the list.',
    });
    expect(parseHostEntries('a.test a.test', [])).toMatchObject({ ok: false });
    expect(parseHostEntries('  ', [])).toMatchObject({ ok: false });
  });

  it('builds request rules the Hub accepts, or says what is wrong', () => {
    const base = {
      key: 'k',
      id: 'h1',
      action: 'strip_header' as const,
      host: 'API.github.com',
      header: 'Authorization',
      methods: 'post, put',
      pathPrefix: '/repos/',
    };
    expect(hookFromDraft(base)).toEqual({
      ok: true,
      hook: {
        id: 'h1',
        action: 'strip_header',
        host: 'api.github.com',
        header: 'Authorization',
        methods: ['POST', 'PUT'],
        pathPrefix: '/repos/',
      },
    });
    expect(hookFromDraft({ ...base, host: '*' })).toMatchObject({ ok: false });
    expect(hookFromDraft({ ...base, header: '' })).toMatchObject({ ok: false });
    expect(hookFromDraft({ ...base, pathPrefix: 'repos' })).toMatchObject({ ok: false });
    expect(hookFromDraft({ ...base, methods: 'P0ST' })).toMatchObject({ ok: false });
    expect(hookFromDraft({ ...base, action: 'block', header: '' })).toEqual({
      ok: true,
      hook: {
        id: 'h1',
        action: 'block',
        host: 'api.github.com',
        methods: ['POST', 'PUT'],
        pathPrefix: '/repos/',
      },
    });
  });

  it('a rule can only narrow the access for every sandbox', () => {
    expect(effectiveMode('limited', 'allowlist')).toBe('limited');
    expect(effectiveMode('allowlist', 'limited')).toBe('limited');
    expect(effectiveMode('allowlist', 'off')).toBe('off');
    expect(effectiveMode('off', 'allowlist')).toBe('off');
    expect(effectiveMode('limited', null)).toBe('limited');
  });
});

describe('access for every sandbox (FR-102, FR-193)', () => {
  it('changes the access level and edits the allowed and blocked hosts', async () => {
    const { hub } = await openNetwork();
    const access = region('Access for every sandbox');
    const allowlist = within(access).getByRole<HTMLInputElement>('radio', {
      name: 'Allowed hosts only',
    });
    expect(allowlist.checked).toBe(true);
    await userEvent.click(within(access).getByRole('radio', { name: 'Read-only' }));
    await waitFor(() => expect(hub.state.settings['network.egressMode']).toBe('limited'));

    const add = within(access).getByRole('textbox', { name: 'Add an allowed host' });
    await userEvent.type(add, 'API.Weather.test, *.cdn.test{Enter}');
    await waitFor(() =>
      expect(hub.state.settings['network.egressAllow']).toEqual(['api.weather.test', '*.cdn.test']),
    );
    expect((add as HTMLInputElement).value).toBe('');
    const allowed = within(access).getByRole('list', { name: 'Allowed hosts' });
    expect(
      within(allowed)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('code')?.textContent),
    ).toEqual(['api.weather.test', '*.cdn.test']);

    // Block one of them: blocking wins, and the allowed entry says so.
    await userEvent.type(
      within(access).getByRole('textbox', { name: 'Add a blocked host' }),
      '*.cdn.test',
    );
    await userEvent.click(within(access).getAllByRole('button', { name: 'Add' })[1]!);
    await waitFor(() => expect(hub.state.settings['network.egressDeny']).toEqual(['*.cdn.test']));
    expect(within(allowed).getByText('Also blocked: blocking wins')).toBeTruthy();

    await userEvent.click(
      within(allowed).getByRole('button', { name: 'Remove api.weather.test from allowed hosts' }),
    );
    await waitFor(() => expect(hub.state.settings['network.egressAllow']).toEqual(['*.cdn.test']));
  });

  it('refuses a bare * and a misplaced wildcard, keeping what was typed', async () => {
    const { hub } = await openNetwork();
    const access = region('Access for every sandbox');
    const add = within(access).getByRole('textbox', { name: 'Add an allowed host' });
    await userEvent.type(add, '*{Enter}');
    expect(within(access).getByRole('alert').textContent).toBe(
      'A bare * is not allowed: name the hosts.',
    );
    expect((add as HTMLInputElement).value).toBe('*');
    await userEvent.clear(add);
    await userEvent.type(add, 'api.*.test{Enter}');
    expect(within(access).getByRole('alert').textContent).toBe(
      'A wildcard is allowed only as the leftmost label: api.*.test.',
    );
    expect(hub.state.settings['network.egressAllow']).toBeUndefined();
  });

  it('keeps the typed host when the Hub refuses the save', async () => {
    const { hub } = await openNetwork();
    hub.state.failNext.setSetting = new ApiError(400, {
      code: 'validation',
      message: 'The Hub could not save it.',
      retryable: false,
    });
    const access = region('Access for every sandbox');
    const add = within(access).getByRole('textbox', { name: 'Add a blocked host' });
    await userEvent.type(add, 'tracker.test{Enter}');
    expect(await within(access).findByText('The Hub could not save it.')).toBeTruthy();
    expect((add as HTMLInputElement).value).toBe('tracker.test');
    expect(within(access).queryByRole('list', { name: 'Blocked hosts' })).toBeNull();
  });

  it('warns that read-only access blocks HTTPS without inspection', async () => {
    await openNetwork(
      { inspection: { https: false, caCertPem: null } },
      { settings: { 'network.egressMode': 'limited' } },
    );
    const access = region('Access for every sandbox');
    expect(
      await within(access).findByText(/read-only access blocks every HTTPS request/),
    ).toBeTruthy();
    const ins = region('HTTPS inspection');
    expect(within(ins).getByText(/This Hub has no inspection certificate/)).toBeTruthy();
    expect(within(ins).queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('offers the inspection certificate when HTTPS is inspected', async () => {
    await openNetwork();
    const ins = region('HTTPS inspection');
    const link = await within(ins).findByRole('link', { name: 'Download the certificate' });
    expect(link.getAttribute('href')).toBe('/api/v1/egress/ca.pem');
    expect(link.getAttribute('download')).toBe('nova-egress-ca.pem');
  });

  it('never uses a stored list the proxy would refuse: it falls back to none allowed', async () => {
    // The setting's schema is the proxy's (FR-193), so an invalid stored list resolves to the
    // default (fail closed) instead of breaking every sandbox's network.
    await openNetwork({}, { settings: { 'network.egressAllow': ['api.*.test', 'ok.test'] } });
    const access = region('Access for every sandbox');
    expect(within(access).queryByText('ok.test')).toBeNull();
    expect(within(access).queryByText('api.*.test')).toBeNull();
  });

  it("shows the hosts in force when a managed ceiling decides them, never 'cannot reach any host'", async () => {
    // The owner lists none: the policy's own hosts are in force (ADR-097).
    const r = await openNetwork({}, { egressInForce: ['api.example.com'] });
    let access = region('Access for every sandbox');
    expect(
      await within(access).findByText('Sandboxes may reach now: api.example.com.'),
    ).toBeTruthy();
    expect(within(access).getByText('None of your own.')).toBeTruthy();
    expect(within(access).queryByText('None yet: sandboxes cannot reach any host.')).toBeNull();
    expect(within(access).getByRole('note', { name: 'Hosts in force' })).toBeTruthy();
    r.unmount();
    // The owner's hosts are all outside the ceiling: none is in force.
    const s = await openNetwork(
      {},
      { settings: { 'network.egressAllow': ['files.example.org'] }, egressInForce: [] },
    );
    access = region('Access for every sandbox');
    expect(await within(access).findByText('Sandboxes may reach no host now.')).toBeTruthy();
    expect(within(access).getByText('files.example.org')).toBeTruthy();
    s.unmount();
    // Without a ceiling the list in force is the owner's: no note.
    await openNetwork({}, { settings: { 'network.egressAllow': ['ok.test'] } });
    access = region('Access for every sandbox');
    expect(await within(access).findByText('ok.test')).toBeTruthy();
    expect(within(access).queryByRole('note', { name: 'Hosts in force' })).toBeNull();
  });

  it('locks what managed policy sets', async () => {
    await openNetwork(
      {},
      { managed: { 'network.egressMode': 'off', 'network.egressDeny': ['evil.test'] } },
    );
    const access = region('Access for every sandbox');
    const off = within(access).getByRole<HTMLInputElement>('radio', { name: 'Off' });
    expect(off.checked).toBe(true);
    expect(off.disabled).toBe(true);
    expect(within(access).getAllByText('Managed by your organization')).toHaveLength(2);
    expect(
      within(access).getByRole<HTMLInputElement>('textbox', { name: 'Add a blocked host' })
        .disabled,
    ).toBe(true);
    expect(
      within(access).getByRole<HTMLButtonElement>('button', {
        name: 'Remove evil.test from blocked hosts',
      }).disabled,
    ).toBe(true);
    // Allowed hosts are not managed and stay editable.
    expect(
      within(access).getByRole<HTMLInputElement>('textbox', { name: 'Add an allowed host' })
        .disabled,
    ).toBe(false);
  });
});

describe('rules for one agent, run or session (FR-102, docs/11 §7)', () => {
  it('adds a rule for an agent with its own hosts and access', async () => {
    const { api, state } = await openNetwork();
    const rules = region('Rules for one agent, run or session');
    expect(await within(rules).findByText('No rules yet.')).toBeTruthy();
    await userEvent.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a network rule' });
    const save = within(dialog).getByRole('button', { name: 'Save rule' });
    await userEvent.click(save);
    expect(within(dialog).getByText('Choose the agent this rule is for.')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Agent' }).disabled,
      ).toBe(false),
    );
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent' }), 'ag2');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Access' }),
      'limited',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Add an allowed host for this rule' }),
      'status.ops.test{Enter}',
    );
    await userEvent.click(
      within(dialog).getByRole('switch', { name: 'Dev servers on private addresses' }),
    );
    await userEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.putEgressScope).toHaveBeenCalledWith('agent', 'ag2', {
      mode: 'limited',
      allow: ['status.ops.test'],
      deny: [],
      hooks: [],
      allowLocalBinding: true,
    });
    expect(state.scopes).toHaveLength(1);
    const list = await within(rules).findByRole('list', { name: 'Network rules' });
    const row = within(list).getByRole('listitem');
    expect(row.textContent).toContain('Agent: Ops');
    expect(row.textContent).toContain('Read-only');
    expect(row.textContent).toContain('1 more allowed host');
    expect(row.textContent).toContain('Dev servers on private addresses');
  });

  it('edits a rule and sends its request rules back', async () => {
    const hook = {
      id: 'h1',
      host: 'api.github.com',
      action: 'strip_header' as const,
      header: 'Authorization',
      methods: ['POST'],
    };
    const { api } = await openNetwork({
      scopes: [scopeView({ kind: 'agent', id: 'ag1', allow: ['a.test'], hooks: [hook] })],
    });
    const rules = region('Rules for one agent, run or session');
    await userEvent.click(
      await within(rules).findByRole('button', { name: 'Edit the rule for Agent: Research' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Rule for Agent: Research' });
    expect(within(dialog).getByText('Request rules (1)')).toBeTruthy();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Add a blocked host for this rule' }),
      'b.test{Enter}',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.putEgressScope).toHaveBeenCalledWith('agent', 'ag1', {
      mode: null,
      allow: ['a.test'],
      deny: ['b.test'],
      hooks: [hook],
      allowLocalBinding: false,
    });
  });

  it('says why the Hub refused a rule, and says when a wider access does not apply', async () => {
    const { computers } = await openNetwork(
      { scopes: [scopeView({ kind: 'agent', id: 'ag1' })] },
      { settings: { 'network.egressMode': 'limited' } },
    );
    const rules = region('Rules for one agent, run or session');
    await userEvent.click(
      await within(rules).findByRole('button', { name: 'Edit the rule for Agent: Research' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Rule for Agent: Research' });
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Access' }),
      'allowlist',
    );
    expect(
      within(dialog).getByText(
        /is wider than the access for every sandbox, so Read-only still applies/,
      ),
    ).toBeTruthy();
    computers.failNext.putEgressScope = new ApiError(400, {
      code: 'validation',
      message: 'a wildcard is allowed only as the leftmost label: a.*.test',
      retryable: false,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(
      await within(dialog).findByText('a wildcard is allowed only as the leftmost label: a.*.test'),
    ).toBeTruthy();
  });

  it('removes a rule after confirming', async () => {
    const { api, state } = await openNetwork({ scopes: [scopeView({ kind: 'agent', id: 'ag1' })] });
    const rules = region('Rules for one agent, run or session');
    await userEvent.click(
      await within(rules).findByRole('button', { name: 'Remove the rule for Agent: Research' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove this rule?' });
    expect(dialog.textContent).toContain(
      'Agent: Research goes back to the access for every sandbox',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove rule' }));
    await waitFor(() => expect(state.scopes).toHaveLength(0));
    expect(api.deleteEgressScope).toHaveBeenCalledWith('agent', 'ag1');
    expect(await within(rules).findByText('No rules yet.')).toBeTruthy();
  });

  it('follows rule changes made elsewhere', async () => {
    const { state } = await openNetwork();
    const rules = region('Rules for one agent, run or session');
    expect(await within(rules).findByText('No rules yet.')).toBeTruthy();
    state.scopes = [scopeView({ kind: 'agent', id: 'ag2', deny: ['x.test'] })];
    stream('egress.policy.changed').emit('egress.policy.changed', {
      scope: { kind: 'agent', id: 'ag2' },
    });
    expect(await within(rules).findByText('Agent: Ops')).toBeTruthy();
  });

  it('reports rules that cannot load and retries', async () => {
    await openNetwork({}, { fail: { getEgress: new Error('Proxy store offline') } });
    expect(await screen.findByText('Proxy store offline')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    const rules = await screen.findByRole('region', {
      name: 'Rules for one agent, run or session',
    });
    expect(within(rules).getByText('No rules yet.')).toBeTruthy();
  });
});

describe('credentials the proxy adds (FR-193, ADR-063)', () => {
  it('adds a header credential whose value is never shown again', async () => {
    const { api, state } = await openNetwork();
    const creds = region('Credentials the proxy adds');
    expect(await within(creds).findByText('No credentials yet.')).toBeTruthy();
    await userEvent.click(within(creds).getByRole('button', { name: 'Add a credential' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a credential' });
    const submit = within(dialog).getByRole('button', { name: 'Add credential' });
    await userEvent.click(submit);
    expect(within(dialog).getByText('Give it a name.')).toBeTruthy();
    expect(within(dialog).getByText('Add at least one host.')).toBeTruthy();
    expect(within(dialog).getByText('Enter the value.')).toBeTruthy();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Mock API');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Add a host that gets this credential' }),
      'api.mock.test{Enter}',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Custom header' }));
    const header = within(dialog).getByRole('textbox', { name: 'Header name' });
    await userEvent.type(header, 'Cookie');
    await userEvent.click(submit);
    expect(within(dialog).getByText('This header cannot carry a credential.')).toBeTruthy();
    await userEvent.clear(header);
    await userEvent.type(header, 'X-Api-Key');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Who gets it' }),
      'agent:ag1',
    );
    const value = within(dialog).getByLabelText('Value');
    expect(value.getAttribute('type')).toBe('password');
    await userEvent.type(value, 's3cret-token');
    await userEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(api.createEgressCredential).toHaveBeenCalledWith({
      name: 'Mock API',
      hosts: ['api.mock.test'],
      scheme: 'header',
      header: 'X-Api-Key',
      username: null,
      scope: { kind: 'agent', id: 'ag1' },
      value: 's3cret-token',
    });
    expect(state.credentials[0]?.value).toBe('s3cret-token');
    const list = await within(creds).findByRole('list', { name: 'Credentials' });
    const row = within(list).getByRole('listitem');
    expect(row.textContent).toContain('Header X-Api-Key');
    expect(row.textContent).toContain('Only for Agent: Research');
    expect(row.textContent).toContain('Value set');
    expect(row.textContent).toContain('api.mock.test');
    expect(document.body.textContent).not.toContain('s3cret-token');
  });

  it('edits only what changed, replaces the value, and deletes after confirming', async () => {
    const { api, state } = await openNetwork({
      credentials: [{ ...credentialView({ id: 'cr1', name: 'Weather API' }), value: 'old-value' }],
    });
    const creds = region('Credentials the proxy adds');
    await userEvent.click(await within(creds).findByRole('button', { name: 'Edit Weather API' }));
    let dialog = screen.getByRole('dialog', { name: 'Edit “Weather API”' });
    expect(within(dialog).queryByLabelText('Value')).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'User name and password' }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'User name (optional)' }),
      'bot',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateEgressCredential).toHaveBeenLastCalledWith('cr1', {
      scheme: 'basic',
      username: 'bot',
    });
    expect(await within(creds).findByText('Basic sign-in as bot')).toBeTruthy();

    await userEvent.click(
      within(creds).getByRole('button', { name: 'Replace the value of Weather API' }),
    );
    dialog = screen.getByRole('dialog', { name: 'Replace the value of “Weather API”' });
    const replace = within(dialog).getByRole('button', { name: 'Replace value' });
    expect((replace as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('New value'), 'new-value');
    await userEvent.click(replace);
    await waitFor(() => expect(state.credentials[0]?.value).toBe('new-value'));
    expect(api.updateEgressCredential).toHaveBeenLastCalledWith('cr1', { value: 'new-value' });
    expect(document.body.textContent).not.toContain('new-value');

    await userEvent.click(within(creds).getByRole('button', { name: 'Delete Weather API' }));
    dialog = screen.getByRole('dialog', { name: 'Delete this credential?' });
    expect(dialog.textContent).toContain('api.weather.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete credential' }));
    await waitFor(() => expect(state.credentials).toHaveLength(0));
    expect(await within(creds).findByText('No credentials yet.')).toBeTruthy();
  });

  it('closes an edit with no changes without calling the Hub', async () => {
    const { api } = await openNetwork({
      credentials: [{ ...credentialView({ id: 'cr1' }), value: 'v' }],
    });
    const creds = region('Credentials the proxy adds');
    await userEvent.click(await within(creds).findByRole('button', { name: 'Edit Weather API' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.updateEgressCredential).not.toHaveBeenCalled();
  });

  it('says credentials reach plain HTTP only without inspection, and reports load errors', async () => {
    await openNetwork(
      { inspection: { https: false, caCertPem: null } },
      { fail: { listEgressCredentials: new Error('Vault locked') } },
    );
    const creds = region('Credentials the proxy adds');
    expect(
      await within(creds).findByText(/credentials are added to plain HTTP requests only/),
    ).toBeTruthy();
    expect(within(creds).getByText('Vault locked')).toBeTruthy();
    await userEvent.click(within(creds).getByRole('button', { name: 'Retry' }));
    expect(await within(creds).findByText('No credentials yet.')).toBeTruthy();
  });
});

describe('the decision log (docs/12 §8)', () => {
  const DECISIONS = () => [
    decisionView({
      id: 'd1',
      decision: 'deny',
      cause: 'allowlist',
      host: 'unlisted.test',
      method: 'GET',
      status: 403,
      inspected: false,
      bytesIn: 0,
      bytesOut: 0,
    }),
    decisionView({
      id: 'd2',
      decision: 'deny',
      cause: 'private_address',
      host: 'router.lan',
      port: 8080,
      addressClass: 'private',
      status: 403,
      bytesIn: 0,
      bytesOut: 0,
    }),
    decisionView({ id: 'd3', decision: 'allow', host: 'api.weather.test' }),
  ];

  it('says why each request was blocked, in plain words', async () => {
    await openNetwork({ decisions: DECISIONS() });
    const log = region('Decision log');
    const list = await within(log).findByRole('list', { name: 'Network decisions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Blocked')).toBeTruthy();
    expect(within(rows[0]!).getByText('GET unlisted.test')).toBeTruthy();
    expect(within(rows[0]!).getByText('The host is not on the allowed list.')).toBeTruthy();
    expect(rows[0]!.textContent).toContain('Agent: Research');
    expect(within(rows[1]!).getByText('GET router.lan:8080')).toBeTruthy();
    expect(rows[1]!.textContent).toContain('private, loopback or link-local');
    expect(rows[1]!.textContent).toContain('Private address');
    // Only a host blocked for not being allowed offers Allow.
    expect(within(rows[1]!).queryByRole('button', { name: /Allow/ })).toBeNull();
    expect(within(rows[2]!).getByText('Allowed')).toBeTruthy();
    expect(rows[2]!.textContent).toContain('HTTP 200');
    expect(rows[2]!.textContent).toContain('HTTPS inspected');
    expect(rows[2]!.textContent).toContain('2 KB in, 300 B out');
  });

  it('filters by decision and host', async () => {
    const { api } = await openNetwork({ decisions: DECISIONS() });
    const log = region('Decision log');
    await within(log).findByRole('list', { name: 'Network decisions' });
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Decision' }), 'deny');
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(2));
    expect(api.listNetworkDecisions).toHaveBeenLastCalledWith({ decision: 'deny', limit: 50 });
    await userEvent.type(within(log).getByRole('textbox', { name: 'Host' }), 'Router.LAN{Enter}');
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(1));
    expect(api.listNetworkDecisions).toHaveBeenLastCalledWith({
      decision: 'deny',
      host: 'router.lan',
      limit: 50,
    });
    await userEvent.type(within(log).getByRole('textbox', { name: 'Host' }), 'x');
    await userEvent.click(within(log).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(3));
    await userEvent.selectOptions(within(log).getByRole('combobox', { name: 'Decision' }), 'allow');
    await userEvent.type(within(log).getByRole('textbox', { name: 'Host' }), 'nowhere.test{Enter}');
    expect(await within(log).findByText('No decisions match these filters.')).toBeTruthy();
  });

  it('shows older decisions page by page with the Hub cursor', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      decisionView({ id: `m${i}`, host: `h${i}.test` }),
    );
    const { api } = await openNetwork({ decisions: many });
    const log = region('Decision log');
    const list = await within(log).findByRole('list', { name: 'Network decisions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    await userEvent.click(within(log).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(100));
    expect(api.listNetworkDecisions).toHaveBeenLastCalledWith({ limit: 50, before: 'm49' });
    await userEvent.click(within(log).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(120));
    expect(within(log).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('starts empty, reports errors and retries', async () => {
    await openNetwork({}, { fail: { listNetworkDecisions: new Error('Audit log busy') } });
    const log = region('Decision log');
    expect(await within(log).findByText('Audit log busy')).toBeTruthy();
    await userEvent.click(within(log).getByRole('button', { name: 'Retry' }));
    expect(await within(log).findByText(/No requests yet/)).toBeTruthy();
  });

  it('follows new decisions live', async () => {
    const { state } = await openNetwork();
    const log = region('Decision log');
    expect(await within(log).findByText(/No requests yet/)).toBeTruthy();
    state.decisions = [decisionView({ id: 'live', host: 'fresh.test' })];
    stream('audit.appended').emit('audit.appended', { auditId: 'x', kind: 'tool', hash: 'h' });
    stream('audit.appended').emit('audit.appended', { auditId: 'y', kind: 'network', hash: 'h' });
    expect(await within(log).findByText('GET fresh.test', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('allows a blocked host for the agent that asked', async () => {
    const { api, state, hub } = await openNetwork({
      decisions: DECISIONS(),
      scopes: [scopeView({ kind: 'agent', id: 'ag1', deny: ['z.test'] })],
    });
    const log = region('Decision log');
    await userEvent.click(await within(log).findByRole('button', { name: 'Allow unlisted.test' }));
    const dialog = screen.getByRole('dialog', { name: 'Allow unlisted.test?' });
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Only Agent: Research' }).checked,
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow host' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.putEgressScope).toHaveBeenCalledWith('agent', 'ag1', {
      mode: null,
      allow: ['unlisted.test'],
      deny: ['z.test'],
      hooks: [],
      allowLocalBinding: false,
    });
    expect(state.scopes[0]?.allow).toEqual(['unlisted.test']);
    expect(hub.state.settings['network.egressAllow']).toBeUndefined();
  });

  it('allows a blocked host for every sandbox', async () => {
    const { hub } = await openNetwork({ decisions: DECISIONS() });
    const log = region('Decision log');
    await userEvent.click(await within(log).findByRole('button', { name: 'Allow unlisted.test' }));
    const dialog = screen.getByRole('dialog', { name: 'Allow unlisted.test?' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Every sandbox' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow host' }));
    await waitFor(() =>
      expect(hub.state.settings['network.egressAllow']).toEqual(['unlisted.test']),
    );
    const access = region('Access for every sandbox');
    expect(within(access).getByText('unlisted.test')).toBeTruthy();
  });
});
