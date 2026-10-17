// Accessibility baseline for E2E journeys (FR-015): no serious or critical axe violations.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoSeriousA11yIssues(
  page: Page,
  where: string,
  /** Elements left out because of a known, reported product bug (name it where it is used). */
  opts: { exclude?: readonly string[] } = {},
) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  for (const selector of opts.exclude ?? []) builder = builder.exclude(selector);
  const result = await builder.analyze();
  const serious = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary ?? ''}`).join('\n')}`,
    ),
    `axe on ${where}`,
  ).toEqual([]);
}
