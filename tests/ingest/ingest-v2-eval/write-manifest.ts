// Writes manifest.json from the generator: node tests/ingest/ingest-v2-eval/write-manifest.ts
// CI checks the committed manifest against the generator, so the two can't drift.
import { writeFileSync } from 'node:fs';
import { MANIFEST_FILE, manifest } from './cases.ts';

const m = manifest();
writeFileSync(MANIFEST_FILE, `${JSON.stringify(m, null, 1)}\n`);
console.log(`${m.total} cases (${m.attacks} attack, ${m.benign} benign, ${m.steering} steering), sha256 ${m.cases_sha256}`);
