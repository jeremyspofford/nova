#!/usr/bin/env node
// A stand-in for the `codex` CLI that speaks `codex exec --json`'s real JSON Lines events:
// thread.started, turn.started, item.started / item.completed (command_execution, file_change,
// agent_message), and turn.completed with usage, or turn.failed. It really edits files, as its
// script says (scripts/stand-ins/script.js). Never calls any model.
//
//   node scripts/stand-ins/fake-codex.js --script script.json [--record calls.jsonl] exec --json … -
import { randomUUID } from 'node:crypto';
import { loadScript, parseArgs, perform, readStdin, record, sleep } from './script.js';

const args = parseArgs(process.argv.slice(2));
const prompt = await readStdin();
const s = loadScript(args.script);
const cwd = process.cwd();
record(args.record, { cli: 'codex', argv: args.rest, cwd, stdin: prompt });

if (args.rest[0] !== 'exec' || !args.rest.includes('--json')) {
  process.stderr.write('fake-codex: expected exec --json\n');
  process.exit(2);
}
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
let n = 0;
const item = () => `item_${n++}`;
out({ type: 'thread.started', thread_id: randomUUID() });
out({ type: 'turn.started' });
for (const step of s.steps) {
  await sleep(s.delay_ms);
  if (step.say) { out({ type: 'item.completed', item: { id: item(), type: 'reasoning', text: step.say } }); continue; }
  const id = item();
  if (step.run) out({ type: 'item.started', item: { id, type: 'command_execution', command: step.run, aggregated_output: '', status: 'in_progress' } });
  let done;
  try { done = perform(step, cwd); } catch (e) { done = { tool: 'Unknown', output: e.message, error: true }; }
  if (!done) continue;
  if (step.run || step.read) {
    out({ type: 'item.completed', item: { id, type: 'command_execution', command: step.run ?? `cat ${step.read}`, aggregated_output: String(done.output).slice(0, 2000), exit_code: done.exit ?? 0, status: done.error ? 'failed' : 'completed' } });
  } else if (done.change) {
    out({ type: 'item.completed', item: { id, type: 'file_change', changes: [done.change], status: done.error ? 'failed' : 'completed' } });
  }
}
await sleep(s.delay_ms);
// The exit code is set, not forced: stdout into a pipe is written asynchronously, and process.exit()
// would drop whatever the reader hasn't taken yet (a long script's last lines among them). Ending
// on its own, the process first writes out everything it said.
if (s.error) {
  out({ type: 'turn.failed', error: { message: s.error } });
  process.exitCode = s.exit || 1;
} else {
  out({ type: 'item.completed', item: { id: item(), type: 'agent_message', text: s.result } });
  out({ type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 0, output_tokens: 30 } });
  process.exitCode = s.exit;
}
