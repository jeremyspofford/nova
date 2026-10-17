// The MCP client against the fixture server over stdio (FR-042, FR-043): connect, discovery,
// calls with timeout and cancellation, error mapping, list-changed refresh, crash and restart
// with backoff, tool lists, protocol version checks and secrets kept out of logs and state.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_TOOL_NAME, McpToolSource } from '../src/index.ts';
import { harness, stdioConfig, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await h?.manager.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function texts(r: { ok: boolean; content?: { type: string; text?: string }[] }): string[] {
  return (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '');
}

describe('stdio servers', () => {
  it('connects, negotiates 2025-11-25 and lists tools, resources and prompts', async () => {
    h = harness();
    const cfg = stdioConfig({ name: 'files' });
    await h.manager.add(cfg);
    const s = h.manager.state(cfg.id)!;
    expect(s.status).toBe('connected');
    expect(s.protocolVersion).toBe('2025-11-25');
    expect(s.serverInfo).toEqual({ name: 'nova-test-server', version: '1.0.0' });
    expect(s.counts).toEqual({ tools: 5, resources: 1, prompts: 1 });
    expect(s.connectedAt).not.toBeNull();
    expect(h.manager.resources(cfg.id)[0]).toMatchObject({ uri: 'note://readme', name: 'readme' });
    expect(h.manager.prompts(cfg.id)[0]).toMatchObject({ name: 'greet' });
    const names = h.manager.tools(cfg.id).map((t) => t.descriptor.name);
    expect(names).toEqual([
      'mcp:files.echo',
      'mcp:files.add',
      'mcp:files.write_note',
      'mcp:files.slow',
      'mcp:files.purchase_item',
    ]);
    for (const n of names) expect(n).toMatch(MCP_TOOL_NAME);
    expect(h.statuses.map((x) => x.status)).toEqual(['starting', 'connected']);
    expect(h.toolChanges).toContain(cfg.id);
  });

  it('describes tools as deferrable MCP tools whose hints only add restrictions', async () => {
    h = harness();
    const cfg = stdioConfig({ toolTimeoutMs: 15_000 });
    await h.manager.add(cfg);
    const byName = new Map(h.manager.tools(cfg.id).map((t) => [t.original, t.descriptor]));
    const note = byName.get('write_note')!;
    expect(note).toMatchObject({
      source: 'mcp',
      serverId: cfg.id,
      loading: 'deferrable',
      timeoutMs: 15_000,
      annotations: { destructive: true },
    });
    // write_note claims readOnly too; a hint never makes a tool looser.
    expect(note.annotations?.readOnly).toBeUndefined();
    expect(byName.get('echo')!.annotations).toBeUndefined();
    expect(byName.get('purchase_item')!.annotations).toEqual({ requiresNetwork: true });
    expect(byName.get('add')!.outputSchema).toMatchObject({ type: 'object' });
    expect(note.effects).toBeUndefined();
  });

  it('calls tools and maps text and structured content', async () => {
    h = harness();
    const cfg = stdioConfig();
    await h.manager.add(cfg);
    const echo = await h.manager.callTool(cfg.id, 'echo', { text: 'hello' });
    expect(echo).toEqual({
      ok: true,
      content: [{ type: 'text', text: 'hello' }],
      meta: { serverId: cfg.id, tool: 'echo' },
    });
    const add = await h.manager.callTool(cfg.id, 'add', { a: 2, b: 3 });
    expect(add.ok && add.meta?.structuredContent).toEqual({ sum: 5 });
    // The text block "5" is not the JSON of {sum: 5}, so the JSON is added as text.
    expect(texts(add as never)).toEqual(['5', '{"sum":5}']);
  });

  it('maps tool errors, protocol errors and bad arguments', async () => {
    h = harness();
    const cfg = stdioConfig({}, ['--test-hooks']);
    await h.manager.add(cfg);
    const failed = await h.manager.callTool(cfg.id, 'fail', { message: 'disk full' });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'mcp.tool_error', message: 'disk full' },
    });
    const invalid = await h.manager.callTool(cfg.id, 'add', { a: 'x' });
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error.code).toBe('mcp.tool_error');
    expect(await h.manager.callTool(cfg.id, 'nope', {})).toMatchObject({
      ok: false,
      error: { code: 'mcp.tool_not_found' },
    });
    expect(await h.manager.callTool(cfg.id, 'echo', ['not', 'an', 'object'])).toMatchObject({
      ok: false,
      error: { code: 'mcp.invalid_args' },
    });
    expect(await h.manager.callTool('missing', 'echo', {})).toMatchObject({
      ok: false,
      error: { code: 'mcp.unavailable' },
    });
  });

  it('maps every content kind', async () => {
    h = harness();
    const cfg = stdioConfig({}, ['--test-hooks']);
    await h.manager.add(cfg);
    const r = await h.manager.callTool(cfg.id, 'media', {});
    expect(r.ok).toBe(true);
    const parts = r.ok ? r.content : [];
    expect(parts[0]).toEqual({ type: 'text', text: 'caption' });
    expect(parts[1]).toMatchObject({ type: 'image', mime: 'image/png' });
    expect(parts[2]).toEqual({ type: 'text', text: '[audio audio/wav omitted]' });
    expect(parts[3]).toEqual({ type: 'text', text: '[resource readme: note://readme]' });
    expect(parts[4]).toEqual({ type: 'text', text: '[resource note://inline]\ninline' });
    expect(parts[5]).toEqual({
      type: 'text',
      text: '[resource note://blob (application/zip) omitted]',
    });
  });

  it('times out a call after toolTimeoutMs and cancels it on the server', async () => {
    h = harness();
    const cfg = stdioConfig({ toolTimeoutMs: 1000 });
    await h.manager.add(cfg);
    const t0 = Date.now();
    const r = await h.manager.callTool(cfg.id, 'slow', { ms: 5000 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r).toMatchObject({ ok: false, error: { code: 'mcp.timeout' } });
    await waitFor(
      () => h!.manager.logs(cfg.id).some((l) => l.text === 'slow cancelled'),
      5000,
      'server-side cancel',
    );
    // A per-call timeout overrides the server's.
    const quick = await h.manager.callTool(cfg.id, 'slow', { ms: 3000 }, { timeoutMs: 100 });
    expect(quick).toMatchObject({ ok: false, error: { code: 'mcp.timeout' } });
  });

  it('cancels a call from an AbortSignal', async () => {
    h = harness();
    const cfg = stdioConfig();
    await h.manager.add(cfg);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await h.manager.callTool(cfg.id, 'slow', { ms: 5000 }, { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, error: { code: 'mcp.cancelled' } });
    await waitFor(() => h!.manager.logs(cfg.id).some((l) => l.text === 'slow cancelled'));
    const pre = new AbortController();
    pre.abort();
    expect(
      await h.manager.callTool(cfg.id, 'echo', { text: 'x' }, { signal: pre.signal }),
    ).toMatchObject({ ok: false, error: { code: 'mcp.cancelled' } });
  });

  it('reports progress', async () => {
    h = harness();
    const cfg = stdioConfig({}, ['--test-hooks']);
    await h.manager.add(cfg);
    const chunks: string[] = [];
    const r = await h.manager.callTool(
      cfg.id,
      'progress',
      { steps: 1 },
      {
        onProgress: (c) => chunks.push(c),
      },
    );
    expect(r.ok).toBe(true);
    await waitFor(() => chunks.length > 0, 2000, 'progress');
    expect(chunks[0]).toBe('step 1');
  });

  it('refreshes tools on list-changed notifications', async () => {
    h = harness();
    const cfg = stdioConfig({}, ['--test-hooks']);
    await h.manager.add(cfg);
    const before = h.toolChanges.length;
    expect(await h.manager.callTool(cfg.id, 'add_tool', { name: 'late' })).toMatchObject({
      ok: true,
    });
    await waitFor(
      () => h!.manager.tools(cfg.id).some((t) => t.original === 'late'),
      5000,
      'new tool',
    );
    expect(h.toolChanges.length).toBeGreaterThan(before);
    expect(await h.manager.callTool(cfg.id, 'late', {})).toMatchObject({ ok: true });
    await h.manager.callTool(cfg.id, 'remove_tool', { name: 'late' });
    await waitFor(() => !h!.manager.tools(cfg.id).some((t) => t.original === 'late'));
  });

  it('applies enabledTools and disabledTools to listing and calls', async () => {
    h = harness();
    const cfg = stdioConfig({
      name: 'lists',
      enabledTools: ['echo', 'add', 'write_note'],
      disabledTools: ['mcp:lists.write_note'],
    });
    await h.manager.add(cfg);
    const exposed = h.manager.exposedTools(cfg.accountId).map((t) => t.original);
    expect(exposed).toEqual(['echo', 'add']);
    // The settings list still shows every tool, with whether it is exposed.
    expect(
      h.manager
        .tools(cfg.id)
        .filter((t) => !t.exposed)
        .map((t) => t.original),
    ).toEqual(['write_note', 'slow', 'purchase_item']);
    expect(await h.manager.callTool(cfg.id, 'write_note', { name: 'a', text: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'mcp.tool_disabled' },
    });
    // Changing the lists takes effect without a relaunch.
    const changes = h.toolChanges.length;
    await h.manager.update({ ...cfg, enabledTools: null, disabledTools: ['slow'] });
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    expect(h.toolChanges.length).toBe(changes + 1);
    expect(h.manager.exposedTools(cfg.accountId).map((t) => t.original)).not.toContain('slow');
    expect(h.manager.exposedTools('another-account')).toEqual([]);
  });

  it('marks only the tools the owner declared read-only, never from server hints (FR-082)', async () => {
    h = harness();
    // echo and add carry the server's readOnlyHint; neither hint makes them read-only.
    const cfg = stdioConfig({ name: 'cal' });
    await h.manager.add(cfg);
    const marked = () =>
      h!.manager
        .tools(cfg.id)
        .filter((t) => t.descriptor.userReadOnly === true)
        .map((t) => t.original);
    expect(marked()).toEqual([]);
    expect(h.manager.tools(cfg.id).every((t) => !('userReadOnly' in t.descriptor))).toBe(true);
    // The owner's list matches like the tool lists: the server's name, the segment or the
    // canonical name; a change re-lists the tools without a relaunch.
    const changes = h.toolChanges.length;
    const starts = h.statuses.filter((s) => s.status === 'starting').length;
    await h.manager.update({ ...cfg, readOnlyTools: ['echo', 'mcp:cal.add', 'nope'] });
    expect(h.toolChanges.length).toBe(changes + 1);
    expect(h.statuses.filter((s) => s.status === 'starting').length).toBe(starts);
    expect(marked()).toEqual(['echo', 'add']);
    const exposed = h.manager.exposedTools(cfg.accountId);
    expect(exposed.find((t) => t.original === 'echo')!.descriptor.userReadOnly).toBe(true);
    expect(exposed.find((t) => t.original === 'write_note')!.descriptor.userReadOnly).toBe(
      undefined,
    );
    // The same list again changes nothing; removing it clears the marks.
    await h.manager.update({ ...cfg, readOnlyTools: ['echo', 'mcp:cal.add', 'nope'] });
    expect(h.toolChanges.length).toBe(changes + 1);
    await h.manager.update({ ...cfg, readOnlyTools: [] });
    expect(h.toolChanges.length).toBe(changes + 2);
    expect(marked()).toEqual([]);
    // A config without the field (a plugin's server) declares nothing.
    await h.manager.update({ ...cfg, readOnlyTools: ['echo'] });
    await h.manager.update(stdioConfig({ id: cfg.id, name: 'cal' }));
    expect(marked()).toEqual([]);
  });

  it('restarts a crashed server with backoff', async () => {
    h = harness({ backoff: { baseMs: 50, maxMs: 1000 } });
    const cfg = stdioConfig({}, ['--test-hooks']);
    await h.manager.add(cfg);
    await h.manager.callTool(cfg.id, 'crash', {});
    await waitFor(() => h!.manager.state(cfg.id)!.status === 'error', 5000, 'error status');
    expect(h.manager.state(cfg.id)!.lastError).toBe('the server closed the connection');
    expect(h.manager.exposedTools(cfg.accountId)).toEqual([]);
    expect(await h.manager.callTool(cfg.id, 'echo', { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'mcp.unavailable' },
    });
    await waitFor(() => h!.manager.state(cfg.id)!.status === 'connected', 5000, 'reconnect');
    expect(h.manager.state(cfg.id)!.restarts).toBe(1);
    expect(h.manager.state(cfg.id)!.lastError).toBeNull();
    expect(await h.manager.callTool(cfg.id, 'echo', { text: 'back' })).toMatchObject({ ok: true });
    const log = h.manager.logs(cfg.id).map((l) => l.text);
    expect(log).toContain('crashing');
    expect(log.some((l) => /restarting in 50 ms/.test(l))).toBe(true);
  });

  it('gives up after 5 restarts in the window until a manual restart', async () => {
    h = harness({ backoff: { baseMs: 10, maxMs: 40 } });
    const cfg = stdioConfig({}, ['--exit-on-start', '3']);
    await h.manager.add(cfg);
    await waitFor(
      () => /gave up after 5 restarts/.test(h!.manager.state(cfg.id)!.lastError ?? ''),
      15_000,
      'give up',
    );
    const s = h.manager.state(cfg.id)!;
    expect(s.status).toBe('error');
    expect(s.restarts).toBe(5);
    const starts = h.statuses.filter((x) => x.status === 'starting').length;
    expect(starts).toBe(6);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.statuses.filter((x) => x.status === 'starting').length).toBe(6);
    expect(
      h.manager.logs(cfg.id).some((l) => l.stream === 'stderr' && l.text === 'exiting on start'),
    ).toBe(true);
    // A manual restart forgets the earlier restarts and tries again.
    await h.manager.restart(cfg.id);
    expect(h.statuses.filter((x) => x.status === 'starting').length).toBeGreaterThan(6);
  });

  it('refuses a server that speaks an older protocol, naming both versions', async () => {
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = stdioConfig({}, ['--protocol', '2025-06-18']);
    await h.manager.add(cfg);
    const s = h.manager.state(cfg.id)!;
    expect(s.status).toBe('error');
    expect(s.lastError).toBe(
      'the server speaks MCP protocol 2025-06-18; Nova supports 2025-11-25 or later',
    );
  });

  it('reports a missing command and a startup timeout', async () => {
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const missing = stdioConfig({ command: 'nova-no-such-command-xyz', args: [] });
    await h.manager.add(missing);
    expect(h.manager.state(missing.id)!.lastError).toBe(
      'command not found: nova-no-such-command-xyz',
    );
    const silent = stdioConfig({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      startupTimeoutMs: 1000,
    });
    await h.manager.add(silent);
    expect(h.manager.state(silent.id)!.lastError).toBe('did not start within 1000 ms');
  });

  it('launches with secrets from the store and keeps them out of logs, state and events', async () => {
    h = harness();
    const secret = 'sk-test-abcdefghijklmnopqrstuv';
    h.secrets.set('secret://mcp/s1/env/API_KEY', secret);
    const dataDir = mkdtempSync(join(tmpdir(), 'nova-mcp-'));
    dirs.push(dataDir);
    await h.manager.close();
    h = harness({ workDir: join(dataDir, 'mcp') });
    h.secrets.set('secret://mcp/s1/env/API_KEY', secret);
    const cfg = stdioConfig(
      { id: 's1', env: { API_KEY: 'secret://mcp/s1/env/API_KEY', PLAIN: 'visible-value' } },
      ['--print-env', 'API_KEY'],
    );
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    const lines = h.manager.logs(cfg.id);
    expect(lines.some((l) => l.text === 'env API_KEY=[REDACTED]')).toBe(true);
    const everything = JSON.stringify([lines, h.statuses, h.sink.records, h.manager.states()]);
    expect(everything).not.toContain(secret);
    // The stdio server runs in its own 0700 working directory.
    const cwd = join(dataDir, 'mcp', 's1');
    expect(existsSync(cwd)).toBe(true);
    expect(statSync(cwd).mode & 0o777).toBe(0o700);
  });

  it('fails closed when a referenced secret is missing', async () => {
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = stdioConfig({ env: { TOKEN: 'secret://mcp/x/env/TOKEN' } });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)).toMatchObject({
      status: 'error',
      lastError: 'the secret for environment variable TOKEN is missing',
    });
  });

  it('disables, re-enables, relaunches on changes and removes servers', async () => {
    h = harness();
    const cfg = stdioConfig({ enabled: false });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('disabled');
    expect(h.manager.exposedTools(cfg.accountId)).toEqual([]);
    await h.manager.update({ ...cfg, enabled: true });
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    const startsBefore = h.statuses.filter((s) => s.status === 'starting').length;
    await h.manager.update({ ...cfg, enabled: true, args: [...cfg.args, '--tools', '2'] });
    expect(h.statuses.filter((s) => s.status === 'starting').length).toBe(startsBefore + 1);
    expect(h.manager.state(cfg.id)!.counts.tools).toBe(7);
    await h.manager.update({ ...cfg, enabled: false });
    expect(h.manager.state(cfg.id)).toMatchObject({ status: 'disabled', lastError: null });
    expect(await h.manager.remove(cfg.id)).toBe(true);
    expect(h.manager.state(cfg.id)).toBeNull();
    expect(await h.manager.remove(cfg.id)).toBe(false);
  });

  it('stays connected after the startup deadline has passed', async () => {
    h = harness();
    const cfg = stdioConfig({ startupTimeoutMs: 1000 });
    await h.manager.add(cfg);
    await new Promise((r) => setTimeout(r, 1300));
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    expect(await h.manager.callTool(cfg.id, 'echo', { text: 'later' })).toMatchObject({
      ok: true,
    });
  });

  it('takes the many-tools count from the environment too', async () => {
    h = harness();
    const cfg = stdioConfig({ env: { NOVA_TEST_MCP_TOOLS: '3' } });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.counts.tools).toBe(8);
  });

  it('serves the many-tools mode with distinct descriptions', async () => {
    h = harness();
    const cfg = stdioConfig({}, ['--tools', '50']);
    await h.manager.add(cfg);
    const tools = h.manager.tools(cfg.id);
    expect(tools).toHaveLength(55);
    const extra = tools.filter((t) => t.original.startsWith('extra_'));
    expect(new Set(extra.map((t) => t.descriptor.description)).size).toBe(50);
    expect(tools.find((t) => t.original === 'extra_042')!.descriptor.description).toBe(
      'Look up the weather forecast for a city',
    );
    expect(extra.filter((t) => /weather|forecast/i.test(t.descriptor.description))).toHaveLength(1);
  });

  it('offers tools as a tool source with handlers that call the server', async () => {
    h = harness();
    const cfg = stdioConfig({ name: 'src', disabledTools: ['slow'] });
    await h.manager.add(cfg);
    const source = new McpToolSource(h.manager);
    expect(source.source).toBe('mcp');
    const defs = await source.list(cfg.accountId);
    expect(defs.map((d) => d.descriptor.name)).not.toContain('mcp:src.slow');
    const echo = defs.find((d) => d.descriptor.name === 'mcp:src.echo')!;
    const r = await echo.handler({ text: 'via source' }, { signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: true, content: [{ type: 'text', text: 'via source' }] });
    expect(await source.list('nobody')).toEqual([]);
  });

  it('reads a resource', async () => {
    h = harness();
    const cfg = stdioConfig();
    await h.manager.add(cfg);
    expect(await h.manager.readResource(cfg.id, 'note://readme')).toMatchObject({
      ok: true,
      content: [{ type: 'text', text: '[resource note://readme]\nNova test server' }],
    });
    expect(await h.manager.readResource('gone', 'note://readme')).toMatchObject({ ok: false });
  });

  it('stops every server on close', async () => {
    h = harness();
    const a = stdioConfig();
    await h.manager.add(a);
    await h.manager.close();
    expect(h.manager.state(a.id)!.status).toBe('stopped');
    await h.manager.add(stdioConfig());
    expect(h.manager.states()).toHaveLength(1);
  });
});
