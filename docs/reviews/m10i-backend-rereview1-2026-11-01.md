## Finding verdicts

- **I1 — Fresh unrelated reports refresh stale no-live readiness: ADDRESSED.** `src/core/services/topology.ts:158` selects ready-version IDs and `:161` selects only their valid report timestamps. The original no-live case retains the old readiness timestamp. Model and real API regressions cover fresh unrelated failed/installed reports and preserve the hour-old age (`tests/core/topology.test.ts:79`, `tests/core/topology-api.test.ts:90`); the API test also checks recovery after the ready version itself reports again.

## New breakage in the fix diff

- **Important I2 — Candidate readiness now overwrites a stale live observation when live health is null.** `src/core/services/topology.ts:165` enables the readiness path for every null health result, including when `s.live` is non-null; `:166` consequently replaces the existing live report timestamp with the candidate's timestamp. Reproduced with live v1 / health=null / report at 11:00, ready v2 / report at 12:00, and capture at 12:00: the returned live v1 service becomes healthy/Verified with age 0, although its live report is an hour old. Before this fix, `o.at` preserved the stale live report time and normalization returned unknown. This newly bypasses the old-live freshness safeguard and can make actions available from a stale serving observation. Restrict the readiness timestamp substitution to the no-live case, preserving the live observation, or explicitly retain both observations and apply the worse/stale rules. Add a null-health live-version regression alongside the no-live regression.

## Out-of-scope observations

- None newly identified. M1 warning attribution remains controller follow-up; prior full-suite failures and UI/budget gates remain outside this fix review.

## Checks

- Reviewed only `e9062236..b61ace15888e281f3729aa406b9365353a8a4670` through the supplied fix package and appended report, using the previously read task constraints. No broad re-review, source rereads, git commands, or suite reruns.
- Existing `/tmp/m10i-task2-i1-red.log` records 12 tests, 10 pass, 2 fail with actual healthy versus expected unknown. Existing `/tmp/m10i-task2-i1-green.log` records 12/12, zero failures/skips, and no-Kubernetes tripwire never fired. The typecheck log contains the reported tsc invocation without errors.
- Ran one specific pure-projection probe for I2 using Node 26.3.1, `projectService`, and `buildTopology`; it returned live=v1, health=healthy, status=Verified, observation at=12:00/age_ms=0, while v1 retained observed_at=11:00 and v2 observed_at=12:00. No application server or suite was run.
- Only this requested review artifact was written; source/index/branch state was not mutated.

## Verdict

**Fix round: Findings remain open — I2.** I1 is addressed; the fix introduces a new Important regression in the live-version freshness path.
