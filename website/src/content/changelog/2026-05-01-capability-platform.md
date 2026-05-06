---
title: "Capability Platform — credentialed tools, consent gate, audit log, autonomous CI triage"
date: 2026-05-01
---

The Capability Platform (M11) gives Nova the safe-by-default rails to act on external systems with user consent: a credential vault, an HMAC-signed audit log, a consent-gate workflow, and the first end-to-end autonomous "see a failing CI build → propose a PR" loop.

- **Encrypted credential vault.** A `platform_secrets` store with per-secret AES encryption (master key auto-bootstrapped on first install) holds OAuth tokens, GitHub PATs, and service credentials. Secrets are referenced by name; runtime fetches happen via `PlatformSecretsResolver` so the orchestrator and worker services no longer read raw API keys from `.env`.
- **Hash-chained audit log.** Every credentialed action — credential read, tool execution, approval decision — appends to an append-only audit log with a SHA-256 hash chain that ties each row to the previous. The maintain drive in cortex verifies the chain daily and pages on tampering.
- **Consent gate.** New `external` tools declare a tier — READ (auto), PROPOSE (auto), MUTATE (consent required) — and MUTATE calls land in an `approval_requests` queue. The dashboard's Approvals panel shows pending requests; a single approval/denial closes the loop, and a worker resumes the originating agent goal automatically. "Approve and remember" rules let users pre-authorize categories of action.
- **GitHub provider, four tiers.** Twelve `github_external` tools cover READ (list_repos, get_pr, get_check_runs), PROPOSE (open_draft_pr, comment_on_pr), MUTATE (open_pr, merge_pr, close_pr), and SETUP (register_webhook, add_collaborator). Granted PAT scopes are captured at validation time; tools surface `scope_mismatch` warnings before attempting privileged calls.
- **Autonomous CI triage drive.** Cortex's new `ci_triage_agent` pod watches GitHub webhooks → check_run failures dispatch a stimulus → the goal pipeline proposes a fix PR. A singleton-elected polling worker provides a fallback when webhooks lag. The drive enforces a per-cycle cost budget and audits its own actions.
- **v1 release gate closed.** Commit `cf26c927` lands the automated end-to-end test that proves the full webhook → cortex → goal → PR loop works without human intervention on the happy path. This is the milestone where Nova first acts autonomously on a user's repo.

If you're upgrading: connect a GitHub PAT in the Settings → Connections panel, then watched_repos in the Connected Services section. The Approvals panel shows what Nova wants to do; nothing MUTATEs without explicit approval (or a matching auto-approve rule).
