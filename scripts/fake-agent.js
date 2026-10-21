#!/usr/bin/env node
// A scripted stand-in for the model, for tests and screenshots. It reads the
// prompt Nova sends on stdin and answers based on the latest message.
//   "run …"   → asks to run `git status` (an approval)
//   "read …"  → reads USER.md
//   "fail"    → exits with an error
//   "slow"    → streams slowly, for stop tests
//   anything else → a reply with a list, code and a table
const delay = Number(process.env.FAKE_DELAY ?? 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let input = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) input += c;

const convo = input.slice(input.lastIndexOf('<conversation>'));
const lastUser = convo.lastIndexOf('<user');
const msg = convo.slice(convo.indexOf('>', lastUser) + 1, convo.indexOf('</user>', lastUser)).trim().toLowerCase();
const afterUser = convo.slice(lastUser);
const result = afterUser.match(/<tool_result name="(\w+)" ok="(\w+)">([\s\S]*?)<\/tool_result>/g)?.at(-1);

async function stream(text, ms = delay) {
  for (const piece of text.match(/\S+\s*|\s+/g)) { process.stdout.write(piece); await sleep(ms); }
}

if (msg.includes('fail')) {
  process.stderr.write('fake-agent: simulated failure (connection refused)\n');
  process.exit(2);
}

if (msg.startsWith('run') || msg.includes('git status')) {
  if (!result) {
    await stream("I'll check the working tree before standup.\n\n<tool_call name=\"exec\">{\"command\": \"git status --short --branch\"}</tool_call>");
  } else if (result.includes('ok="false"')) {
    await stream("No problem, I won't run it. If you want, paste the output of `git status` and I'll read it from there.");
  } else {
    await stream("The branch is clean and up to date, so there's nothing to commit before standup.");
  }
} else if (msg.startsWith('read')) {
  if (!result) await stream('<tool_call name="read_file">{"path": "USER.md"}</tool_call>');
  else await stream('Your profile is still mostly empty. Tell me a little about yourself and I\'ll fill it in.');
} else if (msg.includes('slow')) {
  await stream('Thinking this through carefully, one word at a time, so there is plenty of time to stop me before I finish this rather long sentence that keeps going and going.', 250);
} else {
  await stream(`Three things, in order:

1. **Flying Tools**: the VPC endpoint migration is still open, and it's your only client work this week.
2. **Home Depot card**: the $41 minimum is due today.
3. **Maverick's bus**: the PM run is on the early Wednesday schedule, with a 1:28 PM drop-off.

The migration needs one change before you can close it:

\`\`\`hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id       = module.vpc.vpc_id
  service_name = "com.amazonaws.us-east-1.s3"
}
\`\`\`

| Task | Due | Effort |
| --- | --- | --- |
| VPC endpoint migration | Friday | 2 hours |
| Card payment | Today | 2 minutes |

Want me to draft the PR description for the migration?`);
}
