// Read-only publication verification: executable evidence, not production code.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const folder = import.meta.dirname;
const hash = (b) => createHash('sha256').update(b).digest('hex');
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const manifest = json(resolve(folder, 'manifest.json'));
const original = json(resolve(folder, 'manifest-tasks1-5.json'));
assert.equal(original.files.length, 250);
assert.equal(original.files.reduce((n, f) => n + f.bytes, 0), 796493);
for (const file of [...original.files, ...manifest.files]) {
  assert.ok(!file.file.startsWith('/') && !file.file.split('/').includes('..'));
  const b = readFileSync(resolve(folder, file.file));
  assert.equal(b.length, file.bytes, file.file);
  assert.equal(hash(b), file.sha256, file.file);
}
const walk = (p) => readdirSync(p, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(resolve(p, x.name)) : [resolve(p, x.name)]);
assert.deepEqual(walk(folder).filter((p) => p !== resolve(folder, 'manifest.json')).sort(), manifest.files.map((f) => resolve(folder, f.file)).sort(), 'every public retained byte is sealed');
const source = json(resolve(folder, 'source-manifest-44a8.json'));
const all = json(resolve(folder, 'all-src-manifest-44a8.json'));
assert.equal(source.source_commit, '44a8deb563324ac2847c02dc82dfc6e3aec32d85');
assert.equal(all.source_commit, source.source_commit);
assert.equal(all.files.length, 256);
assert.deepEqual(all.src_and_tests_diff_from_base, []);
for (const f of all.files) {
  const b = readFileSync(resolve(root, f.file));
  assert.equal(hash(b), f.sha256, f.file);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex'), f.git_blob, f.file);
}
const packet = readFileSync(resolve(root, 'docs/reviews/vault-broker-phase1-review-packet.md'), 'utf8');
assert.equal(source.files.length, 30);
assert.equal(source.broker_boundary_lines, 2896);
for (const f of source.files) {
  const b = readFileSync(resolve(root, f.file));
  assert.equal(hash(b), f.sha256, f.file);
  assert.equal(b.toString().split('\n').length, f.boundary_count, f.file);
  const marker = `### \`${f.file}\`\n\nSource \`${source.source_commit}\`, Git blob \`${f.git_blob}\`, SHA256 \`${f.sha256}\``;
  const start = packet.indexOf(marker);
  assert.ok(start >= 0, f.file);
  const code = packet.indexOf('```' + (f.file.endsWith('.js') ? 'js' : 'ts') + '\n', start);
  const offset = code + (f.file.endsWith('.js') ? 6 : 6);
  assert.equal(packet.slice(offset, offset + b.toString().length), b.toString(), f.file);
  assert.equal(packet.slice(offset + b.toString().length, offset + b.toString().length + 4), '```\n', f.file);
}
const attempt = (label) => json(resolve(folder, `evidence/task-7/${label}.json`));
for (const label of ['check-01-impacted-broker', 'check-02-impacted-recovery-mesh', 'check-03-b3-failure-diagnostic', 'check-04-b3-natural-tap', 'check-05-never-reached-broker']) {
  const a = attempt(label);
  assert.equal(a.git_identity.host_head, source.source_commit);
  assert.equal(a.git_identity.visible_commit, source.source_commit);
  for (const f of all.files) assert.equal(a.git_identity.source_tree_sha256[f.file], f.sha256, `${label}: ${f.file}`);
  for (const arg of ['--pull=never', '--network=none', '--user=1000:1000', '--read-only']) assert.ok(a.argv.includes(arg), `${label}: ${arg}`);
  assert.ok(!a.argv.some((x) => x.includes('NOVA_UI_SHOTS')));
}
assert.equal(attempt('check-01-impacted-broker').exit_code, 137);
for (const label of ['check-02-impacted-recovery-mesh', 'check-04-b3-natural-tap', 'check-05-never-reached-broker']) {
  assert.equal(attempt(label).exit_code, 0);
  assert.ok(!attempt(label).command.includes('--test-force-exit'));
  const s = readFileSync(resolve(folder, `evidence/task-7/${label}.stdout`), 'utf8');
  assert.match(s, /no-Kubernetes tripwire: never fired/);
  assert.match(s, /Task7 egress guard: never fired/);
}
assert.ok(attempt('check-03-b3-failure-diagnostic').command.includes('--test-force-exit'));
const newReports = ['README.md', 'b-mapping.md', 'rulings-22-27.md', 'task-6-report.md', 'task-6-review.md', 'task-6-fix-1-review.md', 'task-7-report.md'];
const docs = [...newReports.map((f) => resolve(folder, f)), resolve(root, 'docs/reviews/vault-broker-phase1-review-packet.md'), resolve(root, 'docs/evidence/vault-broker-p1-gate.md')];
let links = 0;
for (const p of docs) {
  const prose = readFileSync(p, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\n/gm, '');
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const to = m[1].split('#')[0];
    if (!to || /^[a-z]+:/i.test(to)) continue;
    assert.ok(statSync(resolve(dirname(p), to)).isFile(), `${p}: ${to}`);
    links++;
  }
}
console.log(JSON.stringify({ original_artifacts: original.files.length, original_bytes: 796493, public_artifacts: manifest.files.length, public_bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), all_src_unchanged: all.files.length, packet_complete_files: source.files.length, broker_boundary: source.broker_boundary_lines, new_report_links_checked: links, result: 'PASS' }));
