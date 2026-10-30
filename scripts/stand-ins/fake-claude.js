#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks Claude Code's real stream-json protocol
// (`claude -p --output-format stream-json --verbose`): a system init event, assistant messages with
// text and tool_use parts, user messages with tool_result parts, and a final result event. It
// really edits files, as its script says (scripts/stand-ins/script.js). Never calls any model.
//
//   node scripts/stand-ins/fake-claude.js --script script.json [--record calls.jsonl] -p --output-format stream-json …
import { randomUUID } from 'node:crypto';
import { loadScript, parseArgs, perform, readStdin, record, sleep } from './script.js';

const args = parseArgs(process.argv.slice(2));
const prompt = await readStdin();
const s = loadScript(args.script);
const cwd = process.cwd();
const session = randomUUID();
record(args.record, { cli: 'claude', argv: args.rest, cwd, stdin: prompt });

if (!args.rest.includes('-p') || args.rest[args.rest.indexOf('--output-format') + 1] !== 'stream-json') {
  process.stderr.write('fake-claude: expected -p --output-format stream-json\n');
  process.exit(2);
}
const model = args.rest.includes('--model') ? args.rest[args.rest.indexOf('--model') + 1] : s.model;
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0 };
const message = (content) => ({ type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model, content, stop_reason: null, usage }, parent_tool_use_id: null, session_id: session });

out({ type: 'system', subtype: 'init', cwd, session_id: session, tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'], mcp_servers: [], model, permissionMode: args.rest[args.rest.indexOf('--permission-mode') + 1] ?? 'default', apiKeySource: 'none' });
let turns = 1;
for (const step of s.steps) {
  await sleep(s.delay_ms);
  if (step.say) { out(message([{ type: 'text', text: step.say }])); continue; }
  const id = `toolu_${randomUUID().slice(0, 12)}`;
  let done;
  try { done = perform(step, cwd); } catch (e) { done = { tool: 'Unknown', input: {}, output: e.message, error: true }; }
  if (!done) continue;
  turns++;
  out(message([{ type: 'tool_use', id, name: done.tool, input: done.input }]));
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(done.output).slice(0, 2000), ...(done.error ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: session });
}
await sleep(s.delay_ms);
if (s.error) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, num_turns: turns, result: s.error, session_id: session, total_cost_usd: 0.001, usage });
  process.exit(s.exit || 1);
}
out(message([{ type: 'text', text: s.result }]));
out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 8, num_turns: turns, result: s.result, session_id: session, total_cost_usd: 0.0042, usage });
process.exit(s.exit);
