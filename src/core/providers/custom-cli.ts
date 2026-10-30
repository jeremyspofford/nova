// Era 2's agent_cmd (NOVA_AGENT_CMD) as a provider. For chat, Era 2's own runner keeps running it
// exactly as before (src/agent.js); this is the same command doing a brief: the instruction in a
// file whose path replaces {system_file} (or ahead of the brief on stdin), the brief on stdin, run
// in the task's folder. Its output, plain text or Claude Code's stream-json, is read against the
// JSON files contract, so Nova applies the changes itself.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, runLines, tail, which, words } from './cli.ts';
import { num, str, type Config, type Impl, type WorkInput, type WorkOutcome } from './types.ts';

// The program a command line runs, skipping VAR=value settings in front of it.
export const programOf = (command: string) => words(command).find((w) => !/^\w+=/.test(w)) ?? '';

export const customCli: Impl = {
  id: 'custom-cli',
  check(c: Config) {
    const out: string[] = [];
    if (!str(c.command)) out.push('command is the model command (agent_cmd).');
    if (!['none', 'local', 'remote'].includes(c.egress as string)) out.push('egress is none, local or remote: where the command sends what it is given.');
    return out;
  },
  unconfigured: (c) => (str(c.command) ? null : 'It needs a model command (agent_cmd in nova.config.json).'),
  uninstalled(c) {
    const program = programOf(str(c.command));
    // A shell built-in or a path relative to where Nova runs can't be judged without running it.
    if (!program || (!program.startsWith('/') && program.includes('/'))) return null;
    return ['node', 'sh', 'bash', 'env'].includes(program) || which(program) ? null : `Nova can’t find \`${program}\` on this computer.`;
  },
  model: (c) => {
    const p = programOf(str(c.command)).split('/').pop() ?? '';
    return p.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'model';
  },
  async work(i: WorkInput): Promise<WorkOutcome> {
    const command = str(i.config.command);
    mkdirSync(i.stateDir, { recursive: true });
    const systemFile = join(i.stateDir, 'system.md');
    let input = i.prompt;
    if (command.includes('{system_file}')) writeFileSync(systemFile, i.system);
    else input = `${i.system}\n\n${i.prompt}`;
    const quoted = `'${systemFile.replaceAll("'", "'\\''")}'`;
    let text = '';
    let streamed = false;
    let failure: string | null = null;
    let ran;
    try {
      ran = await runLines({
        argv: [command.replaceAll('{system_file}', quoted)], shell: true, cwd: i.cwd!, input, env: childEnv(), signal: i.signal, timeoutMs: num(i.config.timeout_s, 1800) * 1000,
        onLine: (line) => {
          let ev: Record<string, any> | null = null;
          if (line.trimStart().startsWith('{')) { try { ev = JSON.parse(line); } catch { ev = null; } }
          if (!ev || typeof ev.type !== 'string') { text += `${line}\n`; return; }
          if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') { streamed = true; text += ev.event.delta.text; }
          else if (ev.type === 'assistant' && !streamed) text += (ev.message?.content ?? []).filter((x: { type?: string }) => x.type === 'text').map((x: { text: string }) => x.text).join('');
          else if (ev.type === 'result' && (ev.is_error || (ev.subtype && ev.subtype !== 'success'))) failure = String(ev.result || ev.subtype);
          else if (ev.type !== 'result' && ev.type !== 'system' && ev.type !== 'user' && ev.type !== 'stream_event' && ev.type !== 'assistant') text += `${line}\n`;
        },
      });
    } catch (e) {
      return { status: 'failed', summary: `Nova couldn’t start the model command: ${(e as Error).message}`, usage: {} };
    } finally {
      rmSync(systemFile, { force: true });
    }
    const usage = { model: customCli.model(i.config) };
    if (ran.timedOut) return { status: 'failed', summary: 'The model command took too long and was stopped.', usage };
    if (failure) return { status: 'failed', summary: `The model command reported a problem: ${failure}`, usage };
    if (ran.code === 127) return { status: 'failed', summary: `Nova couldn’t find \`${programOf(command)}\`.`, usage };
    if (ran.code !== 0 && !text.trim()) return { status: 'failed', summary: `The model command exited (${ran.code ?? ran.signal}) before replying.${ran.stderr.trim() ? ` It said: ${tail(ran.stderr, 3, 300)}` : ''}`, usage };
    return { status: 'done', summary: '', reply: text, usage };
  },
};
