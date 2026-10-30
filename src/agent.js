// Runs the configured agent_cmd once: system prompt in a file, conversation on
// stdin, text streamed back. Understands plain text output and Claude Code's
// stream-json; anything else that prints text works too.
import { spawn } from 'node:child_process';
import { trackChild } from './core/index.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class AgentError extends Error {
  constructor(message, detail = '') { super(message); this.detail = detail; }
}

// Nova's files are the agent's only memory. When Nova itself runs inside a
// Claude Code session, that session's memory, extra CLAUDE.md folders and the
// signed-in account's email arrive through the environment; strip them so
// they can't leak in. (A real run signed a draft with a name only that email held.)
const LEAKY = /^CLAUDE\w*(MEMORY|ADDITIONAL_DIRECTORIES|CLAUDE_MD|USER_EMAIL)/;
export function agentEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !LEAKY.test(k)));
}

export function runAgent({ cmd, system, prompt, signal, onText = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-'));
  const systemFile = join(dir, 'system.md');
  let input = prompt;
  if (cmd.includes('{system_file}')) writeFileSync(systemFile, system);
  else input = `${system}\n\n${prompt}`;
  const command = cmd.replaceAll('{system_file}', `'${systemFile}'`);

  return new Promise((resolve, reject) => {
    const child = trackChild(spawn('/bin/sh', ['-c', command], { cwd: dir, env: agentEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }), { group: true });
    let mode = null; // 'json' | 'text'
    let buf = '';
    let text = '';
    let streamed = false;
    let failure = null;
    let stderr = '';
    let aborted = false;
    let finished = false;
    let settled = false;

    // Claude Code can take seconds to exit after the reply ends; don't make
    // the conversation wait for its housekeeping.
    const done = () => { finished = true; finish(0); try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const emit = (t) => { if (t) { text += t; onText(t); } };
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { emit(`${line}\n`); return; }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        streamed = true;
        emit(ev.event.delta.text);
      } else if (ev.type === 'stream_event' && ev.event?.type === 'message_stop' && streamed && text.trim()) {
        done(); // the reply is complete
      } else if (ev.type === 'assistant' && !streamed && !ev.parent_tool_use_id) {
        emit((ev.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
      } else if (ev.type === 'result') {
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) failure = String(ev.result || ev.subtype || 'the model returned an error');
        else if (text.trim()) done();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (!mode) mode = d.trimStart().startsWith('{') ? 'json' : 'text';
      if (mode === 'text') { emit(d); return; }
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

    const kill = () => { aborted = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    if (signal?.aborted) kill();
    signal?.addEventListener('abort', kill, { once: true });

    child.stdin.on('error', () => {}); // the command may exit before reading everything
    child.stdin.end(input);

    child.on('error', (e) => { settled = true; reject(new AgentError('Nova could not start its model command.', e.message)); });
    child.on('close', (code) => {
      if (buf) onLine(buf);
      finish(code);
    });

    function finish(code) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', kill);
      rmSync(dir, { recursive: true, force: true });
      if (finished) return resolve({ text, aborted: false });
      if (aborted) return resolve({ text, aborted: true });
      const program = cmd.trim().split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? cmd.trim();
      if (code === 127) return reject(new AgentError(`Nova couldn't find \`${program}\`. Check that it's installed and on your PATH, or set agent_cmd in nova.config.json.`, stderr.trim()));
      if (failure) return reject(new AgentError('The model ran into a problem and stopped.', failure));
      if (code !== 0 && !text) return reject(new AgentError(`\`${program}\` exited before replying.`, stderr.trim() || `exit code ${code}`));
      if (!text.trim()) return reject(new AgentError('The model finished without saying anything.', stderr.trim()));
      resolve({ text, aborted: false });
    }
  });
}
