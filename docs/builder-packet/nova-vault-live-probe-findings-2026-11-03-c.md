# Vault PR #275 — independent live-probe review (Findings Set C, 2026-11-03)

Reviewer: Claude (independent; not the builder). Read-only; no
edits/commits/pushes. Source under test: `5f495fbd` (PR head).
Isolation: real `startBroker()` processes, empty env, 0600 Unix
socket, mktemp homes, synthetic canary credentials only; no real
Nova home/vault/keychain touched. Full verbatim probe logs are in
Jeremy's paste to Muse (2026-11-03, Nova chat) and in the
reviewer's scratchpad on the Dell (probes/ folder).

## Bottom line
**No Critical, High, or Medium defect reproduced** against the
broker's own claims (C2–C9) under live execution. **Findings A
(SEC-01..05) and B (B1–B6, Low1–Low5) all hold live.** Low6
(perf/IO) not probed. C1 (whole app) not testable at broker scope
and not met — per the packet itself, Core and plaintext forms
still handle credentials until P1b.

## The CI failure is NOT a security finding (verified live)
Run 41631035275: only the npm test step failed; lint and
typecheck passed (no output from them in the failed-step log).
1901 tests: 1885 passed, 2 failed, 14 skipped. UI gate passed.
- `broker-owner-findings-b-launch.test.ts:53` (B3): **fixture
  race** — the test reads `pids.json` the moment `existsSync()`
  turns true, but the Python fixture creates the file empty
  before `json.dump` writes it → `SyntaxError: Unexpected end of
  JSON input`. Reproduced live; with a race-free fixture
  (write-temp-then-rename) the same B3 scenario passed its
  security properties 3/3 against a real broker. Fix: write-then-
  rename in the fixture, or poll until JSON parses.
- `broker-seal-module.test.ts:17`: Playwright
  `chromium_headless_shell-1194` not installed in the CI runner.
  Environment problem, not a broker result.

## Findings for the builder (all Low)
- **F1 — scrubber misses JSON `\uXXXX` escapes.** `src/broker/scrub.ts`
  `formsOf` has only `JSON.stringify(v).slice(1,-1)` and the `\/`
  variant. Go's default HTML-safe JSON escaping (`<`, `>`, `&` →
  `\u003c` etc.) and Python's `json.dumps` ensure_ascii (non-ASCII
  → `\uXXXX`) both came back to core unscrubbed; the value is
  exactly recoverable by `JSON.parse`. Same precondition as
  SEC-03 (ordinary echoing target). Exposure: sealed (person-typed)
  values, custom alphabets, non-ASCII passphrases — generated
  values are unaffected. Fix: add the form escaping every
  non-ASCII char and `<>&'` as `\uXXXX`, lower- and upper-case hex,
  per UTF-16 code unit. (If the builder rules this a stated limit,
  the packet's "JSON-escaped" wording must say so explicitly.)
- **F2 — rename can take over another credential's name.**
  `src/broker/broker.ts` `#update` meta branch (~line 547) never
  checks the alias collision that `#create` enforces. After
  renaming BETA → `provider/ALPHA`, `list_refs` shows two items
  with `secret://provider/ALPHA` and `use()` resolves to the
  renamed BETA — consumers silently spend the wrong credential
  (confined by C3 to BETA's bindings). Fix: refuse a new name
  whose alias any other item holds, same check as `#create`.
- **F3 — hub-pin card fingerprint can't be checked.**
  `#pinHub` card shows `sha256(signer base64 text).slice(0,16)` —
  64 bits over the text, not the key bytes — and the hub's
  `state()` exposes no signer fingerprint at all, so the
  comparison stated limit 6 relies on cannot be made. (B1 holder
  side does this correctly: full decoded-key SHA-256 both sides.)
  Fix (can schedule to P1b, but fix limit 6's wording now): full
  SHA-256 of the decoded Ed25519 public key on the card + expose
  it in hub `state()` (add key name to ANSWER_KEYS).

## Notes (no Phase-1 fix required; triage for builder)
- N1: `addressClass` treats IPv4-compatible `::/96` and Teredo
  `2001::/32` as public — on a host with sit0/Teredo routes these
  could reach an embedded private IPv4. Suggest classing both
  private. (Nothing reached on the test host: ENETUNREACH.)
- N2: double-encoded path `%252f` is in scope (single decode); a
  double-decoding target could escape scope. Consider refusing
  `%25` + encoded 2f/5c/2e.
- N3: non-ASCII request paths pass through as raw latin-1 bytes;
  no scope escape; consider requiring ASCII in requestPath.
- N4: flood problem flag in `state()` never clears after the
  flood window (diagnostics only).
- N5: SIGKILLed launcher discards its held-back scrubber tail →
  timed-out program's stdout returns empty. Fail-safe, no leak.
- N6: a bad sealed envelope spends the single-use approval before
  the open fails — fail-closed; availability only.
- N7: target-side transforms (e.g. upper-casing) defeat scrubbing
  — consistent with stated limits.

## Per-claim results (live)
C2 pass with F1 · C3 pass (notes N2/N3) · C4 pass with F2 ·
C5 pass with N1 · C6 pass · C7 pass · C8 pass with F3 ·
C9 pass · C10 pass (static). SEC-01..05 hold; SEC-06 as
documented. B1, B2, B3 (3/3 race-free), B4, B6 hold; B5 not
probed (file mode only, by design). Low1–Low5 hold; Low6 not
probed. Every probe FAIL line was investigated: all were probe
expectations the live result disproved (harness artifacts),
none a broker defect.
