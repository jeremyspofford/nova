// Codex as a coding agent (ADR-8). Nova starts `codex exec --json` in the task's folder with the
// brief on stdin (the prompt `-`), sandboxed to that folder, and reads its JSON Lines events:
// thread.started, turn.started, item.started / item.updated / item.completed (agent_message,
// reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list),
// turn.completed (with usage), turn.failed and error.
import { childEnv, runLines, tail, which, words } from './cli.ts';
import { summarize } from './prompt.ts';
import { num, str, type Config, type Impl, type WorkInput, type WorkOutcome } from './types.ts';

const SANDBOXES = ['read-only', 'workspace-write'];

export const codex: Impl = {
  id: 'codex',
  check(c: Config) {
    const out: string[] = [];
    if (!str(c.command)) out.push('command is the codex program, or its full path.');
    if (c.sandbox !== undefined && !SANDBOXES.includes(c.sandbox as string)) out.push(`sandbox is one of ${SANDBOXES.join(', ')}; Nova never lets Codex outside the task’s folder.`);
    if (c.model !== undefined && typeof c.model !== 'string') out.push('model is a model name, or empty for Codex’s default.');
    return out;
  },
  unconfigured: (c) => (str(c.command) ? null : 'It needs the codex program’s name or path.'),
  uninstalled(c) {
    const program = words(str(c.command))[0] ?? '';
    return which(program) ? null : `Nova can’t find \`${program || 'codex'}\` on this computer.`;
  },
  model: (c) => str(c.model) || 'codex',
  async work(i: WorkInput): Promise<WorkOutcome> {
    const c = i.config;
    const argv = [
      ...words(str(c.command)), 'exec', '--json', '--skip-git-repo-check',
      '--sandbox', (c.sandbox as string) || 'workspace-write',
      ...(str(c.model) ? ['--model', str(c.model)] : []),
      '-',
    ];
    let lastMessage = '';
    let finished: { ok: boolean; why: string } | null = null;
    const usage: { model: string; tokens_in?: number; tokens_out?: number } = { model: str(c.model) || 'codex' };
    let ran;
    try {
      ran = await runLines({
        argv, cwd: i.cwd!, input: `${i.system}\n\n${i.prompt}`, env: childEnv(), signal: i.signal, timeoutMs: num(c.timeout_s, 1800) * 1000,
        onLine: (line) => {
          let ev: Record<string, any>;
          try { ev = JSON.parse(line); } catch { if (line.trim()) i.log(line); return; }
          const item = ev.item;
          if (ev.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
          else if (ev.type === 'item.completed' && item?.type === 'file_change') i.log(`changed ${(item.changes ?? []).map((x: { path?: string; kind?: string }) => `${x.kind} ${x.path}`).join(', ')}`);
          else if (ev.type === 'item.completed' && item?.type === 'command_execution') i.log(`ran ${item.command} (exit ${item.exit_code})`);
          else if (ev.type === 'turn.completed') {
            finished = { ok: true, why: '' };
            if (typeof ev.usage?.input_tokens === 'number') usage.tokens_in = ev.usage.input_tokens;
            if (typeof ev.usage?.output_tokens === 'number') usage.tokens_out = ev.usage.output_tokens;
          } else if (ev.type === 'turn.failed') finished = { ok: false, why: String(ev.error?.message ?? 'the turn failed') };
          else if (ev.type === 'error') finished = { ok: false, why: String(ev.message ?? 'an error') };
        },
      });
    } catch (e) {
      return { status: 'failed', summary: `Nova couldn’t start Codex: ${(e as Error).message}`, usage };
    }
    const f = finished as { ok: boolean; why: string } | null;
    if (ran.timedOut) return { status: 'failed', summary: `Codex took longer than ${num(c.timeout_s, 1800)} s and was stopped.`, usage };
    if (f?.ok) return { status: 'done', summary: summarize(lastMessage, 'Codex finished.'), usage };
    if (f) return { status: 'failed', summary: `Codex stopped with an error: ${summarize(f.why, 'no detail')}`, usage };
    return { status: 'failed', summary: `Codex ended (exit ${ran.code ?? ran.signal}) without finishing its turn.${ran.stderr.trim() ? ` It said: ${tail(ran.stderr, 3, 300)}` : ''}`, usage };
  },
};
