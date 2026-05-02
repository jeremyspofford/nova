# Capability Platform — v1 Acceptance Checklist

**Source:** spec §13 of `docs/designs/2026-05-01-nova-capability-platform-design.md` (v1 definition of done).

This is the manual walkthrough for the capability platform's first slice — autonomous failed-CI triage on a watched GitHub repo. Run it once, end-to-end, before declaring the platform shippable.

---

## Pre-flight

Before starting:

- [ ] Nova is running (`make up` or `./start`)
- [ ] You have a GitHub account that can create repos
- [ ] You have access to dashboard at `http://localhost:3000` (or your tailnet URL)
- [ ] Your orchestrator's webhook receiver `POST /api/v1/webhooks/github` is reachable from public internet (Cloudflare Tunnel, Tailscale Funnel, ngrok, or similar). For tailnet-only deploys, you'll need to expose it temporarily.

---

## Setup: create the test repo

- [ ] Create a new GitHub repo: `jeremyspofford/nova-test-cap`. Initialize with a README so `main` exists.
- [ ] Add a minimal CI workflow at `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: {}
  pull_request: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          # Will succeed on main, fail on the test branch
          test ! -f BREAK_ME
```

- [ ] Create a PAT at https://github.com/settings/tokens/new. Scopes: `repo`, `workflow`, `admin:repo_hook`. Save the token somewhere you can paste it in a moment.

---

## Acceptance criteria (spec §13)

### 1. Add a credential — encrypted, validated, healthy

- [ ] Open `Settings → Connections → Connected Services`
- [ ] Click **Add Credential**, paste the PAT, label it `nova-test-cap`, click **Add & Test**
- [ ] Verify the card shows `● Healthy` within a few seconds
- [ ] Confirm: in DB, `capability_credentials.encrypted_data` is non-null bytes (not the plaintext PAT)

```bash
docker compose exec postgres psql -U nova -d nova -c "SELECT id, label, health, scopes FROM capability_credentials WHERE label='nova-test-cap';"
```

Expected: `health=healthy`, `scopes` contains `"granted": ["repo", "workflow", "admin:repo_hook"]`.

### 2. Configure a watched repo with default trigger; approve `register_webhook`

- [ ] On the same `nova-test-cap` credential card, click **Watch a repo**
- [ ] Enter `jeremyspofford/nova-test-cap`, leave trigger mode as **Webhook + poll**, click **Add**
- [ ] (Webhook registration runs in the orchestrator on first stimulus; the dashboard's UI reaches it via the cortex drive. So no immediate pending approval — see notes below.)
- [ ] When the first `register_webhook` call fires (could be the first synthetic event), check `Approvals` page for a `register_webhook` approval card with `MUTATE` blast radius
- [ ] Approve the card
- [ ] Verify on GitHub: `https://github.com/jeremyspofford/nova-test-cap/settings/hooks` shows a webhook pointing at your orchestrator's public URL

```bash
docker compose exec postgres psql -U nova -d nova -c "SELECT repo, status, last_verified_at FROM github_webhooks;"
```

Expected: `status='verified'`, `last_verified_at` recent.

### 3-4. Push a breaking commit; approval card appears

- [ ] On the test repo, create a feature branch with a sentinel file:

```bash
git clone git@github.com:jeremyspofford/nova-test-cap.git
cd nova-test-cap
git checkout -b break-it
touch BREAK_ME
git add BREAK_ME && git commit -m "trigger CI failure"
git push -u origin break-it
```

- [ ] Wait for the GitHub Actions run to fail (~30s)
- [ ] Within ~60 seconds (webhook path), refresh the dashboard `Approvals` page
- [ ] Verify a new approval card appears for `open_fix_pr` (MUTATE) targeting `repos/jeremyspofford/nova-test-cap/pulls`
- [ ] Click **Arguments** to expand — args should show the failing run id, branch `break-it`, and a proposed diff

### 5. Approve → fix PR opens

- [ ] Click **Approve** on the `open_fix_pr` card
- [ ] Within ~30 seconds, a new PR appears on the test repo titled something like `[nova] fix CI failure on break-it`
- [ ] PR description references the failing run id

### 6. Fix-PR CI passes

- [ ] Wait for GitHub Actions to run on the fix-PR branch
- [ ] Confirm CI passes (the fix should remove `BREAK_ME` or render it harmless)

### 7. Audit trail intact

- [ ] On the dashboard, find the triage task in `Tasks`. Click the task, then the **Audit trail** link in the header.
- [ ] Verify `audit-log?task_id=…` shows a chain of events: `consent_request`, `consent_decision`, `tool_call` for `open_fix_pr`, `credential_use`, etc.
- [ ] Run a hash-chain integrity check via psql:

```bash
docker compose exec postgres psql -U nova -d nova -c "
  WITH ordered AS (
    SELECT id, prev_hash, content_hash,
           LAG(content_hash) OVER (ORDER BY timestamp, id) AS expected_prev
    FROM capability_audit
    WHERE tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  )
  SELECT count(*) AS broken_links
  FROM ordered
  WHERE expected_prev IS NOT NULL AND prev_hash <> expected_prev;
"
```

Expected: `broken_links = 0`.

### 8. Repeat on `main`; PR opens against `main`

- [ ] Push a breaking commit directly to `main`:

```bash
git checkout main
git pull
echo "force fail" > BREAK_ME
git add BREAK_ME && git commit -m "test triage on main"
git push
```

- [ ] Wait for CI to fail on `main`
- [ ] Approve the resulting `open_fix_pr` card
- [ ] Verify the new PR has `base: main` (not `base: break-it`)

### 9. Daily budget stops at 1

- [ ] In the dashboard, edit the watched repo for `nova-test-cap` and set **Daily budget** to `1`
- [ ] Push two distinct breaking commits within 24h:

```bash
echo "fail-a" > BREAK_ME && git add . && git commit -m "fail-a" && git push
# wait for CI to fail
echo "fail-b" > BREAK_ME && git add . && git commit -m "fail-b" && git push
```

- [ ] Verify exactly one approval card appears (not two)
- [ ] Check audit log for the second:

```bash
docker compose exec postgres psql -U nova -d nova -c "
  SELECT timestamp, event_type, target, response_summary
  FROM capability_audit
  WHERE event_type = 'budget_exceeded'
  ORDER BY timestamp DESC LIMIT 5;
"
```

Expected: a recent `budget_exceeded` row for `nova-test-cap`.

### 10. Test suites pass

- [ ] All capability tests pass:

```bash
make test          # full integration suite
# or just capability:
uv run --with pytest --with pytest-asyncio --with httpx --with asyncpg --with pyyaml --with cryptography --with uvicorn --with fastapi --with pydantic-settings -- pytest tests/test_capability_*.py -v
```

- [ ] Real-GitHub smoke suite passes when enabled:

```bash
REQUIRES_GITHUB=1 NOVA_GITHUB_PAT=ghp_xxx uv run --with pytest --with pytest-asyncio --with httpx --with asyncpg --with pyyaml --with cryptography --with uvicorn --with fastapi --with pydantic-settings -- pytest tests/test_capability_smoke_real_github.py -v
```

Expected: 5 passed.

---

## Cleanup after acceptance run

- [ ] Disable or remove the watched repo entry (Settings → Connected Services → trash icon on the row)
- [ ] Remove the credential (Settings → Connected Services → Remove on the card)
- [ ] On GitHub, manually delete any leftover `nova-smoke-*` branches or test webhooks if needed (the smoke suite cleans up its own; manual flows above don't):

```bash
gh api -X DELETE /repos/jeremyspofford/nova-test-cap/git/refs/heads/break-it 2>/dev/null || true
```

- [ ] Optionally archive or delete `jeremyspofford/nova-test-cap` if no further acceptance runs are planned

---

## Sign-off

- Date run: __________
- Run by: __________
- Webhook tunnel used (Tunnel/Tailscale/ngrok/etc.): __________
- All criteria passed: ☐
- Notes / deviations: __________

When every checkbox is ticked, the capability platform v1 is **shipped**.
