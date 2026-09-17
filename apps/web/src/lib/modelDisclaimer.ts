/**
 * The small-model accuracy disclaimer (S3 walk-fix round 12). Owner directive
 * 2026-08-31: "Nova should probably have a disclaimer about accuracy of
 * smaller models being considerably less than larger models" — grounded in a
 * real miss where an 8B answering a Pixel-news question added an irrelevant
 * iPhone-4 tangent the search results never mentioned, a synthesis/coherence
 * limit of small models rather than a data or guard bug.
 *
 * QUALITATIVE ONLY, deliberately: no invented "% less accurate" figure or
 * made-up score appears anywhere in this file (the no-fake-numbers rail).
 * Real per-model accuracy is what S4's evals surface will produce; until
 * then this is a heads-up, not a measurement, and says so.
 *
 * One copy shared by both surfaces so the claim can't drift between them:
 * Settings -> Models (ModelsSection, prominent) and the inline chat picker
 * (ModelSelector, light caption).
 */

export const ACCURACY_DISCLAIMER =
  'Smaller and local models trade some accuracy for speed and privacy: they are ' +
  'noticeably more likely to wander off-topic, add a tangent the source material ' +
  'never mentioned, or state something incorrect than larger models. For anything ' +
  "where being right matters, prefer a larger model. This is a qualitative " +
  "heads-up, not a measurement — real per-model accuracy numbers are coming with " +
  'the evals surface.'

/** Appended to ACCURACY_DISCLAIMER in Settings when the currently-selected
 * model is on the smaller end of the catalog (see modelsFormat.isSmallerTier)
 * — still no number, just naming what's already true of the current pick. */
export const ACCURACY_DISCLAIMER_CURRENT_IS_SMALLER =
  "The model in use right now is on the smaller end of what's offered here."

/** The inline picker's compact caption — one line, no paragraph, discoverable
 * when the dropdown is open rather than cluttering the always-visible trigger. */
export const ACCURACY_DISCLAIMER_SHORT =
  'Smaller models trade some accuracy for speed — prefer a larger one when it must be right.'
