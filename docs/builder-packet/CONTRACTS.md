# CONTRACTS — the interfaces everything honors

Contracts are versioned. A breaking change requires a new major version and a migration note. Builders treat this file as normative.

## 1. Task envelope (brief-in / report-out)
Every unit of delegated work — to an external agent, a worker service like Relay, a sub-agent, or a tool — uses the same envelope.

**Brief** (Nova → worker): `task_id`, `goal` (plain-language outcome), `context_refs` (pointers to memory/files, not dumps), `constraints` (privacy mode, budget, deadline, allowed tools), `privacy_mode`, `approval_tier`, `evidence_required` (what proof the report must carry), `idempotency_key`.
**Report** (worker → Nova): `task_id`, `status` (done / partial / blocked / failed), `summary` (high-level, human), `evidence[]` (typed: test result, file diff, read-back, screenshot, URL, confirmation id), `artifacts[]`, `blockers[]`, `usage` (model, tokens, cost, duration), `follow_up_suggestions[]` (advisory only).

Rules: a worker never talks to the user directly; Nova verifies evidence before marking done; a failed report is data, not a dead end — it feeds replanning.

## 2. Context receipt
For every System-2 call: `task_id`, `provider/model`, `context_items[]` (what memory/files/history were included, as references + hashes), `purpose`, `privacy_mode`, `egress` (local / named remote). Receipts are stored, user-visible, and are the audit answer to "what did Nova tell that model about me, and why?"

## 3. Decision template (System 1)
A versioned, cached schema for a recurring decision: `template_id`, `version`, `situation`, `inputs` (typed), `questions[]` (typed: Choice ≤255 options / Score / Noul / Box), **mandatory escape on every Choice: an `unknown/other` option, or a companion Noul asking whether any option fits (preferred for Jev 1.14)**, `escalation` (confidence floor → System 2), `stats` (uses, agreement with outcomes, calibration drift).
Rules: templates are authored **on cache miss only**, by a cheap authoring model or a human, then validated (schema check + dry runs) before activation. Never generate a schema per-request. Templates whose calibration drifts beyond threshold are retired and re-authored. Template creation is itself a ledger task with evidence.

## 4. Extension manifest
Every extension (connector, MCP server wrapper, plugin, skill pack, automation adapter, design system) declares: `id`, `version`, `kind`, `capabilities[]`, `permissions[]` (data read/write scopes, network egress, device actions), `secrets[]` (names only — values live in the vault; under the Credential Broker (`docs/plans/vault-broker.md`) each name is a ref the broker resolves, and an extension is given uses, never values), `config_schema`, `setup_flow`, `health_check`, `nova_compat` (version range), `on_remove` (what is deleted, what is kept, what is exported). See EXTENSION-MODEL.

## 5. Device enrollment
One protocol, three front doors (QR code / hub URL + confirmation code / one-line command):
1. The joining device generates its own Ed25519 keypair; the private key never leaves it.
2. The front door proves presence (scan / typed code / command output) and carries the public key + device claims (name, platform, capabilities).
3. **The hub shows an approval prompt** (device name, platform, requested capabilities, fingerprint). Enrollment completes only on hub-side approval. This prompt is the security gate.
4. Codes are short-lived and single-use; the code is entered only at the hub's own verified address.
Result: a device record (id, pubkey, capabilities, trust level, last-seen) in the mesh registry; revocable at any time from any authorized client.

## 6. Event and trigger records
`trigger_id`, `class` (reactive/proactive/event/heartbeat), `source`, `payload_ref`, `triage_decision` (act/queue/silent/drop + reason + decision-model reference), `dedup_key`, `cooldown_until`, `ledger_task_id` (when work results). Every proactive contact Nova makes must trace to a trigger record.

## 7. Memory record
`id`, `kind` (timeline/entity/fact/preference/decision), `content`, `provenance` (source, observed_at, recorded_by), `confidence`, `scope` (book/space), `supersedes`, `expires` (optional), `user_state` (confirmed / unreviewed / corrected). Users can inspect, correct, and delete; corrections supersede, they don't silently rewrite history.

## 8. Design-system package
See DESIGN-SYSTEM §4: manifest + full semantic token set + component specs + content rules. Validated complete before it may be applied.
