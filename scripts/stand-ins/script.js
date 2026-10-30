// What the stand-in coding agents do, read from a script file, so a test (or the M5 gate) decides
// exactly how an agent behaves: which files it really edits, what it says, whether it lies.
//
//   {
//     "steps": [
//       {"say": "Looking at the failing test."},
//       {"read": "calc/sum.test.js"},
//       {"edit": {"path": "calc/sum.js", "old": "a - b", "new": "a + b"}},
//       {"write": {"path": "calc/notes.md", "content": "…"}},
//       {"run": "node --test calc/"}            // really runs it, in the working folder
//     ],
//     "result": "Fixed sum.js; the test passes.",   // its final claim, true or not
//     "error": "…",                               // instead: it ends with this error
//     "exit": 0, "delay_ms": 0, "model": "stand-in-model"
//   }
//
// A script with no edits and a cheerful result is a provider that lies.
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function parseArgs(argv) {
  const out = { script: null, record: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--script') out.script = argv[++i];
    else if (argv[i] === '--record') out.record = argv[++i];
    else out.rest.push(argv[i]);
  }
  return out;
}

export async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) input += c;
  return input;
}

export function loadScript(file) {
  const s = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { steps: s.steps ?? [], result: s.result ?? 'Done.', error: s.error ?? null, exit: s.exit ?? 0, delay_ms: s.delay_ms ?? 0, model: s.model ?? 'stand-in-model' };
}

// Remembers how it was called (argv, working folder, stdin), so a test can check what Nova sent.
export function record(file, what) {
  if (file) appendFileSync(file, `${JSON.stringify(what)}\n`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does one step for real in the working folder; returns what happened, as a tool result would say it.
export function perform(step, cwd) {
  if (step.read) return { tool: 'Read', input: { file_path: resolve(cwd, step.read) }, output: readFileSync(resolve(cwd, step.read), 'utf8') };
  if (step.write) {
    const p = resolve(cwd, step.write.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, step.write.content);
    return { tool: 'Write', input: { file_path: p, content: step.write.content }, output: `File created successfully at: ${p}`, change: { path: step.write.path, kind: 'add' } };
  }
  if (step.edit) {
    const p = resolve(cwd, step.edit.path);
    const before = readFileSync(p, 'utf8');
    if (!before.includes(step.edit.old)) return { tool: 'Edit', input: { file_path: p, old_string: step.edit.old, new_string: step.edit.new }, output: 'String to replace not found in file.', error: true };
    writeFileSync(p, before.replace(step.edit.old, step.edit.new));
    return { tool: 'Edit', input: { file_path: p, old_string: step.edit.old, new_string: step.edit.new }, output: `The file ${p} has been updated.`, change: { path: step.edit.path, kind: 'update' } };
  }
  if (step.run) {
    try {
      return { tool: 'Bash', input: { command: step.run }, output: execSync(step.run, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), exit: 0 };
    } catch (e) {
      return { tool: 'Bash', input: { command: step.run }, output: `${e.stdout ?? ''}${e.stderr ?? ''}`, exit: e.status ?? 1, error: true };
    }
  }
  return null;
}
