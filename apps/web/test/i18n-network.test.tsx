// Settings → Network in the pseudo-locale (FR-016): every word of the egress page (access for
// every sandbox, HTTPS inspection, rules, credentials, the decision log) and of its dialogs comes
// from messages. Names, hosts and ids are fixture data.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { hostProblem, parseHostEntries } from '../src/network/HostListEditor.tsx';
import { NetworkPage } from '../src/network/NetworkPage.tsx';
import { hookFromDraft } from '../src/network/ScopeRules.tsx';
import {
  ACCESS_TEXT,
  CREDS_TEXT,
  EGRESS_TEXT,
  HOSTS_TEXT,
  LOG_TEXT,
  RULES_TEXT,
} from '../src/network/strings.ts';
import {
  credentialView,
  decisionView,
  renderWithComputers,
  scopeView,
} from './fakes-m6-computers.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const AGENTS = [
  { id: 'ag1', name: 'Research' },
  { id: 'ag2', name: 'Ops' },
];

/**
 * Fixture names (agents, the credential) and hosts. Access levels, scope kinds, credential schemes
 * and block causes are the computers area's messages, localized like the rest.
 */
const DATA = ['Research', 'Ops', 'Weather API', 'unlisted.test', 'api.weather.test', 'evil.test'];

async function openNetwork() {
  await activateTestLocale('en-XA');
  const r = await renderWithComputers(<NetworkPage />, {
    computers: {
      agents: AGENTS,
      scopes: [
        scopeView({
          kind: 'agent',
          id: 'ag1',
          mode: 'limited',
          allow: ['status.ops.test'],
          hooks: [{ id: 'h1', host: 'api.github.com', action: 'strip_cookies' }],
          allowLocalBinding: true,
        }),
      ],
      credentials: [{ ...credentialView({ id: 'c1' }), value: 'secret' }],
      decisions: [
        decisionView({
          id: 'd1',
          decision: 'deny',
          cause: 'allowlist',
          host: 'unlisted.test',
          status: 403,
          addressClass: 'private',
        }),
        decisionView({ id: 'd2', decision: 'allow', host: 'api.weather.test' }),
      ],
    },
    settings: { 'network.egressAllow': ['api.weather.test'], 'network.egressDeny': ['evil.test'] },
  });
  await screen.findByRole('list', { name: RULES_TEXT.list });
  await screen.findByRole('list', { name: CREDS_TEXT.list });
  await screen.findByRole('list', { name: LOG_TEXT.list });
  return r;
}

describe('Settings → Network in a pseudo-locale', () => {
  it('shows the page fully localized in en-XA', async () => {
    const { container } = await openNetwork();
    expect(screen.getByRole('heading', { name: EGRESS_TEXT.title, level: 2 })).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });
    // The plural counts are messages too.
    const rules = screen.getByRole('list', { name: RULES_TEXT.list });
    expect(rules.textContent).toContain(RULES_TEXT.moreAllowed({ n: 1 }));
    expect(rules.textContent).toContain(RULES_TEXT.requestRules({ n: 1 }));
  });

  it('shows the rule, credential and allow-host dialogs localized', async () => {
    await openNetwork();

    await userEvent.click(screen.getByRole('button', { name: RULES_TEXT.add }));
    let dialog = screen.getByRole('dialog', { name: RULES_TEXT.addTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: RULES_TEXT.addHook }));
    await userEvent.click(within(dialog).getByRole('button', { name: RULES_TEXT.saveRule }));
    expect(within(dialog).getByText(RULES_TEXT.chooseTarget({ kind: 'agent' }))).toBeTruthy();
    expectFullyLocalized(dialog, { data: DATA });
    await userEvent.click(within(dialog).getByRole('button', { name: EGRESS_TEXT.cancel }));

    await userEvent.click(screen.getByRole('button', { name: CREDS_TEXT.add }));
    dialog = screen.getByRole('dialog', { name: CREDS_TEXT.add });
    await userEvent.click(within(dialog).getByRole('button', { name: CREDS_TEXT.addCredential }));
    expect(within(dialog).getByText(CREDS_TEXT.giveName)).toBeTruthy();
    expectFullyLocalized(dialog, { data: DATA });
    await userEvent.click(within(dialog).getByRole('button', { name: EGRESS_TEXT.cancel }));

    await userEvent.click(
      screen.getByRole('button', { name: LOG_TEXT.allowHost({ host: 'unlisted.test' }) }),
    );
    dialog = screen.getByRole('dialog', { name: LOG_TEXT.allowTitle({ host: 'unlisted.test' }) });
    expectFullyLocalized(dialog, { data: [...DATA, 'unlisted.test'] });
  });

  it('says why a host or a request rule is not valid in the active locale', async () => {
    await activateTestLocale('en-XA');
    expect(hostProblem('*')).toBe(HOSTS_TEXT.problem.bare);
    expect(hostProblem('*.com')).toBe(HOSTS_TEXT.problem.wildcardTld({ host: '*.com' }));
    expect(hostProblem('api.*.example.com')).toBe(
      HOSTS_TEXT.problem.wildcardLeft({ host: 'api.*.example.com' }),
    );
    expect(hostProblem('a..b')).toBe(HOSTS_TEXT.problem.notHost({ host: 'a..b' }));
    expect(hostProblem('api.example.com')).toBeNull();
    expect(parseHostEntries('', [])).toEqual({ ok: false, error: HOSTS_TEXT.typeHost });
    expect(parseHostEntries('a.test', ['a.test'])).toEqual({
      ok: false,
      error: HOSTS_TEXT.already({ host: 'a.test' }),
    });
    const draft = {
      key: 'k',
      id: 'h1',
      action: 'strip_header' as const,
      host: '*',
      header: 'Authorization',
      methods: '',
      pathPrefix: '',
    };
    expect(hookFromDraft(draft)).toEqual({
      ok: false,
      error: RULES_TEXT.hostProblem({ why: HOSTS_TEXT.problem.bare }),
    });
    expect(ACCESS_TEXT.removeAllowed({ host: 'a.test' })).toMatch(/a\.test/);
  });
});
