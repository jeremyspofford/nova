#!/usr/bin/env node
// A scripted chat model (Era 2's agent_cmd protocol: the prompt on stdin, the reply on stdout) for
// coding through chat (M10c). Never calls a model. Given a request like
//
//   In the repository at /full/path, make greet() say hello. Test with `node --test`, preview with
//   `node server.mjs`, on branch main.
//
// it calls code_change with that repository, goal and commands; once the tool's result is in the
// transcript, it tells the person what happened in a sentence, quoting the result. "status" asks
// code_status.
let input = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) input += c;

const convo = input.slice(input.lastIndexOf('<conversation>'));
const lastUser = convo.lastIndexOf('<user');
const said = convo.slice(convo.indexOf('>', lastUser) + 1, convo.indexOf('</user>', lastUser)).trim();
const after = convo.slice(lastUser);
const result = [...after.matchAll(/<tool_result name="(\w+)" ok="(\w+)">([\s\S]*?)<\/tool_result>/g)].at(-1);

if (result) {
  const [, name, ok, text] = result;
  const first = text.trim().split('\n')[0];
  process.stdout.write(ok === 'true' ? `Done: ${first}` : `That didn’t work (${name}): ${first}`);
} else if (/\bstatus\b/i.test(said)) {
  process.stdout.write('Let me look.\n\n<tool_call name="code_status">{}</tool_call>');
} else {
  const repo = /\bat (\/\S+?)[,.]?(\s|$)/.exec(said)?.[1];
  const test = /test with `([^`]+)`/i.exec(said)?.[1];
  const preview = /preview with `([^`]+)`/i.exec(said)?.[1];
  const branch = /on branch ([\w./-]+)/i.exec(said)?.[1];
  const agent = /\busing ([\w-]+)\b/i.exec(said)?.[1];
  const goal = said.replace(/^In the repository at \S+\s*/i, '').replace(/\s*Test with[\s\S]*$/i, '').trim();
  if (!repo || !test) process.stdout.write('Which repository, and how are its tests run?');
  else {
    const args = { repo, goal, test_command: test, ...(preview ? { preview_command: preview } : {}), ...(branch ? { branch } : {}), ...(agent ? { agent } : {}) };
    process.stdout.write(`I’ll have a coding agent make that change.\n\n<tool_call name="code_change">${JSON.stringify(args)}</tool_call>`);
  }
}
