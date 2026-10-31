// The diagnostics bundle (Amendment 2026-10-31-B Part 6): redacted by construction. A canary secret
// is planted in every place Nova keeps one, and personal content in every place it keeps that; the
// bundle must hold none of them, in plain, case-folded, base64, base64url, hex or URL-encoded form,
// and must still hold the facts that make it useful. Neutral placeholders; temp homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scrubber, buildDiagnostics, createCore, diagnosticsRoutes, formsOf, DIAGNOSTICS_MARKER as MARKER } from '../../src/core/index.ts';

// Every form a planted value could take, for the search.
export function anyForm(text: string, value: string): string | null {
  const low = text.toLowerCase();
  const forms = [value, value.toLowerCase(), encodeURIComponent(value), Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex')];
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value)) { const raw = Buffer.from(value, 'base64'); forms.push(raw.toString('hex'), raw.toString('base64url')); }
  return forms.filter((f) => f.length >= 6).find((f) => low.includes(f.toLowerCase())) ?? null;
}

const C = (n: string) => `canary-${n}-7f3a91c2e8b4`;

test('the scrubber: keys that name secrets, every known value in every form, and secret-shaped strings', () => {
  const s = new Scrubber(['example-secret-value-1234', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVg=='], [['/home/example-user/Nova', '<home>']]);
  const out = s.any({
    api_key: 'anything at all', token: 42, session_id: 'x', password: null, public_note: 'fine',
    nested: [{ msg: `value EXAMPLE-SECRET-VALUE-1234 and ${Buffer.from('example-secret-value-1234').toString('base64')} and ${encodeURIComponent('example-secret-value-1234')}` }],
    raw: Buffer.from('QUJDREVGR0hJSktMTU5PUFFSU1RVVg==', 'base64').toString('hex'),
    shapes: 'Authorization: Bearer abcdef123456 and https://user:pw-1234@example.com/x?token=t0k3n123&ok=1 and sk-abcdefghijklmnop and eyJabcdefgh.eyJabcdefgh.abcdefghij and secret://EXAMPLE_KEY',
    path: '/home/example-user/Nova/logs/nova.log',
  }) as Record<string, unknown>;
  assert.equal(out.api_key, MARKER);
  assert.equal(out.token, MARKER);
  assert.equal(out.session_id, MARKER);
  assert.equal(out.password, null, 'nothing to hide is left as it is');
  assert.equal(out.public_note, 'fine');
  const text = JSON.stringify(out);
  for (const v of ['example-secret-value-1234', 'abcdef123456', 'pw-1234', 't0k3n123', 'sk-abcdefghijklmnop', 'eyJabcdefgh', 'EXAMPLE_KEY', 'example-user']) assert.ok(!anyForm(text, v), `${v} survived: ${text}`);
  assert.ok(!text.includes(Buffer.from('QUJDREVGR0hJSktMTU5PUFFSU1RVVg==', 'base64').toString('hex')));
  assert.match(text, /ok=1/);
  assert.match(String(out.path), /^<home>\/logs\/nova\.log$/);
  assert.ok(s.keys >= 3 && s.values >= 5);
  assert.ok(formsOf('ab').length === 0, 'values too short to mean anything aren’t hunted');
});

test('the bundle holds no canary from anywhere Nova keeps a secret, no personal content, and still says what is going on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-diag-'));
  const work = mkdtempSync(join(tmpdir(), 'nova-diag-user-'));
  mkdirSync(join(work, 'example-project'));
  writeFileSync(join(work, 'example-project', 'main.tf'), 'terraform {}\n');
  const ENV = 'NOVA_SECRET_EXAMPLE_ENV';
  const before = process.env[ENV];
  process.env[ENV] = C('env-fallback');
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, secrets: (n) => process.env[`NOVA_SECRET_${n}`] ?? null, infra: { userHome: work } });
  try {
    const planted: Record<string, string> = {};
    const put = (what: string, name: string, value: string) => { core.vault.put(name, value); planted[what] = value; };
    // 1. The vault, generic.
    put('vault', 'provider/EXAMPLE_TOKEN', C('vault'));
    // 2. A provider's API key (a secret:// reference, its value in the vault).
    put('provider key', 'provider/EXAMPLE_PROVIDER_KEY', C('provider-key'));
    core.providers.configure('openai-compatible', { base_url: 'http://127.0.0.1:9/v1', model: 'example-model', api_key: 'secret://EXAMPLE_PROVIDER_KEY' });
    // 3. The cloud model's key.
    put('cloud model key', 'provider/EXAMPLE_CLOUD_KEY', C('cloud-key'));
    core.models.setCloud({ name: 'Example cloud', base_url: 'https://cloud.example.com/v1', model: 'example-cloud', api_key: 'secret://EXAMPLE_CLOUD_KEY' }, true);
    // 4. A connector token (Home Assistant) and 5. Gmail's saved sign-in, a JSON value.
    put('connector token', 'connector/home-assistant/TOKEN', C('ha-token'));
    core.vault.put('connector/gmail/oauth', JSON.stringify({ access_token: C('gmail-access'), refresh_token: C('gmail-refresh') }));
    planted['gmail access token'] = C('gmail-access');
    planted['gmail refresh token'] = C('gmail-refresh');
    // 6. The Screenpipe API key.
    const src = core.capture.addScreenpipe({ url: 'http://127.0.0.1:9' });
    core.capture.configure(src.id, { api_key: C('screenpipe-key') });
    planted['screenpipe key'] = C('screenpipe-key');
    // 7. An M10d network target's token and 8. an infrastructure project's secret.
    const target = core.network.createTarget({ name: 'Example router', kind: 'router', url: 'https://192.0.2.1' });
    core.network.setToken(target.id, C('network-token'));
    planted['network token'] = C('network-token');
    const project = core.infra.createProject({ name: 'Example project', folder: join(work, 'example-project'), budget_usd_month: 10, prices: {}, secrets: ['CLOUD_TOKEN'] });
    core.infra.setSecret(project.id, 'CLOUD_TOKEN', C('infra-secret'));
    planted['infra secret'] = C('infra-secret');
    // 9. A browser sign-in, 10. the backup recovery key, 11. the decision service's cloud key.
    put('browser sign-in', 'browser/login/example.com/password', C('browser-password'));
    put('backup key', 'nova/backup-key', C('backup-key'));
    put('decision service key', 'decision/JEV_KEY', C('jev-key'));
    // 12. An n8n callback token (shown once, kept hashed) and its signing secret.
    const n8n = core.providers.configure('n8n', { webhook_url: 'https://n8n.example.com/webhook/example' }, { confirm: true });
    put('n8n signing secret', 'provider/N8N_SIGNING_SECRET', C('n8n-signing'));
    assert.ok(n8n.token, 'n8n hands out its callback token once');
    planted['n8n callback token'] = n8n.token!;
    // 13. An environment fallback (NOVA_SECRET_<NAME>).
    planted['environment fallback'] = C('env-fallback');
    // 14. The mesh identity's private keys and 15. the vault's own key.
    const id = JSON.parse(readFileSync(join(home, 'mesh', 'identity.json'), 'utf8')) as Record<string, { private?: string }>;
    planted['mesh ed25519 private key'] = id.ed25519!.private!;
    planted['mesh x25519 private key'] = id.x25519!.private!;
    planted['vault key'] = readFileSync(join(home, 'vault', 'key')).toString('base64');
    // 16. Secrets in log lines: one only the environment knows, one in a Bearer header.
    core.log.write('info', 'example', `connected with ${C('env-fallback')}`);
    core.log.write('warn', 'example', `the service said no to Authorization: Bearer ${C('bearer-only')}`);
    planted['bearer in a log'] = C('bearer-only');
    // 17. A secret in a problem's detail (a URL's credentials, a token parameter).
    core.log.problem('example', 'A call to the example service failed.', { detail: `GET https://user:${C('url-password')}@example.com/x?token=${C('url-token')}` });
    planted['password in a URL'] = C('url-password');
    planted['token in a URL'] = C('url-token');

    // Personal content: a memory, captured screen text, a task's title and goal, the person's name.
    const personal: Record<string, string> = {
      memory: 'Prefers the blue notebook for example-project notes',
      captured: 'Example captured line about a private example letter',
      'task title': 'Example personal errand title',
      'task goal': 'Example personal errand goal text',
      'person’s name': 'Example Person Name',
    };
    core.memory.remember({ kind: 'fact', content: personal.memory!, recorded_by: 'person' });
    core.capture.enable(src.id, { by: 'person', since: new Date(Date.now() - 60_000).toISOString() });
    core.capture.ingest(src.id, [{ external_id: 'e1', kind: 'screen', at: new Date().toISOString(), app: 'Editor', window_title: 'notes', text: personal.captured! }], 'api');
    core.profile.set('user', 'name', personal['person’s name']!, 'settings');
    core.ledger.create({ title: personal['task title']!, owner: 'workspace', goal: personal['task goal']!, origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'workspace/example.md' }] });

    const bundle = await buildDiagnostics(core, { home, version: '0.1.0', commit: 'abc1234', instance: 'preview', era2: () => ({ conversations: 3, schedules: 1 }) });
    const text = JSON.stringify(bundle);
    // None of the planted secrets, in any form.
    const found = Object.entries(planted).map(([what, v]) => [what, anyForm(text, v)]).filter(([, f]) => f);
    assert.deepEqual(found, [], 'a planted secret survived');
    assert.ok(Object.keys(planted).length >= 20);
    // No personal content.
    for (const [what, v] of Object.entries(personal)) assert.ok(!text.toLowerCase().includes(v.toLowerCase()), `${what} is in the bundle`);
    assert.ok(!text.includes(home), 'the home path is shown as <home>');

    // Still useful: versions, every health check, counts, states, names.
    const b = bundle as Record<string, any>;
    assert.equal(b.format, 'nova-diagnostics');
    assert.equal(b.about.nova, '0.1.0');
    assert.equal(b.about.build, 'abc1234');
    assert.deepEqual(Object.keys(b.health.checks), Object.keys(core.health().checks));
    assert.equal(b.work.memory.active, 1);
    assert.equal(b.work.era2.conversations, 3);
    assert.ok(b.vault.stored >= 10 && b.vault.by_kind.connector === 2);
    assert.ok(b.providers.some((p: { id: string }) => p.id === 'openai-compatible'));
    assert.equal(b.providers.find((p: { id: string }) => p.id === 'openai-compatible').config.api_key, MARKER);
    assert.equal(b.capture.sources[0].has_api_key, true);
    assert.equal(b.capture.status.unclassified + b.capture.status.today >= 1, true);
    assert.equal(b.network.targets[0].name, 'Example router');
    assert.equal(b.network.targets[0].token, true, 'whether a token is saved, never the token');
    assert.equal(b.infra.projects[0].name, 'Example project');
    assert.equal(b.config.user.name, MARKER);
    assert.ok(b.logs.length >= 2 && b.logs.some((l: { msg: string }) => /Bearer \*\*REDACTED\*\*/.test(l.msg)));
    assert.ok(b.problems.some((p: { message: string }) => p.message === 'A call to the example service failed.'));
    assert.equal(b.redaction.marker, MARKER);
    assert.match(b.redaction.rule, /never content/);
    assert.deepEqual(b.redaction.warnings, []);
    assert.ok(b.redaction.keys_redacted > 0 && b.redaction.values_redacted > 0);

    // The route: an attachment, built for the request, kept nowhere.
    const before2 = readdirSync(home).sort();
    const [route] = diagnosticsRoutes(() => buildDiagnostics(core, { home, version: '0.1.0' }), () => new Date('2026-10-31T14:05:00Z'));
    assert.equal(`${route!.method} ${route!.path}`, 'GET /diagnostics');
    const reply = await route!.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: {} as never }) as { body: unknown; headers: Record<string, string> };
    assert.equal(reply.headers['content-disposition'], 'attachment; filename="nova-diagnostics-2026-10-31-1405.json"');
    assert.deepEqual(Object.entries(planted).map(([w, v]) => [w, anyForm(JSON.stringify(reply.body), v)]).filter(([, f]) => f), []);
    assert.deepEqual(readdirSync(home).sort(), before2, 'nothing new is written to the home');
  } finally {
    await core.close();
    if (before === undefined) delete process.env[ENV]; else process.env[ENV] = before;
  }
});

test('Nova has no way to send the bundle anywhere: the builder imports no network module and writes no file', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'diagnostics', 'index.ts'), 'utf8');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../api.ts', '../index.ts', 'node:fs', 'node:os', 'node:path']);
  assert.doesNotMatch(src, /\bfetch\(|writeFile|appendFile|createWriteStream|node:http|node:net|node:child_process/);
});
