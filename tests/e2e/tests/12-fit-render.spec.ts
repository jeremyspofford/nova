/**
 * Scenario 12 — the model picker renders a real fit verdict, not a guess.
 *
 * AUTHORED IN S2e-T4, NOT YET RUN — see the top of 11-change-model.spec.ts
 * for why: the running stack at the time this was written predates T2's
 * fit computation entirely (confirmed directly against the live gateway
 * container while authoring this — its admin.py has no `fit` field at all,
 * services/gateway/app/fit.py does not exist in the image). This runs for
 * the first time once the controller rebuilds.
 *
 * Deliberately does not hardcode which verdict any model should get —
 * comfortable/tight/wont_fit depends on free VRAM at the moment the walk
 * runs (what else is resident), which this scenario does not control. What
 * it CAN assert without inventing a number: whatever GET /api/v1/models/
 * suggest says for a model, Settings -> Models has to say the identical
 * thing — same pattern scenario 1 uses for hardware.json. The label and
 * source-badge text are recomputed here from the verdict/source fields
 * rather than imported from apps/web/src/lib/modelFit.ts (a separate npm
 * package, different tsconfig) — this mirrors that module's LABELS table on
 * purpose, so a change to one without the other shows up as this scenario
 * failing.
 */
import { expect, test } from '@playwright/test'
import { modelCard } from '../lib/app'
import { config } from '../lib/env'

test.use({ storageState: config.storageStatePath })

interface ModelFit {
  verdict: 'comfortable' | 'tight' | 'wont_fit' | 'unknown'
  needed_gb: number | null
  total_gb: number | null
  source: 'verified' | 'estimated'
  reason: string | null
}

interface SuggestedModel {
  slug: string
  fit?: ModelFit
}

// Mirrors apps/web/src/lib/modelFit.ts's fitLabel() — see the file docstring
// for why this is a deliberate mirror rather than a cross-package import.
function expectedLabel(fit: ModelFit): string | RegExp {
  switch (fit.verdict) {
    case 'comfortable':
      return 'comfortable'
    case 'tight':
      // Numbers move with live free VRAM, so only the fixed words are
      // asserted — the exact figure is not this scenario's business.
      return /tight fit — ~/
    case 'wont_fit':
      return "won't fit on this GPU"
    case 'unknown':
      return 'fit unknown'
  }
}

test('fit-render: Settings -> Models matches the gateway fit verdict exactly, per model', async ({
  page,
}) => {
  const suggestion = await (await page.request.get('/api/v1/models/suggest')).json()
  const models: SuggestedModel[] = suggestion.models
  expect(models.length, 'the curated catalog returned no models to check').toBeGreaterThan(0)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()

  const verdictsSeen = new Set<string>()

  for (const model of models) {
    const card = modelCard(page, model.slug)
    await expect(card, `${model.slug} is not rendered in Settings -> Models`).toBeVisible()

    // T2's own contract: GET /admin/suggest attaches `fit` to every curated
    // model, unconditionally (services/gateway/app/admin.py's suggest_route
    // loop has no branch that skips it) — a model missing the field entirely
    // is the regression this line exists to catch, distinct from a
    // legitimate 'unknown' verdict (which still carries the shape).
    expect(model.fit, `${model.slug} carries no fit field at all — T2's suggest_route ` +
      'is expected to attach one to every curated model').toBeTruthy()
    const fit = model.fit as ModelFit
    verdictsSeen.add(fit.verdict)

    const label = expectedLabel(fit)
    if (fit.verdict === 'wont_fit') {
      // The S1 gap this closes: a won't-fit pick used to look identical to
      // every other model. It has to be the loud, role=alert shape, not
      // just a differently-coloured badge.
      await expect(card.getByRole('alert')).toContainText(label as string)
    } else {
      await expect(card.getByText(label, typeof label === 'string' ? { exact: true } : undefined)).toBeVisible()
    }

    // The verified/estimated badge — literal text, mirrors fitSourceLabel().
    const sourceLabel = fit.source === 'verified' ? 'verified on your hardware' : 'estimated'
    await expect(card.getByText(sourceLabel, { exact: true })).toBeVisible()
  }

  // The feature is dark if every single model reads 'unknown' — that is the
  // gateway saying "no GPU / free VRAM unreadable" for all of them, which on
  // this task's target hardware (a detected 3090) would itself be a finding,
  // not a pass.
  expect(
    Array.from(verdictsSeen),
    `every model's fit verdict was 'unknown' — free VRAM was never determined: ${JSON.stringify(models.map(m => m.fit))}`,
  ).not.toEqual(['unknown'])
})
