// Every credential in this file is a fixture (secret-scan: fake-file).
// Import readers (FR-200, docs/08 §4.2): secrets in MCP configs (env, headers, arguments, URLs)
// found by name or by token shape and kept out of what is stored; placeholders recognised; chat
// exports as message lists and message trees; memory exports as JSON or text.
import { describe, expect, it } from 'vitest';
import {
  findImportMcpServers,
  isImportSecret,
  maskImportSecret,
  planImportMcpServer,
  readChatExport,
} from '../src/index.ts';

describe('secrets in imported config', () => {
  it('knows credential names and token shapes, and leaves placeholders alone', () => {
    for (const n of [
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'X-Api-Key',
      'apiKey',
      'Authorization',
      'DB_PASSWORD',
      'client_secret',
    ])
      expect(isImportSecret(n, 'value-1234'), n).toBe(true);
    for (const n of ['KEYBOARD', 'AUTHOR', 'LOG_LEVEL', 'HOME'])
      expect(isImportSecret(n, 'value'), n).toBe(false);
    expect(isImportSecret('ARG', 'ghp_fake0123456789abcdefghijklmn')).toBe(true);
    for (const v of [
      '${GITHUB_TOKEN}',
      '$TOKEN',
      '${env:TOKEN}',
      'secret://x/y',
      '<your-token>',
      '',
    ])
      expect(isImportSecret('TOKEN', v), v).toBe(false);
  });

  it('masks a value to at most two leading characters', () => {
    expect(maskImportSecret('ghp_fake0123456789abcdef')).toBe('gh…••••');
    expect(maskImportSecret('short')).toBe('••••');
  });
});

describe('MCP server configs', () => {
  it('finds mcpServers maps at any shallow depth, and servers in mcp.json', () => {
    const nested = {
      projects: { '/x': { mcpServers: { a: { command: 'a' } } } },
      mcpServers: { b: { url: 'https://b.example' } },
    };
    expect(
      findImportMcpServers(nested, 'settings.json')
        .map(([n]) => n)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(
      findImportMcpServers({ servers: { c: { command: 'c' } } }, 'mcp.json').map(([n]) => n),
    ).toEqual(['c']);
    expect(findImportMcpServers({ servers: { c: { command: 'c' } } }, 'other.json')).toEqual([]);
    expect(findImportMcpServers([1, 2], 'x.json')).toEqual([]);
  });

  it('moves secrets out of arguments into the environment', () => {
    const plan = planImportMcpServer('My DB_Server', {
      command: 'db-mcp',
      args: [
        '--host',
        'db.local',
        '--password',
        'fake-pass-123456',
        '--api-key=fake-key-0123456789',
        'sk-test-fake0123456789abcdef',
        '--token',
        '${TOKEN}',
      ],
      env: { LOG_LEVEL: 'debug', DB_TOKEN: 'fake-token-0123456789', PORT: 5432 },
      cwd: '/srv',
    });
    expect(plan.name).toBe('my-db-server');
    expect(plan.transport).toBe('stdio');
    expect(plan.args).toEqual(['--host', 'db.local', '--token', '${TOKEN}']);
    expect(plan.env).toEqual({
      password: 'fake-pass-123456',
      api_key: 'fake-key-0123456789',
      IMPORTED_SECRET_1: 'sk-test-fake0123456789abcdef',
      LOG_LEVEL: 'debug',
      DB_TOKEN: 'fake-token-0123456789',
      PORT: '5432',
    });
    expect(plan.secrets.map((s) => s.name).sort()).toEqual([
      'DB_TOKEN',
      'IMPORTED_SECRET_1',
      'api_key',
      'password',
    ]);
    expect(plan.notes.join(' ')).toMatch(/working directory/);
    expect(JSON.stringify(plan.args)).not.toContain('fake-pass');
  });

  it('moves secrets out of URLs and keeps headers as named values', () => {
    const plan = planImportMcpServer('remote', {
      type: 'sse',
      url: 'https://user:fake-secret-pw@mcp.example.com/sse?token=fake-url-token-12345&region=eu',
      headers: { Authorization: 'Bearer fake-bearer-0123456789', 'X-Client': 'nova' },
      env: { REGION: 'eu', HOME_TOKEN: '${HOME_TOKEN}' },
    });
    expect(plan.transport).toBe('sse');
    expect(plan.url).toBe('https://user@mcp.example.com/sse?region=eu');
    expect(plan.hosts).toEqual(['mcp.example.com']);
    expect(plan.env).toMatchObject({
      URL_PASSWORD: 'fake-secret-pw',
      token: 'fake-url-token-12345',
      Authorization: 'Bearer fake-bearer-0123456789',
      X_Client: 'nova',
      HOME_TOKEN: '',
    });
    expect(plan.secrets.map((s) => s.name).sort()).toEqual([
      'Authorization',
      'URL_PASSWORD',
      'token',
    ]);
    expect(plan.notes.some((n) => n.includes('${HOME_TOKEN}'))).toBe(true);
    expect(planImportMcpServer('h', { url: 'https://h.example/mcp', type: 'http' }).transport).toBe(
      'http',
    );
  });

  it('marks entries it cannot import', () => {
    expect(planImportMcpServer('x', {}).unsupported).toMatch(/neither/);
    expect(planImportMcpServer('x', { url: 'not a url' }).unsupported).toMatch(/not valid/);
    expect(planImportMcpServer('x', { url: 'ftp://x.example/' }).unsupported).toMatch(/http/);
  });
});

describe('chat exports', () => {
  it('reads message lists with roles, parts and timestamps', () => {
    const chats = readChatExport([
      {
        uuid: 'c1',
        name: 'Trip plans',
        created_at: '2026-01-02T03:04:05Z',
        chat_messages: [
          { sender: 'human', text: 'Where should I go?', created_at: '2026-01-02T03:04:05Z' },
          {
            sender: 'assistant',
            content: [
              { type: 'text', text: 'Lisbon.' },
              { type: 'text', text: 'Or Porto.' },
            ],
          },
          { sender: 'system', text: 'ignored' },
          { sender: 'human', text: '   ' },
        ],
      },
      { title: 'empty', messages: [] },
      'junk',
    ]);
    expect(chats).toHaveLength(1);
    expect(chats![0]).toMatchObject({
      key: 'c1',
      title: 'Trip plans',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(chats![0]!.messages).toEqual([
      { role: 'user', text: 'Where should I go?', createdAt: '2026-01-02T03:04:05.000Z' },
      { role: 'assistant', text: 'Lisbon.\n\nOr Porto.', createdAt: null },
    ]);
  });

  it('reads message trees along the current branch', () => {
    const conv = {
      id: 'tree-1',
      title: 'Tree',
      create_time: 1767225600,
      current_node: 'c',
      mapping: {
        root: { message: null, parent: null, children: ['a'] },
        a: {
          message: {
            author: { role: 'user' },
            content: { parts: ['Hi'] },
            create_time: 1767225601,
          },
          parent: 'root',
          children: ['b', 'b2'],
        },
        b: {
          message: { author: { role: 'assistant' }, content: { parts: ['Old answer'] } },
          parent: 'a',
          children: [],
        },
        b2: {
          message: { author: { role: 'assistant' }, content: { parts: ['New answer'] } },
          parent: 'a',
          children: ['c'],
        },
        c: {
          message: { author: { role: 'user' }, content: { parts: ['Thanks'] } },
          parent: 'b2',
          children: [],
        },
      },
    };
    const [chat] = readChatExport({ conversations: [conv] })!;
    expect(chat!.messages.map((m) => m.text)).toEqual(['Hi', 'New answer', 'Thanks']);
    expect(chat!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    // Without a current node, the last child is followed from the root.
    const [noCurrent] = readChatExport([{ ...conv, current_node: undefined }])!;
    expect(noCurrent!.messages.map((m) => m.text)).toEqual(['Hi', 'New answer', 'Thanks']);
  });

  it('says when JSON is not a chat export', () => {
    expect(readChatExport({ mcpServers: {} })).toBeNull();
    expect(readChatExport([{ name: 'x' }])).toBeNull();
    expect(readChatExport('x')).toBeNull();
  });
});
