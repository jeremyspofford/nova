# T1-03: CI Triage End-to-End Automated Test

**Tier:** 1  **Size:** M  **Blocks:** none  **Blocked by:** T1-01, T1-02

## Why this task exists

Closes P6 from `docs/audits/2026-05-03-readiness-assessment.md`. The only proof
that the full "GitHub CI failure → Nova PR" flow works is a manual walkthrough
in `docs/capability-acceptance-checklist.md`. There is no CI-runnable test that
pushes a real commit, waits for Nova to open a PR, and asserts the PR exists.
Until this test exists, every release is based on trust that the end-to-end seam
is intact.

The production-shape scenario that fails today: after shipping T1-01 and T1-02,
the full loop works in isolation tests but has never been exercised from a real
GitHub Actions failure all the way through to an opened PR. One migration change,
one routing error, or one redaction-of-execution-args bug would silently break it.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_e2e_ci_triage.py`

**Test name:** `test_full_ci_triage_loop_opens_pr`

**Assertions in plain English:**
1. `REQUIRES_GITHUB=1` and `NOVA_GITHUB_PAT=ghp_xxx` are set; otherwise the test
   is skipped via `pytest.mark.skipif`.
2. A `capability_credentials` row for `jeremyspofford/nova-test-cap` exists (or is
   created by the fixture and torn down after).
3. A watched repo row for `nova-test-cap` exists with trigger=`both`.
4. A webhook is registered for `nova-test-cap` pointing at the orchestrator's
   `/api/v1/webhooks/github` endpoint (public URL from `NOVA_PUBLIC_URL` env var).
   If the webhook registration returns `consent_pending`, the test approves it
   automatically (testing the full consent flow is T1-02; this test accepts the
   auto-approve path if a consent rule already exists, otherwise creates one).
5. The test pushes a synthetic breaking commit to `nova-test-cap` via the GitHub
   API (create a file with a known syntax error, or push to a branch that triggers
   a failing workflow). Uses `nova-test-e2e-{hex8}` as the branch name for cleanup
   isolation.
6. The test polls `GET /api/v1/capabilities/approvals` for a new pending approval
   with `tool_name="open_fix_pr"`, waiting up to 120 seconds (webhook path) or 960
   seconds (polling fallback). If `NOVA_WEBHOOK_E2E=1` is also set, the polling
   window is 30 seconds (webhook expected).
7. The test approves the approval card: `POST /api/v1/capabilities/approvals/{id}/decide`
   with `{"decision":"approve"}`.
8. Within 60 seconds of approval, a GitHub PR exists on `nova-test-cap` referencing
   the failing commit. Poll `GET /repos/jeremyspofford/nova-test-cap/pulls?state=open`
   to confirm.
9. Teardown: close the PR, delete the test branch, optionally unregister the webhook.

**Additional test:** `test_ci_triage_budget_cap_skips_second_failure` — sets
`cortex_watched_repos.daily_budget=1`, triggers two failures in sequence; asserts
the second does not produce an approval card; asserts `capability_audit` has a
`budget_exceeded` event for the second run.

Both tests require `REQUIRES_GITHUB=1`. They are marked `@pytest.mark.slow` and
`@pytest.mark.requires_github` (new marker registered in conftest). Not run in
normal `make test`; run explicitly with `REQUIRES_GITHUB=1 pytest -m requires_github`.

## Files this task will touch

- **`tests/test_capability_e2e_ci_triage.py`** — new file, 2 tests.
- **`tests/conftest.py`** — register `requires_github` marker:
  `config.addinivalue_line("markers", "requires_github: skip unless REQUIRES_GITHUB=1")`.
  Add a `pytest_collection_modifyitems` skip rule for tests marked `requires_github`
  when `REQUIRES_GITHUB` is not set.
- **`tests/fixtures/github_e2e.py`** — helper functions for the e2e test:
  `push_breaking_commit(repo, branch, pat)`, `get_open_prs(repo, pat)`,
  `close_pr(repo, pr_number, pat)`, `delete_branch(repo, branch, pat)`.
  Uses `httpx.AsyncClient` directly against `api.github.com` (not Nova's tool layer).
- **`docs/capability-acceptance-checklist.md`** — add a note at the top: "As of
  T1-03, steps 1-7 are automated in `tests/test_capability_e2e_ci_triage.py`.
  Manual validation is only needed when `NOVA_PUBLIC_URL` is not externally
  reachable."

## Implementation outline

1. Register the `requires_github` marker in `tests/conftest.py`. Add the skip
   hook for `REQUIRES_GITHUB` env var. Confirm `test_capability_smoke_real_github.py`
   uses `REQUIRES_GITHUB` — align the env var name.

2. Write `tests/fixtures/github_e2e.py` with four async helper functions using
   `httpx.AsyncClient`. These call `api.github.com` directly — they are the
   production data scaffolding, not boundary fakes.

3. Write `test_full_ci_triage_loop_opens_pr`:
   a. `@pytest.mark.requires_github`, `@pytest.mark.slow`, `@pytest.mark.asyncio`.
   b. Credential + watched repo setup via existing `POST /api/v1/capabilities/credentials`
      and `POST /api/v1/capabilities/credentials/{id}/watched-repos`.
   c. Webhook registration: call `POST /api/v1/webhooks/github/register`. If 202, call
      `POST /api/v1/capabilities/approvals/{id}/decide` with `approve + remember +
      rule_scope = {"target_glob":"repos/jeremyspofford/nova-test-cap/*"}`.
   d. Push breaking commit via `github_e2e.push_breaking_commit()`.
   e. Poll `GET /api/v1/capabilities/approvals` with 5-second intervals until a
      pending `open_fix_pr` approval appears or timeout.
   f. Approve the card.
   g. Poll `github_e2e.get_open_prs()` for up to 60 seconds.
   h. Assert PR count > 0 and PR title references the failing branch.
   i. Teardown in `try/finally`.

4. Write `test_ci_triage_budget_cap_skips_second_failure` — set budget to 1 via
   `PATCH /api/v1/capabilities/watched-repos/{id}`, trigger two commits, assert
   behavior described in seam test above.

5. Update `docs/capability-acceptance-checklist.md` header.

## Behaviors the implementation must NOT change

- `tests/test_capability_smoke_real_github.py` (5 tests) must still pass when
  `REQUIRES_GITHUB=1` is set — this test does not replace the smoke tests.
- The `make test` target must not run `requires_github` tests — they require external
  network and a real GitHub repo.
- `tests/conftest.py` changes must not affect the skip logic for `requires_llm` or
  `requires_local_ollama` markers.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. Confirm the new marker is registered and tests skip cleanly without REQUIRES_GITHUB
pytest tests/test_capability_e2e_ci_triage.py -v
# Expected: 2 tests SKIPPED with "REQUIRES_GITHUB not set"

# 2. Confirm make test does not pick up the new tests
make test 2>&1 | grep -E "e2e_ci_triage|PASSED|FAILED|ERROR" | head -10
# Expected: no mention of e2e_ci_triage

# 3. (Requires REQUIRES_GITHUB=1 and real PAT — run manually, not in CI)
# REQUIRES_GITHUB=1 NOVA_GITHUB_PAT=ghp_xxx NOVA_PUBLIC_URL=https://your-nova-url \
#   pytest tests/test_capability_e2e_ci_triage.py::test_full_ci_triage_loop_opens_pr -v -s

# 4. Existing smoke tests still work
REQUIRES_GITHUB=1 NOVA_GITHUB_PAT=ghp_xxx pytest tests/test_capability_smoke_real_github.py -v

# 5. Confirm conftest marker registration
pytest --co -q tests/ 2>&1 | grep "requires_github" | head -5
```

## Out of scope

- Automated execution in CI/CD (no public URL in GitHub Actions). The test is
  opt-in only.
- Testing the "bug on main" branch heuristic (spec §13 criterion 8). That is a
  second E2E test and a separate story.
- Performance benchmarking (criterion: PR opens within 60s of approval — not a
  hard SLA the test enforces; it's a polling window).

## Risks / unknowns

- `NOVA_PUBLIC_URL` must be externally reachable for the webhook path to work. If
  it is not set, the test should fall back to polling mode (wait 960s) and print a
  warning. Do not fail the test setup if `NOVA_PUBLIC_URL` is absent — degrade to
  polling mode with `@pytest.mark.slow`.
- The breaking commit: the test repo `nova-test-cap` must have a CI workflow that
  can fail deterministically. If the workflow does not exist, the test cannot
  trigger a `workflow_run.failure` event. Document the required workflow file in
  the test's module docstring and check for its existence in the fixture setup.
- `push_breaking_commit()` needs write access to `nova-test-cap`. The PAT must
  have `repo` and `workflow` scopes. Add a preflight check in the test fixture
  that calls `GET /user` and asserts the granted scopes include `repo`.
