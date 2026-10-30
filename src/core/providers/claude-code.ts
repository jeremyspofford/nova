// Claude Code as a coding agent (ADR-8: a vendor CLI behind Nova's envelope). Nova starts
// `claude -p --output-format stream-json --verbose` in the task's folder, with the brief on stdin,
// and reads its event stream: `system` (init: the model), `assistant` (text and tool use),
// `user` (tool results) and the final `result` (success or an error subtype, cost, usage).
// Its own claim of success is only a claim: Nova checks the work afterwards.
import { childEnv, runLines, tail, which, words } from './cli.ts';
import { summarize } from './prompt.ts';
import { num, str, type Config, type Impl, type WorkInput, type WorkOutcome } from './types.ts';

const MODES = ['acceptEdits', 'bypassPermissions', 'default', 'plan'];

export const claudeCode: Impl = {
  id: 'claude-code',
  check(c: Config) {
    const out: string[] = [];
    if (!str(c.command)) out.push('command is the claude program, or its full path.');
    if (c.permission_mode !== undefined && !MODES.includes(c.permission_mode as string)) out.push(`permission_mode is one of ${MODES.join(', ')}.`);
    if (c.allowed_tools !== undefined && !(Array.isArray(c.allowed_tools) && c.allowed_tools.every((t) => typeof t === 'string' && /^[A-Za-z][\w()*:. -]*$/.test(t)))) out.push('allowed_tools is a list of tool names, like Read or Edit.');
    if (c.model !== undefined && typeof c.model !== 'string') out.push('model is a model name, or empty for Claude Code’s default.');
    return out;
  },
  unconfigured: (c) => (str(c.command) ? null : 'It needs the claude program’s name or path.'),
  uninstalled(c) {
    const program = words(str(c.command))[0] ?? '';
    return which(program) ? null : `Nova can’t find \`${program || 'claude'}\` on this computer.`;
  },
  model: (c) => str(c.model) || 'claude-code',
  async work(i: WorkInput): Promise<WorkOutcome> {
    const c = i.config;
    const tools = Array.isArray(c.allowed_tools) ? (c.allowed_tools as string[]) : ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
    const argv = [
      ...words(str(c.command)), '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', (c.permission_mode as string) || 'acceptEdits',
      '--allowedTools', tools.join(','),
      // Its own MCP servers and saved settings stay out; the brief is the whole context.
      '--strict-mcp-config', '--no-session-persistence',
      '--append-system-prompt', i.system,
      ...(str(c.model) ? ['--model', str(c.model)] : []),
    ];
    let model = str(c.model);
    let lastText = '';
    let result: { ok: boolean; text: string; cost?: number; tin?: number; tout?: number } | null = null;
    let ran;
    try {
      ran = await runLines({
        argv, cwd: i.cwd!, input: i.prompt, env: childEnv(), signal: i.signal, timeoutMs: num(c.timeout_s, 1800) * 1000,
        onLine: (line) => {
          let ev: Record<string, any>;
          try { ev = JSON.parse(line); } catch { if (line.trim()) i.log(line); return; }
          if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') model = ev.model;
          else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            for (const part of ev.message.content) {
              if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) lastText = part.text;
              if (part?.type === 'tool_use') i.log(`${part.name} ${JSON.stringify(part.input ?? {}).slice(0, 200)}`);
            }
          } else if (ev.type === 'result') {
            const ok = !ev.is_error && (ev.subtype === undefined || ev.subtype === 'success');
            result = {
              ok, text: String(ev.result ?? ev.subtype ?? ''),
              ...(typeof ev.total_cost_usd === 'number' ? { cost: ev.total_cost_usd } : {}),
              ...(typeof ev.usage?.input_tokens === 'number' ? { tin: ev.usage.input_tokens } : {}),
              ...(typeof ev.usage?.output_tokens === 'number' ? { tout: ev.usage.output_tokens } : {}),
            };
          }
        },
      });
    } catch (e) {
      return { status: 'failed', summary: `Nova couldn’t start Claude Code: ${(e as Error).message}`, usage: { model: model || 'claude-code' } };
    }
    const r = result as { ok: boolean; text: string; cost?: number; tin?: number; tout?: number } | null;
    const usage = { model: model || 'claude-code', ...(r?.cost !== undefined ? { cost_usd: r.cost } : {}), ...(r?.tin !== undefined ? { tokens_in: r.tin } : {}), ...(r?.tout !== undefined ? { tokens_out: r.tout } : {}) };
    if (ran.timedOut) return { status: 'failed', summary: `Claude Code took longer than ${num(c.timeout_s, 1800)} s and was stopped.`, usage };
    if (r?.ok) return { status: 'done', summary: summarize(r.text || lastText, 'Claude Code finished.'), usage };
    if (r) return { status: 'failed', summary: `Claude Code stopped with an error: ${summarize(r.text, 'no detail')}`, usage };
    return { status: 'failed', summary: `Claude Code ended (exit ${ran.code ?? ran.signal}) without a result.${ran.stderr.trim() ? ` It said: ${tail(ran.stderr, 3, 300)}` : ''}`, usage };
  },
};
