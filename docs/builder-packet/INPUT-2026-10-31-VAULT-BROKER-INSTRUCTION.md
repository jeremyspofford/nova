Owner instruction, 2026-10-31, that came with nova-vault-broker-design-2026-10-31.md. Verbatim below.

---

Owner input has been added to docs/builder-packet/:
nova-vault-broker-design-2026-10-31.md — Nova Vault + Credential
Broker, owner-approved. Summary of the requirement so the record is
unambiguous: Nova ships its own vault and can connect to the user's
existing password manager; Nova may use, create, and update
credentials with permission, but secret VALUES must never reach Nova
core, any model, chat, memory, logs, or the Work Ledger.

1. ADR first (docs-only PR): the broker security model is the
   critical review. Specify: the broker as a separate minimal
   component with FIXED verbs only (list_refs / use / create /
   update / rotate / bind / share_scope); origin binding enforced by
   the broker; policy (bindings, sensitivity classes, approval state)
   checked by the broker on its own authority — never on a model's
   say-so; local IPC only, no network surface; Work Ledger entries
   carry ref + target + outcome, never values.
2. Phasing, in order, nothing displacing in-flight work:
   Phase 1: broker + Nova Vault (Argon2id, per-item encryption,
   biometric/passkey unlock, OS keychain/enclave where available;
   encrypted-blob sync via hub replication; no escrow, per owner
   decision 5). Phase 2: 1Password connector behind the broker,
   dedicated "Nova" vault as the recommended sharing pattern, full
   sharing supported with the scope stated plainly first. Phase 3:
   optional Vaultwarden managed service + further connectors, by
   demand — optional install, never default.
3. Tiers: use on a bound target = Tier 1 (low sensitivity, standing
   consent) / Tier 2 or per-use (sensitive class); create, update,
   rotate, new bindings, sharing-scope changes, and any external
   manager connection = Tier 3, approval cards showing METADATA ONLY.
4. Gate evidence for Phase 1 includes the Amendment B Part 6
   canary-secret tests pointed at the vault: plant canary
   credentials and prove the values appear in NO log, memory,
   transcript, ledger entry, or backup plaintext; plus a broker
   refusal test (a credential used against a non-bound origin is
   refused by the broker even when the requester is Nova itself).
5. Honest-claims rule: external managers' automation surfaces grant
   the connecting process read capability by design; Nova's claim is
   that capability exists ONLY inside the broker process. Word the
   ADR and any user-facing copy to say exactly that — never a
   broader "Nova can never read your passwords" claim.
Record the ADR + phasing in the LEDGER and cross-link from the
relevant packet docs.
