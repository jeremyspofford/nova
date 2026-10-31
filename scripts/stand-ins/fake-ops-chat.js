#!/usr/bin/env node
// A scripted chat model (Era 2's agent_cmd protocol: the prompt on stdin, the reply on stdout) for
// infrastructure, networking and accounts through chat (M10d). Never calls a model. It understands:
//
//   Plan the infrastructure project <name>.            → infra_plan
//   Destroy the infrastructure project <name>.         → infra_plan with destroy
//   Change <target name>: <JSON merge patch>            → network_change
//   Change my password at <host:port>.                  → account_change, on the stand-in account site
//   Infrastructure status / Network status              → infra_status / network_status
//
// Once a tool's result is in the transcript, it tells the person what happened in a sentence, quoting
// the result. It never asks for a password or a code.
let input = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) input += c;

const convo = input.slice(input.lastIndexOf('<conversation>'));
const lastUser = convo.lastIndexOf('<user');
const said = convo.slice(convo.indexOf('>', lastUser) + 1, convo.indexOf('</user>', lastUser)).trim();
const after = convo.slice(lastUser);
const result = [...after.matchAll(/<tool_result name="(\w+)" ok="(\w+)">([\s\S]*?)<\/tool_result>/g)].at(-1);
const call = (name, args) => process.stdout.write(`On it.\n\n<tool_call name="${name}">${JSON.stringify(args)}</tool_call>`);

if (result) {
  const [, name, ok, text] = result;
  const first = text.trim().split('\n')[0];
  process.stdout.write(ok === 'true' ? `Done: ${first}` : `That didn’t work (${name}): ${first}`);
} else {
  let m;
  if ((m = /^(plan|destroy) the infrastructure project (.+?)\.?$/i.exec(said))) call('infra_plan', { project: m[2], destroy: /^destroy/i.test(m[1]) });
  else if ((m = /^change ([^:]+):\s*(\{[\s\S]*\})\s*$/i.exec(said)) && !/password/i.test(m[1])) call('network_change', { target: m[1].trim(), patch: JSON.parse(m[2]), title: `Change ${m[1].trim()}` });
  else if ((m = /^change my password at (\S+?)\.?$/i.exec(said))) {
    const site = m[1];
    call('account_change', {
      change: 'password', site,
      steps: [
        { do: 'navigate', url: `http://${site}/login` },
        { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#account' },
        { do: 'navigate', url: `http://${site}/password` },
        { do: 'new_password', current: '#current', password: '#new', confirm: '#again', submit: '#save', done_when: '#changed' },
      ],
      verify: { url: `http://${site}/account`, expect: ['Password changed'] },
    });
  } else if (/infrastructure status/i.test(said)) call('infra_status', {});
  else if (/network status/i.test(said)) call('network_status', {});
  else process.stdout.write('Tell me which infrastructure project to plan, which network target to change and how, or which site’s password to change.');
}
