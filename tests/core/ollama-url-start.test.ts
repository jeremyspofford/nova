// A local model address given by host name (F-046): Nova refuses it in one plain "Nova didn't start"
// line that names NOVA_OLLAMA_URL and the forms it takes, with no stack trace, before anything is
// connected to. Which addresses count as local doesn't change: localhost, loopback and private IP
// addresses are taken; a name or a public address is not. No model server is needed or contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, ollamaUrlFrom } from '../../src/config.js';
import { localOllamaUrl as localUrl } from '../../src/core/index.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('the accepted forms are unchanged: localhost, loopback and a private address; a name or a public address is refused', () => {
  for (const ok of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://192.168.1.50:11434', 'http://10.0.0.7:11434']) assert.equal(ollamaUrlFrom(ok, localUrl), ok, ok);
  for (const bad of ['http://ollama:11434', 'http://gpu-box.local:11434', 'https://ollama.com', 'http://8.8.8.8:11434']) {
    assert.throws(() => ollamaUrlFrom(bad, localUrl), (e: Error) => e instanceof ConfigError && /^NOVA_OLLAMA_URL is /.test(e.message) && /localhost or a loopback or private IP address/.test(e.message), bad);
  }
  assert.throws(() => ollamaUrlFrom('not an address', localUrl), /NOVA_OLLAMA_URL isn't an address/);
});

test('npm start with a host-name Ollama address: one plain line naming the setting, no stack trace, exit 1', () => {
  for (const url of ['http://ollama:11434', 'http://gpu-box.local:11434']) {
    const dir = mkdtempSync(join(tmpdir(), 'nova-ollama-url-'));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'src', 'server.js')], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: dir, NOVA_HOME: join(dir, 'home'), NOVA_VAULT_KEY: 'file', NOVA_PORT: '0', NOVA_OLLAMA_URL: url },
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`^Nova didn't start: NOVA_OLLAMA_URL is ${url.replace(/[.:/]/g, '\\$&')}, and Nova can't tell`));
      assert.match(r.stderr, /It takes localhost or a loopback or private IP address/);
      assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
      assert.equal(r.stderr.trim().split('\n').length, 1, 'one line');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
