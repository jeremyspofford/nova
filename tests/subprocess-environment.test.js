// Exercise real child processes below a disposable parent, never the owner's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { childEnv } from '../src/core/providers/cli.ts';

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// Removing an env filter from any launch must make that path's test fail, including for a
// previously unknown key. A fake model only prints selected fixture fields; no CLI auth runs.
for (const path of ['exec', 'agent', 'provider-default', 'provider-childEnv']) {
  test(`${path}: subprocess inherits public metadata and no private parent canaries`, () => {
    const home = mkdtempSync(join(tmpdir(), 'nova-env-'));
    try {
      const innocent = `WEATHER_${randomUUID().replaceAll('-', '')}`;
      const canaries = Object.fromEntries([
        innocent, 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_MESH_NAME_TOKEN',
        'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
        'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY',
        'CLAUDE_CODE_MEMORY_DIR', 'CLAUDE_CODE_USER_EMAIL', 'SSH_AUTH_SOCK',
        'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT',
      ].map((k) => [k, `synthetic-${k}`]));
      // Valid, harmless runtime injection values, installed only after the parent starts.
      Object.assign(canaries, { NODE_OPTIONS: '--stack-trace-limit=17', BASH_ENV: join(home, 'startup.sh'), ENV: join(home, 'startup.sh'), ZDOTDIR: home });
      writeFileSync(join(home, 'startup.sh'), 'export STARTUP_SECRET=synthetic-startup\n');
      for (const file of ['.profile', '.bash_profile', '.zprofile', '.zshenv']) {
        writeFileSync(join(home, file), 'export STARTUP_SECRET=synthetic-startup\n');
      }
      // Model a shell that loads a private startup file even for -c (like zsh's .zshenv).
      // This fixture keeps the regression portable without requiring zsh on CI.
      const shell = join(home, 'fixture-shell');
      writeFileSync(shell, `#!/bin/sh\n. ${quote(join(home, 'startup.sh'))}\nif [ "$1" = '-lc' ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh "$@"\n`, { mode: 0o700 });
      const publicEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', TZ: 'UTC', TMPDIR: home };
      const keys = [...Object.keys(publicEnv), ...Object.keys(canaries), 'STARTUP_SECRET'];
      const probe = join(home, 'fake-agent.mjs');
      writeFileSync(probe, `console.log('ENV:' + JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))));`);
      const command = `${quote(process.execPath)} ${quote(probe)}`;
      const parent = join(home, 'parent.mjs');
      writeFileSync(parent, `
        import { runCommand } from ${JSON.stringify(new URL('../src/tools.js', import.meta.url).href)};
        import { runAgent } from ${JSON.stringify(new URL('../src/agent.js', import.meta.url).href)};
        import { runLines, childEnv } from ${JSON.stringify(new URL('../src/core/providers/cli.ts', import.meta.url).href)};
        Object.assign(process.env, ${JSON.stringify(canaries)});
        process.env.SHELL = ${JSON.stringify(shell)};
        let output = '';
        if (${JSON.stringify(path)} === 'exec') output = await runCommand(${JSON.stringify(command)}, { cwd: ${JSON.stringify(home)} });
        else if (${JSON.stringify(path)} === 'agent') output = (await runAgent({ cmd: ${JSON.stringify(command)}, system: 'fixture', prompt: 'fixture' })).text;
        else {
          const result = await runLines({ argv: ${JSON.stringify([process.execPath, probe])}, cwd: ${JSON.stringify(home)}, ${path === 'provider-childEnv' ? 'env: childEnv(),' : ''} onLine: line => { output += line + '\\n'; } });
          if (result.code !== 0) throw new Error('fake provider failed: ' + result.stderr);
        }
        console.log(output);
      `);
      const output = execFileSync(process.execPath, [parent], { cwd: home, env: publicEnv, encoding: 'utf8', timeout: 15_000 });
      const line = output.split('\n').find((s) => s.startsWith('ENV:'));
      assert.ok(line, 'real child returned selected fields');
      const seen = JSON.parse(line.slice(4));
      assert.deepEqual(Object.fromEntries(Object.keys(publicEnv).map((k) => [k, seen[k]])), publicEnv);
      const leaked = [...Object.keys(canaries), 'STARTUP_SECRET'].filter((k) => seen[k] !== null);
      assert.deepEqual(leaked, [], `private fields reached ${path}: ${leaked.join(', ')}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('provider explicit extras remain trusted, separate from inherited parent data', () => {
  assert.deepEqual(childEnv({ OPENAI_API_KEY: 'explicit-synthetic', HOME: '/explicit' }, { HOME: '/parent', OPENAI_API_KEY: 'parent-synthetic', UNKNOWN_SETTING: 'private' }), {
    HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic',
  });
});
