// `npm run i18n:check` (part of `npm run lint`) and `npm run i18n:write` (FR-016, D9): collects
// every defineMessages call in the UI sources, verifies (or with --write, rewrites) the English
// catalog apps/web/src/i18n/catalog.en.json, checks every translation catalog against it and
// prints the coverage per locale. The logic lives in packages/i18n/src/check.ts.
import { resolve } from 'node:path';
import { runI18nCheck } from '../packages/i18n/src/check.ts';

const root = resolve(import.meta.dirname, '..');
const write = process.argv.includes('--write');

const report = runI18nCheck({
  root,
  sources: ['apps/web/src', 'packages/ui/src', 'apps/desktop/src'],
  catalog: 'apps/web/src/i18n/catalog.en.json',
  locales: 'apps/web/src/i18n/locales',
  write,
});

for (const p of report.problems) console.error(`i18n: ${p}`);
const coverage = report.coverage
  .map(
    (c) =>
      `${c.locale} ${c.translated}/${c.total} (${c.total ? Math.round((c.translated / c.total) * 100) : 0}%)`,
  )
  .join(', ');
console.log(
  `i18n: ${report.messages} messages${report.wrote ? ', catalog.en.json rewritten' : ''}${coverage ? `; translated: ${coverage}` : ''}`,
);
process.exit(report.ok ? 0 : 1);
