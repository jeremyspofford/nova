// A made-up home for the Stellar Map's tests and screenshots: a family, an
// employer, a goal, and a few weeks of notes. Every name here is invented.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const iso = (now, daysAgo, h = 14) => new Date(now.getTime() - daysAgo * 86_400_000 + (h - 12) * 3_600_000).toISOString();
const day = (now, daysAgo) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const meta = (id, at) => ` <!-- id=${id} from=sample/0 at=${at} -->`;

export function writeSampleHome(home, now = new Date()) {
  const w = (rel, text) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  w('USER.md', `# USER.md\n\n- **Name:** Sam Rivera\n- **What to call them:** Sam\n- **Timezone:** America/New_York\n- **Notes:** Platform engineer. Two kids' schedules run the week.\n`);
  w('IDENTITY.md', '# IDENTITY.md\n\n- **Name:** Nova\n- **Character:** a personal agent; a thoughtful journal that happens to act\n- **Vibe:** calm, direct, warm without filler\n');
  w('SOUL.md', '# SOUL.md\n\n- **Be genuinely helpful, not performatively helpful.**\n- **Evidence over claims.** Say what you checked.\n');
  w('AGENTS.md', '# AGENTS.md\n\n## Conventions\n- Keep exports in `workspace/exports/`.\n');
  w('memory/people/ana-rivera.md', `# Ana Rivera\n\nSam's wife. Also called: Annie\n\n- Teaches chemistry at the high school.\n- Runs the Saturday farmers' market stall with Leo.\n`);
  w('memory/people/leo-rivera.md', '# Leo Rivera\n\nSam and Ana\'s son, 9.\n\n- Asthma; see the inhaler plan.\n- Soccer on Tuesdays and Thursdays.\n');
  w('memory/people/mia-rivera.md', '---\npinned: false\n---\n# Mia Rivera\n\nSam and Ana\'s daughter, 6. Loves the planetarium.\n');
  w('memory/people/dana-okafor.md', '# Dana Okafor\n\nSam\'s manager at [[northwind]]. Weekly 1:1 on Mondays.\n');
  w('memory/groups/family.md', '# Family\n\n- Sam Rivera\n- Ana Rivera\n- Leo Rivera\n- Mia Rivera\n');
  w('memory/topics/northwind.md', '# Northwind\n\nSam\'s employer: platform team, ECS on Fargate, Terraform.\n');
  w('workspace/goals/remote-platform-role/GOAL.md', '# Remote platform role — $150k+\n\nFind a remote platform engineering role at $150k or more by spring. Dana Okafor offered to be a reference.\n');
  w('workspace/goals/remote-platform-role/files/resume.md', '# Resume\n');
  w('MEMORY.md', [
    '# MEMORY.md', '', '## Facts', '',
    `- Takes coffee black, one cup before nine.${meta('m1a2b3c4d', iso(now, 40))}`,
    `- Leo uses a blue inhaler before soccer; the inhaler plan is on the fridge.${meta('m2b3c4d5e', iso(now, 12))}`,
    `- Ana is allergic to penicillin.${meta('m3c4d5e6f', iso(now, 60))}`,
    `- Northwind's on-call rotation is one week in six.${meta('m4d5e6f70', iso(now, 20))}`,
    '', '## Preferences', '',
    `- Wants answers first, detail after.${meta('m5e6f7081', iso(now, 55))}`,
    `- Mia's bedtime story is always about planets.${meta('m6f708192', iso(now, 9))}`,
    '', '## Decisions', '',
    `- Resume leads with the ECS migration.${meta('m708192a3', iso(now, 6))}`,
    '', '## Commitments', '',
    `- Call Dana Okafor about the reference by Friday.${meta('m8192a3b4', iso(now, 3))}`,
    '',
  ].join('\n'));
  const note = (ago, lines) => w(`memory/${day(now, ago)}.md`, `# ${day(now, ago)}\n\n${lines.map(([t, id, h], i) => `- ${t} · ${lines[i][3]}${meta(id, iso(now, ago, h))}`).join('\n')}\n`);
  note(1, [['08:10', 'n0a1b2c3d', 8, 'Leo\'s soccer moved to Thursday at five.'], ['16:40', 'n1b2c3d4e', 16, 'Sent the resume to two remote roles.']]);
  note(4, [['09:30', 'n2c3d4e5f', 9, 'Ana and Mia at the planetarium Saturday.']]);
  note(11, [['13:05', 'n3d4e5f60', 13, 'Dana Okafor approved the Fargate cost plan.']]);
  note(45, [['10:00', 'n4e5f6071', 10, 'Leo\'s check-up went well.'], ['18:20', 'n5f607182', 18, 'Paid the electric bill.']]);
  note(70, [['12:00', 'n6071829a', 12, 'Look up a better bread recipe.'], ['19:00', 'n71829ab3', 19, 'Renewed the car registration.']]);
  note(90, [['09:00', 'n829ab3c4', 9, 'Fixed the leaking kitchen tap.']]);
}
