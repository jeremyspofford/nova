# M10b gate evidence: Nova Browser

The ADR is `docs/plans/M10.md` (its M10b section and Hard limits), and the plan is
`docs/plans/M10b.md`. Everything here ran on 2026-10-31. The browser tests ran in Chromium inside
the Playwright image (`mcr.microsoft.com/playwright:v1.56.1-noble`) through `scripts/ui-test.sh`,
because this machine's own Playwright Chromium can't start (it lacks `libnspr4`, and no system
package was installed). CI's UI gate runs the same tests in the same image.

Every site is a stand-in on loopback (`scripts/stand-ins/shop-site.js`): a shop, a sign-in page, a
CAPTCHA page, a page with an injected dialog and alert, a pre-ticked upsell, and a pay trap. Every
request it gets is in its server log. Credentials are random fakes made per test
(`example-user-…`, `example-pw-…`) and kept in that test's temp vault. No real site, account,
login, purchase or post was touched.

## Suite

SUITE_PLACEHOLDER

The gate's tests:

| File | Tests | What it proves |
|---|---|---|
| `tests/core/browser-m10b.test.ts` | 13 | Money and totals, pay controls, the validator's refusals, tiers, login and a11y steps, upsells, obstacles, intent, the co-pilot template, ground truth over a probability, the redactor, vault names |
| `tests/core/browser-m10b-flows.test.ts` | 4 | A learnt flow through the template path in a real core; the rule; a template that presses pay is refused; sign-ins never returned |
| `tests/ui/m10b-login.test.ts` | 1 | Gate 1, with a stand-in local model: the fake secret is nowhere; kept per site; forgotten |
| `tests/ui/m10b-checkout.test.ts` | 3 | Gates 3, 4, 5 |
| `tests/ui/m10b-page.test.ts` | 4 | Gate 2 with and without a model; a CAPTCHA; a model against the ground truth |
| `tests/ui/m10b-flows.test.ts` | 2 | Gates 6 and 7 |
| `tests/ui/m10b-settings.test.ts` | 1 | Settings › Site sign-ins in the PWA: save, list without the value, forget |
| `tests/ui/m10b-vision.test.ts` | 1 | Vision only as a marked fallback; a picture's point that pays is refused |
| `tests/ui-takeover.test.js`, `tests/ui-fixes.test.js` | +2 | Pause, Stop and Carry on in the takeover sheet; the Settings part and its search words |

`tests/acceptance/fresh-user.test.ts` passes unchanged.

SEEN_FAILING_PLACEHOLDER

## Gate items

GATE_PLACEHOLDER
