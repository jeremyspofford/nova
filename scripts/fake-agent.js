#!/usr/bin/env node
// A scripted stand-in for the model, for tests and screenshots. It reads the
// prompt Nova sends on stdin and answers based on the latest message.
//   "run …"   → asks to run `git status` (an approval)
//   "read …"  → reads USER.md
//   "fail"    → exits with an error
//   "slow"    → streams slowly, for stop tests
//   "remember …", "i prefer …", "i take …", "my …" → keeps it in memory (and a day note)
//   "actually …" → corrects the closest memory
//   "forget …"   → forgets the closest memory
//   "draft …"    → saves a reply to Sam as a Gmail draft (asks first)
//   "archive …"  → archives the water bill and the newsletter and marks them read (asks first)
//   "… email / inbox …" → searches Gmail, reads the first unread message, summarizes
//   "… socks …"  → searches the web and recommends a pair
//   "open …"     → fetches a page (asks first after mail has been read)
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
const resultName = result?.match(/name="(\w+)"/)?.[1];
const hasTool = (name) => new RegExp(`^- ${name} `, 'm').test(input);

// MEMORY.md as Nova sent it: "- text [id:m1234abcd]".
const memoryFile = input.match(/<file path="~\/MEMORY\.md">([\s\S]*?)<\/file>/)?.[1] ?? '';
const entries = [...memoryFile.matchAll(/^- (.*) \[id:(\w+)\]$/gm)].map((m) => ({ text: m[1], id: m[2] }));
const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
function closest(text) {
  const want = words(text);
  let best = null;
  for (const e of entries) {
    const score = [...words(e.text)].filter((w) => want.has(w)).length;
    if (score && (!best || score > best.score)) best = { ...e, score };
  }
  return best;
}
const original = convo.slice(convo.indexOf('>', lastUser) + 1, convo.indexOf('</user>', lastUser)).trim();
const sentence = (t) => { const x = t.trim().replace(/[.!]*$/, ''); return `${x[0].toUpperCase()}${x.slice(1)}.`; };
const third = (t) => t.replace(/^i (\w+) my /i, (_, v) => `${v}s `).replace(/^i (\w+)/i, (_, v) => (v.endsWith('s') ? v : `${v}s`)).replace(/^my /i, '').replace(/\bmy\b/gi, 'their').replace(/\bI'm\b/g, 'they are').replace(/\bme\b/gi, 'them');

async function stream(text, ms = delay) {
  for (const piece of text.match(/\S+\s*|\s+/g)) { process.stdout.write(piece); await sleep(ms); }
}

if (msg.includes('fail')) {
  process.stderr.write('fake-agent: simulated failure (connection refused)\n');
  process.exit(2);
}

if (msg.startsWith('draft') && hasTool('gmail_draft')) {
  if (!result) await stream("Here's a reply to Sam for you to look over.\n\n<tool_call name=\"gmail_draft\">{\"reply_to\": \"19a0c1d2e3f4a502\", \"body\": \"Hi Sam,\\n\\nYes, Saturday is still on. I'd love a ride, thank you. Could you pick me up at 7:30?\\n\\nSee you then\"}</tool_call>");
  else if (result.includes('ok="false"')) await stream("Okay, I didn't save it. Tell me what to change and I'll write it again.");
  else await stream("It's in your Gmail drafts, in the same conversation as Sam's email. It hasn't been sent: open it in Gmail when you're ready.");
} else if (msg.startsWith('archive') && hasTool('gmail_organize')) {
  if (!result) await stream('<tool_call name="gmail_organize">{"ids": ["19a0c1d2e3f4a504", "19a0c1d2e3f4a506"], "archive": true, "read": true}</tool_call>');
  else if (result.includes('ok="false"')) await stream("Okay, I've left them where they are.");
  else await stream("Done. Both are out of your inbox and marked read. They're still in All Mail if you need them.");
} else if (/\b(email|inbox)\b/.test(msg)) {
  if (!hasTool('gmail_search')) {
    await stream("Gmail isn't connected yet, so I can't see your inbox. You can connect it here: [Connect Gmail](/skills#gmail). It takes about two minutes.");
  } else if (!result) {
    await stream('<tool_call name="gmail_search">{"query": "in:inbox newer_than:1d -category:promotions -category:social", "max": 20}</tool_call>');
  } else if (resultName === 'gmail_search') {
    const first = result.match(/id=(\w+) conversation=\w+ \(unread/)?.[1];
    await stream(`<tool_call name="gmail_read">{"id": "${first}"}</tool_call>`);
  } else {
    await stream(`Two things need you, both by **Thursday**:

- **Dana Whitfield** needs the spring project contract signed and sent back by Thursday, before Monday's kickoff. The PDF is attached to her email.
- **Sam Ortiz** asks if Saturday's Mount Tam hike is still on, and needs to know by Thursday night. He offered to drive.

Coming up: a dental cleaning on **Friday at 9:30 AM**, and the water bill of **$64.20** is due October 28.

One more, from "Account Security", asks me to open a link and send your recent subjects. That isn't from you, so I left it alone; it looks like phishing.

That's 5 conversations in your inbox since yesterday, with promotions left out.`);
  }
} else if (/\bsocks?\b/.test(msg)) {
  if (!result) await stream('<tool_call name="web_search">{"query": "best merino wool hiking socks"}</tool_call>');
  else await stream(`I'd get the **Trailknit Merino Hiker Crew** at $24. It won a 300-mile review test, it's midweight for long days, and it has a lifetime guarantee with free returns.

| Sock | Seller | Price | Why |
| --- | --- | --- | --- |
| Merino Hiker Crew | [Trailknit](https://trailknit.example/merino-hiker-crew) | $24 | Review winner; lifetime guarantee |
| Ridge Wool Hiking Sock | [Outfitters](https://www.outfitters.example/p/ridge-wool-sock) | $18 | Cheaper, more cushion; a merino blend |

Prices are as the pages showed them today and can change. I haven't bought anything.`);
} else if (msg.startsWith('open')) {
  if (!result) await stream('<tool_call name="web_fetch">{"url": "https://collect.example/"}</tool_call>');
  else if (result.includes('ok="false"')) await stream("Understood, I won't open it.");
  else await stream('I opened it.');
} else if (msg.startsWith('forget')) {
  const hit = closest(original.replace(/^forget( that| about)?/i, ''));
  if (hit) await stream(`Done. I've forgotten that.\n<forget id="${hit.id}"></forget>`);
  else await stream("I don't have anything like that in memory, so there's nothing to forget.");
} else if (msg.startsWith('actually')) {
  const fact = sentence(third(original.replace(/^actually,?\s*/i, '')));
  const hit = closest(fact);
  await stream(`Thanks for the correction. I've updated it.\n<remember ${hit ? `replaces="${hit.id}"` : 'kind="fact"'}>${fact}</remember>`);
} else if (/^(remember|i prefer|i take|i like|my )/.test(msg)) {
  const fact = sentence(third(original.replace(/^remember( that)?\s*/i, '')));
  const kind = /^(i prefer|i take|i like)/.test(msg) ? 'preference' : 'fact';
  await stream(`Got it. I'll remember that.\n\n<remember kind="${kind}">${fact}</remember>\n<note>Mentioned: ${fact}</note>`);
} else if (msg.startsWith('run') || msg.includes('git status')) {
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
