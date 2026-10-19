// Environment variables an external agent asks for on a terminal (FR-203; M8): only allowlisted
// names with plain values reach the command, as leading assignments the policy engine sees.
import { describe, expect, it } from 'vitest';
import {
  MAX_TERMINAL_ENV,
  policyAcpHost,
  terminalEnv,
  terminalEnvNameAllowed,
  type ToolRuntime,
} from '../src/index.ts';

describe('the terminal environment allowlist', () => {
  it('passes display, locale and commit identity variables', () => {
    for (const n of ['CI', 'TERM', 'NO_COLOR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'GIT_AUTHOR_NAME'])
      expect(terminalEnvNameAllowed(n), n).toBe(true);
  });

  it('drops anything that changes where code, libraries, credentials or traffic come from', () => {
    for (const n of [
      'PATH',
      'HOME',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'HTTP_PROXY',
      'https_proxy',
      'NO_PROXY',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'BASH_ENV',
      'ENV',
      'PYTHONPATH',
      'GIT_SSH_COMMAND',
      'NOVA_EGRESS_FORWARDER',
      'LC_',
      'ci',
      '1CI',
      'C I',
      '',
    ])
      expect(terminalEnvNameAllowed(n), n).toBe(false);
  });

  it('drops credentials, vault references and values that could spill into the command', () => {
    const out = terminalEnv([
      { name: 'CI', value: '1' },
      { name: 'TERM', value: 'dumb\nrm -rf /' },
      { name: 'PAGER', value: 'secret://providers/x' },
      { name: 'GIT_AUTHOR_NAME', value: 'ghp_' + 'a'.repeat(36) },
      { name: 'TZ', value: 'x'.repeat(5000) },
      { name: 'PATH', value: '/evil' },
      { name: 'bad name', value: '1' },
    ]);
    expect(out.pass).toEqual([['CI', '1']]);
    expect(out.dropped).toEqual([
      'TERM',
      'PAGER',
      'GIT_AUTHOR_NAME',
      'TZ',
      'PATH',
      '(invalid name)',
    ]);
  });

  it('keeps the last value of a name and caps the count', () => {
    expect(
      terminalEnv([
        { name: 'CI', value: '1' },
        { name: 'CI', value: 'true' },
      ]).pass,
    ).toEqual([['CI', 'true']]);
    const many = Array.from({ length: MAX_TERMINAL_ENV + 3 }, (_, i) => ({
      name: `LC_X${i}`,
      value: 'C',
    }));
    const out = terminalEnv(many);
    expect(out.pass).toHaveLength(MAX_TERMINAL_ENV);
    expect(out.dropped).toHaveLength(3);
    expect(terminalEnv(undefined)).toEqual({ pass: [], dropped: [] });
  });
});

describe('terminals with variables', () => {
  function host() {
    const calls: { name: string; args: unknown }[] = [];
    const runtime = {
      registry: { find: () => Promise.resolve(null) },
      scopeFor: () =>
        Promise.resolve({ roots: [], profile: { id: 'p', hash: 'h' }, network: 'off' }),
      sandbox: { write: () => Promise.resolve() },
      execute: (x: { name: string; args: unknown }) => {
        calls.push({ name: x.name, args: x.args });
        return Promise.resolve({
          callId: 'c',
          status: 'ok',
          ok: true,
          text: 'Exit code 0\ndone',
          error: null,
          origin: null,
          stop: null,
          userAnswer: false,
        });
      },
    } as unknown as ToolRuntime;
    const h = policyAcpHost({
      runtime,
      gate: {
        check: () => Promise.reject(new Error('unused')),
        preview: () => Promise.reject(new Error('unused')),
      },
      accountId: 'a',
      threadId: 't',
      projectId: null,
      delegationId: 'd',
      adapterName: 'agent',
      folder: '/w',
      signal: new AbortController().signal,
    });
    return { h, calls };
  }

  it('sets the allowed variables as leading assignments of the command the gate judges', async () => {
    const { h, calls } = host();
    await h.createTerminal({
      sessionId: 's',
      command: 'npm',
      args: ['test'],
      env: [
        { name: 'CI', value: '1' },
        { name: 'GIT_AUTHOR_NAME', value: 'Ada Lovelace' },
        { name: 'LD_PRELOAD', value: '/tmp/x.so' },
      ],
    });
    expect(calls).toEqual([
      {
        name: 'exec.run',
        args: { cmd: "CI=1 GIT_AUTHOR_NAME='Ada Lovelace' npm test", yieldMs: 120_000 },
      },
    ]);
  });

  it('runs the command alone when nothing passes', async () => {
    const { h, calls } = host();
    await h.createTerminal({
      sessionId: 's',
      command: 'ls',
      env: [{ name: 'PATH', value: '/x' }],
    });
    expect(calls[0]!.args).toEqual({ cmd: 'ls', yieldMs: 120_000 });
  });
});
