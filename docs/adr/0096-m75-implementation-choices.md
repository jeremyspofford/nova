---
status: accepted
date: 2026-10-19
extends: ADR-042 (firmware off by default), ADR-043 (out-of-band off by default), ADR-075 (integration hygiene), ADR-093 (M6), ADR-094 (M6.5), ADR-095 (M7)
amends: `contracts/hub-api.md` §3 (the Hub → `novad` management channel is mutual TLS for a device that holds a certificate) and §4 (the per-user bridge socket); closes R-022 for devices with a certificate
---

## Context
M7.5 built low-level boot with PXE (FR-143), BIOS and firmware management (FR-146) and
out-of-band management (FR-147), and the device modules carried in from M6: the local browser
fallback (FR-209), the extension bridge (FR-096), mutual TLS on the management channel and
device certificate renewal (FR-126, FR-192), decommission and `novad uninstall` (FR-140), the
device operations routes the M6 UI lacked (FR-142, FR-145, FR-148, FR-150) and the compute node
leftovers (FR-126: VRAM, quiet hours, `/node/v1/services`). `novad` is 0.7.0. Three security reviews
(privileged device actions, browser fallback and bridge, out-of-band and PXE) found defects; the
fixes are folded into the decisions below and the rest are listed under Known limitations. The
sections D1-D10 follow the build protocol, and the code cites them as "ADR-096 D<n>". The details are
in `docs/23`, `docs/11` §4.3 and §4.6, `docs/12`, `docs/22` §5, `docs/06`, `docs/14`, `docs/04` and
in `contracts/hub-api.md` §1-§6, `contracts/events.md` and `contracts/schemas/server-request.json`;
the entry in [`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md) links here.

## Decision

### D1. The management channel gets mutual TLS (FR-126, FR-192, R-022)
1. **On the device.** `novad`'s management server (port 7420) serves TLS 1.3 only, with rustls,
   when the device holds `device-cert.pem`, and only then; a device without one stays plain HTTP.
   It requires a client certificate that chains to the Hub CA it cached, carries EKU clientAuth and
   the URI SAN `urn:nova:hub:<pin>`. The management token is still checked (defense in depth). There
   is no fallback to plain HTTP; whether a device serves TLS is decided when `novad` starts.
2. **The Hub's client certificate** is issued by its own local CA: URI SAN
   `urn:nova:hub:<fingerprint>`, clientAuth, 90 days, renewed with the TLS leaf. It is kept in the
   vault (`secret://hub/client-certificate`), not in `trust_certificate`, so no device route ever
   accepts it. The Hub's pinning check (`checkHubIdentity`) refuses any server certificate carrying
   a `urn:nova:` URI SAN, so neither a device certificate nor this one can pass for the Hub.
3. **The Hub's management client** connects over TLS 1.3 with no session reuse and verifies the
   device by chain to the Hub CA, the URI SAN `urn:nova:device:<id>` equal to the row's id, the
   pinned key and the recorded serial, never by host name (LAN addresses move). A connection reset
   right after the handshake, or a non-TLS answer, counts as `handshake_failed`. Failures are 403
   `policy_denied` `{reason: device_tls_failed, tls}` and never fall back to plain HTTP.
4. **No downgrade.** `novad` registers and heartbeats an `https://` endpoint once it holds a
   certificate. An https endpoint is accepted at registration only with a live certificate; a
   device that registered https is never called over http, and a heartbeat offering http is 403
   `policy_denied` `{reason: endpoint_downgrade}` (audited `device.endpoint.refuse`). A plain-HTTP
   address is never moved by a heartbeat.
5. **Device certificates carry both purposes** (serverAuth and clientAuth) from M7.5 on.
6. **Legacy certificates.** M7 device certificates have clientAuth only, which OpenSSL refuses as
   a server certificate. The Hub then opens a second TLS 1.3 connection and checks the certificate
   itself before sending anything: it must be byte for byte the one the trust area recorded for
   the device, unrevoked, in date, with the device's URI SAN and pinned key. That acceptance ends
   once a renewal has existed for 10 minutes or the device presents the new certificate; then the
   answer is `unsupported_purpose`. `novad` serves such a certificate anyway and logs a notice.
7. **Renewal.** The heartbeat answer carries `certificate: {pem, notAfter}` while the device's newest
   certificate lacks serverAuth or has less than a third of its life left (device certificates
   live 365 days), with the same key, device id and role, until the device presents it; then the
   older ones are revoked (reason `renewed`). `novad` swaps it in only if it chains to the cached
   Hub CA, is valid now, has both purposes, holds the device's own key and names the device; a
   refusal is logged and the old certificate kept. The swap is an atomic write (0600); new
   connections use the new certificate, and `novad`'s own calls to the Hub rebuild their TLS
   context. A device without a certificate never gets one through a heartbeat (renewal only).
   `notAfter` is informational: the certificate's own validity counts. The management channel view
   reports the renewal (`none`, `offered`, `presented`) and when the old certificate stops being
   accepted, and diagnostics flag a device that let the grace pass without installing it.

### D2. Privileged device actions carry a Hub-signed authorization
8. **Which actions.** Firmware apply and rollback, boot set, commit and revert, and decommission.
   `novad` refuses them without a valid authorization, whatever the management token says.
9. **The object** `{v: 1, kind, deviceId, changeId, bodySha256, approvalId, issuedAt, expiresAt}`
   in canonical JSON (sorted keys, no whitespace, UTF-8), signed with Ed25519 by the Hub identity
   key over `"nova-device-authz-v1\n" + canonicalJson` (base64url), sent as the body field
   `authorization: {payload, signature}`. `bodySha256` is the hex SHA-256 of the canonical body
   without `authorization`; a body hash computed without `adminPassword` is also accepted, so a
   hash never has to cover a secret (the Hub leaves it out). `expiresAt` is at most 10 minutes
   after `issuedAt`; both may be ISO strings or epoch milliseconds; `changeId` is a fresh UUIDv7.
10. **The device's check.** The pinned Hub key (read from `/api/v1/hello`, cached in `hub-key.json`
    only if it hashes to the pin), its own device id, the kind matching the route, the body hash and
    the time window with 120 s of skew ("not valid yet" counts as `authorization_expired`). Used
    change ids are kept 24 hours in `authz-replay.json` (at most 4096): a replay is 409
    `{reason: replayed}`; a replay store that cannot be read refuses every privileged request
    (500 `{reason: replay_store_unreadable}`). Refusals are 403 `policy_denied` `{reason:
    authorization_invalid|authorization_expired|authorization_mismatch}`.
11. **The Hub signs** only for the owner's own request, with the action's toggle on, after an
    approval record for exactly this change is approved by the signed-in owner, for a device that
    is not revoked. The signer and verifier are `packages/core/src/firmware/authz.ts` and
    `services/novad/src/authz.rs`; four fixed vectors (`apply`, `rollback`, `boot.set`,
    `device.decommission`) in `packages/core/test/fixtures/device-authz-vectors.json` are verified by
    both sides (the crate keeps a copy, and a CI test fails when they differ).
12. **Transport.** A device that holds a certificate refuses privileged requests over plain HTTP
    (403 `policy_denied` `{reason: tls_required}`); firmware apply and rollback refuse a body with
    `adminPassword` over plain HTTP before anything else runs.

### D3. Toggles, consent and Hub-only approvals
13. **Switches** (all `security: true`, owner-only, off by default): `devices.firmware.allowChanges`,
    `devices.firmware.allowSecurityDegrading` (the separate override for turning Secure Boot or the
    TPM off), `devices.firmware.watchdogSeconds` (600, 120-3600), `devices.boot.allowLowLevel`,
    `devices.boot.watchdogSeconds` (600, 120-3600), `devices.pxe.enabled` and
    `devices.oob.enabled`. Firmware has its own watchdog length because a restart into new
    firmware settings goes through the BIOS start-up and may need a different window than a boot
    trial.
14. **Consent.** Turning on the two firmware switches, the low-level boot switch or PXE needs
    `confirm: true`, on their own routes and on `PATCH /api/v1/settings` alike (else 403
    `policy_denied` `{reason: consent_required}`); out-of-band turns on only through
    `POST /api/v1/oob/enable {confirm: true}` and the settings route refuses it. A security
    setting changed through the Hub's settings writer carries before, after and `confirmed` in its
    `settings.changed` event; the ops subscriber's `setting.changed` audit entry, with the same
    values, is the change's only entry. The settings route, the firmware policy route and
    `oob/enable|disable` all write through it (`oob/enable` passes its consent as `confirmed`).
15. **The device learns its switches** from the heartbeat answer `policy: {firmwareChanges,
    lowLevelBoot}`, kept in `policy.json` (deleted at enrollment; only `true` counts; a heartbeat
    `policy` sets both, a heartbeat without one keeps the last values). It refuses apply and
    rollback while `firmwareChanges` is false (403 `firmware_disabled`) and boot set and commit
    while `lowLevelBoot` is false (403 `policy_denied` `{reason: low_level_boot_off}`), even with a
    valid authorization. Revert and the watchdogs' own restores always work.
    **The Hub also pushes them**, so a change sent right after the owner turns a switch on is not
    refused: `POST /agent/v1/config` accepts `policy: {firmwareChanges?, lowLevelBoot?}`; a toggle
    present sets the value (only `true` turns it on), an absent or null one keeps it, toggles sent
    alone leave the per-device policy (`allowedModules` and the rest) as it is, and the answer
    always carries the `policy` in effect. When `devices.firmware.allowChanges` or
    `devices.boot.allowLowLevel` changes, the devices area pushes the two toggles to every active
    device with an endpoint (one that cannot be reached takes them from its next heartbeat answer).
    Before each firmware apply and rollback and each boot set and commit, `DeviceService.syncPolicy`
    pushes them when what the device last confirmed differs; if the device still refuses for the
    toggle, the Hub pushes again and retries once with a freshly signed authorization (a new change
    id). If it still refuses, the answer is 409 `conflict` `{reason: device_policy_stale}`
    (retryable) and the approval is not spent: the firmware change stays approved and can be applied
    again, and a boot request goes back to waiting (its decision cleared, the reason shown), and the
    boot sweep sends it again until it expires.
    **Accepted trade-off:** whoever holds a device's management token can now set the device-side
    toggles through `/agent/v1/config` (before, only the Hub's heartbeat answer could). That removes
    only the device-side half of the double check; every firmware and boot change still needs the
    Hub-signed authorization over its exact body (D2), which the token cannot make.
16. **Hub-only approval cards.** Firmware, boot, out-of-band and decommission cards set
    `approval.answer_in = 'hub'` (`ApprovalView.answerIn`; the view also gains `scope`, such as
    `device:<id>`, so a card can link to its device). The approvals gate refuses any decision
    on such a card not made by the signed-in user (403 `policy_denied` `{reason: hub_only}`), so
    channel buttons, replies, signed email links, hooks and system decisions cannot answer them; a
    signed link shows nothing and the attempt is audited (`channel.approval.refused`); channel and
    email prompts carry no buttons or link and say to answer in the web or desktop app; push only
    opens `nova://approval/<id>`. Each area also re-checks `decided_by = 'user'` in the table before
    acting, and every approval is used once.
17. **No model tools.** No model-facing tool plans, approves or applies firmware, boot or
    out-of-band changes; they are never proactive or autonomous. Read-only inventory is shown in the
    UI only.

### D4. Firmware (FR-146)
18. **Read, plan, apply, rollback** on `novad` (`/agent/v1/firmware/*`). Reading and planning work
    with the toggle off on the device (reading changes nothing), but only while the `firmware`
    module is allowed for the device; the Hub refuses to plan while its toggle is off. The
    capability document lists `firmware` only when a backend works.
19. **Canonical keys** `wol`, `powerOnAfterPowerLoss`, `bootOrder`, `virtualization`, `secureBoot`,
    `tpm`, `fanProfile`. **The support matrix** (`packages/shared/src/m75/firmware.ts`, mirrored from
    `novad`'s table, which is authoritative): Dell, Lenovo and HP through the Linux kernel's
    firmware-attributes class (dell-wmi-sysman, think-lmi under `thinklmi`, hp-bioscfg); generic UEFI for boot
    order only through `efibootmgr`; ASUS and Supermicro unsupported with the reason; Windows and
    macOS `os_not_supported`; an unknown vendor without UEFI `legacy_bios`. Both the device and the
    Hub's matrix must agree that a machine is supported (one fixture,
    `services/novad/tests/fixtures/firmware-support-matrix.json`, keeps the two tables equal on
    vendor, method, driver folder, support and keys: both test suites compare against it); any
    write route then answers 409
    `conflict` `{reason: unsupported_hardware, detail}` (the device's own code is converted the same
    way, because `unsupported_hardware` is not a Hub error code).
20. **Backends** behind one interface: `SysfsFirmwareAttributes`, `Efibootmgr` (boot order only) and
    `Fake` (a JSON file, chosen only by `novad`'s config, for tests and the E2E fake device).
    The Hub reads the method name leniently (`FirmwareReadView.method` is a plain string): a short
    plain name it does not know is kept and shown as "unknown (<name>)", anything else becomes
    `unreadable`, so a newer `novad` never makes a whole answer unreadable. Platform facts come from
    DMI. `fwupd` is listed read-only (`updates`); Nova installs no
    firmware updates.
21. **Plans and snapshots.** A plan changes nothing and snapshots the allowlisted values
    (`firmware/snapshots/<id>.json`, 0600, the last 20). A boot order may only be reordered, never
    shortened or extended. Apply writes only if the current values still equal the snapshot (409
    `{reason: base_mismatch}`); a write failing midway restores the snapshot and answers 500
    `{reason: apply_failed, restored}`. If the device answers `base_mismatch` but a fresh read shows
    the target values, the Hub records the change as applied (an earlier answer was lost).
22. **One change per plan** on the Hub (`firmware_change`, extended): `setting` lists the keys,
    `old_value` and `new_value` are JSON maps, `kind` is `apply` or `rollback`. A rollback is its own
    change with its own approval and runs through the same apply route. The Hub keeps a copy of
    each snapshot sealed with the data key under `<dataDir>/firmware/snapshots/`; rollback uses the
    device's copy, or the Hub's when the device lost it (hash checked). Rollback takes no `reboot`
    (`reboot_not_offered`); one firmware operation runs per device at a time (`firmware_busy`).
23. **Approval cards** are risk high, tier `confirm_at_action`, offering `allow_once` and
    `deny_continue`, valid 24 hours, bound by a hash to the change, its diff and snapshot; a denial
    answers `approval_denied`.
24. **Security-degrading changes.** The Hub marks turning Secure Boot or the TPM off as degrading
    even if the device does not, and checks the override at approval and again at apply, rollbacks
    included. The authorization encodes it as the body field `allowSecurityDegrading: true`
    (covered by `bodySha256`); a degrading rollback sends it too. The device refuses a degrading
    change without it (403 `{reason: security_degrading}`); its watchdog's own restore skips that
    check.
25. **The BIOS admin password** is read per call from `secret://devices/<id>/bios-admin`, never
    logged or stored by `novad`, sent only when the device's endpoint is https (else 403
    `policy_denied` `{reason: tls_required}` before the vault is read), and deleted from the vault
    when the device is revoked or decommissioned (audited `device.firmware.password.clear`).
26. **Watchdog.** With `reboot: true` the Hub sends `watchdogSeconds` from
    `devices.firmware.watchdogSeconds` (kept inside 120-3600 whatever is stored; `novad`'s default
    is 600); an apply without a restart sends none. `novad` writes
    `firmware/pending.json` before writing anything and removes it if the change fails; it restarts
    through the power module, so the owner's `power.allowActions` is checked first. Only one guarded
    restart can be pending. The first accepted heartbeat after the restart reports
    `firmware.watchdog.ok`; at the deadline it restores key by key, keeps what it could restore,
    reports `firmware.watchdog.reverted` with `{reason, complete, restored, failed, rebooted}` and
    restarts once, only after a complete restore, never looping. A machine that never restarted is
    reverted without a restart (`not_restarted`). Events carry the authorization's `changeId` and
    wait in a file outbox until a heartbeat is accepted.
27. **On the Hub** a watchdog revert counts only when complete (`complete` not false, nothing failed,
    no error, every changed key restored); anything else is `revert_failed`, which raises an
    attention notice, audits the values the machine holds now and keeps rollback open. A device
    that reports `adminPasswordSet` cannot be restored by its watchdog, so `reboot: true` there is
    refused (403 `policy_denied` `{reason: watchdog_unavailable, detail: admin_password_set}`). A
    sweep marks a restart not reported by the deadline plus 120 s as `missed` and notifies the
    owner. Events are matched by `changeId`, by snapshot only for an event without one. The
    owner's notice follows `novad`'s reason: `deadline` (the machine restarted but was not back in
    time, so the settings were restored and it restarted) or `not_restarted` (it never restarted, so
    the settings were restored without a restart); a failed restore says so with its error code.

### D5. Boot and PXE (FR-143)
28. **Status, set, commit, revert** on `novad` (`/agent/v1/boot/*`) for systemd-boot, GRUB, UEFI
    (`efibootmgr`) and a fake. `set` is a one-shot next boot (`bootctl set-oneshot`, `grub-reboot`,
    `efibootmgr --bootnext`), so a machine that never comes up returns to its default on the next
    power cycle; `commit` makes the entry the default; `revert` clears a pending one-shot. Status is
    readable with the toggle off. `DeviceBootStatusView.bootloader` is a plain string: `fake` is a
    known bootloader (shown as "Test bootloader (fake)"), a short plain name the Hub does not know
    is kept and shown as "unknown (<name>)", and anything else or a missing value becomes
    `unreadable`.
29. **Approve, then send.** Try and commit open a card (allow once or deny, 30 minutes); the change
    is sent once, automatically, when the owner allows it, after the Hub re-checks the approval in
    the table (decided, allowed, by the user, its hash equal to the body's). Revert is a safety
    action: it works with the toggle off, its approval record is made already approved by the
    owner's own request, and it is sent at once. Requests live in a `boot_request` table (body,
    before state, approval, change id, status); a request caught by a restart between approval and
    the device's answer becomes `failed` (`interrupted`).
30. **Limits.** One pending trial and one request awaiting approval per device; only a trial the
    device confirmed can be made the default; a profile's entry is checked against the device's
    list at try and commit (at create only when the device answers). Kernel arguments are refused
    (400 `capability_missing` `{reason: kernel_args_not_supported}`).
31. **The watchdog** on the device: the deadline counts from `set`, even without a restart; the
    marker is written before the one-shot and records the boot id; the authorization's change id is
    the never-twice key. The first heartbeat on the pending entry before the deadline reports
    `boot.watchdog.ok` (the Hub then offers "make default"); otherwise `boot.watchdog.reverted`, the
    one-shot is cleared, and `novad` restarts only when the machine is on the pending entry or cannot
    tell (a machine already back on another entry is left running) The owner's notice words `novad`'s
    reason: `deadline` (restarted into the entry, not back in time), `not_booted` (another entry
    started) or `not_restarted` (it never restarted, so the one-shot was cleared).
32. **GRUB** cannot report the booted entry directly: a `next_entry` still in grubenv means the
    one-shot did not take; once consumed, the kernel in `/proc/cmdline` is compared with the entry's
    `linux` line, and the `ok` event's `detail` carries `verified: true|false`. Commit is refused unless grub.cfg boots
    `saved_entry` (409 `{reason: grub_default_not_saved}`), and the entry list shows what grub.cfg
    actually boots. On the Hub an unverified trial is made the default only with
    `confirmUnverified: true` (else 409 `{reason: unverified_trial}`), and the card says the device
    could not verify it; an `ok` without `verified` (an older `novad`) counts as verified.
33. **The Hub's own clock** fails a trial 120 s after its deadline (`no_heartbeat` when the device
    has not been heard from since the deadline, else `no_watchdog_report`); a later report corrects
    the record and `GET …/boot` reconciles from the device's `last`. With a BMC linked to the
    device, the alert links to its power-cycle action (D6), which still needs the owner's approval.
34. **PXE** needs only `devices.pxe.enabled`. `GET /boot/ipxe/:token` serves an iPXE menu of the
    images in `<dataDir>/boot-images/` that boots the local disk after 30 s, with image URLs built
    from the request's own address; `GET /boot/images/:token/:name` serves only regular files
    directly in that folder (links, folders and `..` refused; single byte ranges). The per-device
    token is `nvb_` plus 256 bits, hashed with a domain prefix, shown once (`no-store`), rotatable
    and revocable. Both routes answer 404 when PXE is off and for an unknown or revoked token or
    device, allow 30 menus and 120 image requests a minute per address, and audit every fetch.
    The request log masks `/boot/` paths and the redactor's token rule covers `nvb_`. Nova runs no
    DHCP or TFTP: the owner points a DHCP server's next-server and filename at the Hub.

### D6. Out-of-band (FR-147)
35. **Hub only.** No `novad` route: the Hub talks to the BMC. Endpoints are Redfish (HTTPS) and
    IPMI (`ipmitool` lanplus, behind an interface with a fake binary). Intel AMT is refused
    (`capability_missing` `{reason: not_built}`). A BMC managing several systems needs a `systemId`.
36. **Turning it on** needs `POST /api/v1/oob/enable {confirm: true}`; owner-only at the route and
    in the service (`/api/v1/oob` is on the owner-only list); a managed lock wins. Creating or
    editing endpoints needs the switch on; deleting works while it is off. Turning it off withdraws
    waiting cards.
37. **Addresses.** A host or IP the owner enters, no credentials in it; loopback, link-local,
    unspecified and multicast addresses (also IPv4-mapped, compatible and NAT64 forms), `localhost`,
    `*.localhost` and the Hub's own addresses and host name are refused, and so are bare numeric host
    forms. Names are resolved and every address checked again at connect time, and TLS and
    `ipmitool` connect to the checked address (400 `validation` or 403 `policy_denied` `{reason:
    address_not_allowed}`).
38. **Credentials** live only in the vault (`secret://oob/<id>`); the IPMI password reaches
    `ipmitool` only through `IPMI_PASSWORD` with a fixed environment. The password joins the global
    redactor only when it has 8 or more characters (a default like `ADMIN` is not masked
    everywhere); one of 4 to 7 characters is still removed from BMC and `ipmitool` error messages
    (a shorter one is not: removing it would cut up any message containing those letters).
39. **Pinning, confirmed before credentials.** On a Redfish BMC with no pin, `check` reads the
    certificate's SHA-256 with a handshake only and sends no credentials (`pinConfirmed: false`);
    the owner confirms it with `POST /api/v1/oob/endpoints/:id/pin/confirm {tlsPin}` (409
    `pin_changed` if it no longer matches); every other action is 409 `pin_unconfirmed` until then.
    A fingerprint the owner typed counts as confirmed; clearing the pin or changing the address
    needs a new confirmation. Every later connection checks the pin before writing a byte: a
    different certificate is 403 `tls_pin_mismatch`, audited. 10 s timeouts; redirects are refused.
40. **Actions** `power.status|on|off|cycle|reset`, `sensors`, `bios.read`, `bios.plan`,
    `bios.apply` (Redfish pending settings, applied at the next restart) and `boot.next` (Redfish
    `BootSourceOverride`, IPMI `chassis bootdev`, one time). `power.off` is ForceOff, `power.cycle`
    PowerCycle (refused as `unsupported_by_bmc` when the BMC does not list it) and `power.reset`
    ForceRestart; IPMI uses hard power commands. The Redfish BIOS attribute table is this area's own:
    Dell and HPE are mapped, Lenovo and Supermicro refused with the reason.
41. **Approvals.** Everything but `check`, `power.status`, `sensors` and `bios.read` files a
    Hub-only card (risk high, `confirm_at_action`); power and `boot.next` actions run when the owner
    allows them within 10 minutes. `bios.plan` follows the firmware switches and its card shows the
    diff and covers its apply (no second card); `bios.apply` needs that approved plan, re-checks the
    switches and the snapshot hash and works once. No `novad` authorization is needed, since the Hub
    itself talks to the BMC.
42. **Binding.** The approval hash covers the endpoint's kind, address, port, `systemId`, pin and
    pin confirmation time; it is checked when the card is answered (`approval_mismatch`) and at
    `bios.apply` (409 `plan_target_changed`). Editing an endpoint withdraws its waiting cards and
    approved plans (`endpoint_changed`), as deleting does. Only the owner's own answer runs an
    action (`approval_not_by_user` otherwise). Once a `bios.apply` PATCH has been sent, any failure
    marks the plan `failed` (`apply_outcome_unknown`; applying it again is 409 `plan_failed`).
    Cards cancelled by a restart end at the next sweep; actions a restart interrupted are marked
    failed, never re-run.
43. **Card text.** Values a BMC supplies and the endpoint name are capped at 200 characters with
    control and text-direction characters removed; a degrading plan's card starts with
    "Weakens security: ".

### D7. Local browser fallback (FR-209)
44. **The offer.** A block page, or a challenge seen twice in 10 minutes, on an agent's own browser
    whose agent has a connected computer (FR-081) whose connection includes the `browser` capability
    and whose capability document offers the `browser` module; never for local or private sites. It is a `user_input` request (not an approval card, since the user picks a profile) with
    an optional `context` (`kind: browser.fallback`, site, device, cause and the choices with their
    profiles; `contracts/schemas/server-request.json`); the answer stays `{choice}`. Choices: a clean
    profile on the device, the user's own browser through the extension (only when the bridge is
    usable there), or not now. It waits 10 minutes.
45. **Consent** is revocable, per agent, device and site, and records the chosen profile; the next
    block on that site continues without asking (the table also allows a thread scope, which
    nothing creates yet). An extension consent whose bridge is gone asks again. Fallback sessions
    and the bridge's tab consents record the OS user whose browser it is.
46. **The session** reaches the device's Chromium through Playwright `connectOverCDP` and a
    loopback relay, so the management token and TLS never reach Playwright. It covers the site and
    its subdomains only: a navigation, click, key or redirect that leaves the site ends it and the
    Hub's own browser takes over. The device's egress list is exactly the site and `*.site`.
    Downloads are off and the download tool refuses. Trace rows are marked through a link table
    (`browser_fallback_action`) and every step is audited; actions keep the site levels, classifier
    and gate. Turning `browser.localFallback` off stops running sessions (`disabled`); at start the
    Hub ends its own open rows (`restarted`) and closes device sessions it does not know, then every
    15 minutes.
47. **On `novad`.** Chromium from `browser.executablePath` or the usual install paths (none: 409
    `capability_missing` `{reason: no_browser}`), a fresh clean profile deleted on close, at most 2
    sessions, DevTools over a pipe (`--remote-debugging-pipe`; no TCP port), a session ready once
    Chromium answers `novad`'s own `Browser.getVersion`. A session closes after 10 minutes with no
    DevTools client and after 4 hours in any case. Leftover profiles are removed when the module
    starts; profiles live in `nova-browser-<hash of the data folder>` inside `browser.profileRoot`.
48. **Who runs Chromium.** Never root. A non-root `novad` runs it as itself. A root `novad` runs each
    session as its own dedicated system user, `nova-browser1` or `nova-browser2` (own group; made by
    `novad install` and `enroll` as root on a client and removed by uninstall and decommission on
    Linux; on macOS the owner creates two users and sets `browser.runAs`). A user that is root,
    `nobody`, or in group root or nobody's group is refused (403 `policy_denied` `{reason:
    unsafe_browser_user}`); with no such user the launch fails closed (409 `capability_missing`
    `{reason: no_browser_user}`), and with none free it is 409 `conflict`
    `{reason: no_free_browser_user}`.
49. **The egress filter** is a loopback HTTP proxy per session: CONNECT and absolute `http://` only,
    ports 80 and 443, hosts from `allowHosts` (exact or `*.host`; entries `novad` cannot use are
    returned as `skippedHosts`, and the launch fails only when none is left); DNS by `novad` with
    every resolved address checked (IP literals, private, loopback and link-local refused; IPv6 only
    global unicast, NAT64, 6to4 and mapped addresses judged by their IPv4 address); no TLS
    inspection; it logs host and decision, not URLs, and reports counts on close. It has no token,
    because Chromium cannot present proxy credentials; it reaches only public addresses of listed
    hosts.
50. **DevTools for the Hub** is `GET /agent/v1/browser/cdp/:sessionId`, a WebSocket `novad`
    answers itself (RFC 6455; text only, 64 MiB per message, one connection per session, a newer one
    replaces the older with 1001) and relays whole NUL-terminated messages to the pipe through
    `<data>/browser/cdp.sock`. The management token, session and header checks come first; any
    `Origin` is 403 `origin_rejected`.

### D8. Extension bridge (FR-096)
51. **The extension** (`apps/extension`) is Manifest V3, TypeScript, our own code and icon (drawn by a
    script), built by its own `build` script with no new dependency. Permissions `nativeMessaging`,
    `tabs`, `tabGroups`, `debugger`, `storage`; no host permissions by default
    (`optional_host_permissions: ["<all_urls>"]`, requested per host). Agent tabs live in a "Nova"
    tab group; controlled tabs show the debugger banner and a badge. It holds its own page scripts
    (13 named scripts); `Runtime.evaluate` with a free expression is refused.
52. **The host.** `novad bridge-host` speaks native messaging (4-byte length plus JSON, at most
    1 MiB) and talks only to the local `novad` over a per-user 0600 `bridge.sock` with the user's
    bridge token (`~/.config/nova/bridge-token`, 0600); the connection must come from that user's
    uid. The bridge users are `localRuntime.users`. One host at a time: a newer host of the same
    user replaces the older (`disconnected` then `connected`), a host of another user is refused
    (`bridge_busy`) until the first leaves. The host manifest (`ai.nova.bridge.json`, our extension
    id only) is written only by `novad bridge enable` run by the user, into browser folders that
    already exist, and removed by `novad bridge disable` (which also removes the token) and by
    uninstall; never by the installer. The extension id comes from `bridge.extensionId`.
53. **Hub ↔ `novad`.** `POST /agent/v1/bridge/call {method, params, timeoutMs}` (409
    `bridge_offline` with no host) and `POST /agent/v1/bridge/events` from `novad` with the device
    credential, at most 100 events and under 900 KiB a post (a 413 halves the batch; other 4xx drop
    it; 5xx, 408 and 429 retry). The Hub checks each event on its own and answers
    `{accepted, refused}`.
54. **Grants and consent on the Hub.** Connection state and tab consents live in memory (after a
    restart a device counts as disconnected until `novad` reports again). A host grant becomes
    `pending` when the browser reports permission and `active` only on the owner's confirmation;
    "all sites" is a separate elevated grant with its own acknowledgement and
    `browser.extensionBridgeAllSites`; `browser.extensionBridge` turns the bridge off. No grant,
    "all sites" included, covers the Hub's own hosts (`hub_host`; if they cannot be read, every
    host is refused). Tab consent comes from `tab.shared` (`{tabId, host, title?, origin?}`, hosts
    only), records the OS user, and a tab of another user is refused; a `connected` while connected
    counts as a disconnect (`browser.bridge.replaced`).
55. **What passes.** `cdp.send` carries `expectHost` and the extension refuses with `host_changed`
    when the tab is elsewhere (a pending navigation counts); the Hub waits for a navigation to commit
    and follows the tab only onto an allowed, granted site. Six DevTools methods pass, on consented
    tabs whose host is granted; only Shift as a modifier (Ctrl, Alt, Meta and `commands` are refused
    on both sides); no cookies, storage, page tools, downloads or uploads in the user's own
    browser; every action goes through `browser.act` with the site's level and the classifier.
    History search (`browser.history_search`) asks the user in the extension each time, returns
    `{title, host, lastVisit}` and drops the permission afterwards.

### D9. Device operations, decommission and compute nodes (FR-140, FR-142, FR-145, FR-148, FR-150, FR-126)
56. **Decommission** (`POST /api/v1/devices/:id/decommission {purge}`) files a Hub-only card (1
    hour); on the owner's allow, a reachable device is told with a signed `device.decommission`
    authorization and the device is revoked whatever it answered; an offline device is revoked at
    once and wipes itself at its next contact (the 401). A run a restart interrupted finishes at the
    next start. Results: `wiped`, `unreachable`, `refused`, `not_told`. A request whose card ends
    without "Allow once" is `denied` or `expired`; one withdrawn before it is answered (its card
    cancelled by a Hub restart, or the device revoked through its own route meanwhile, which
    cancels the card) is `cancelled`.
57. **On `novad`** decommission closes browser sessions, stops modules, clears credentials in
    memory and wipes the key, credentials, certificate, Hub trust and Hub key, then answers; the
    replay store is kept so a spent authorization stays spent. It then hands one transient unit
    (`systemd-run --on-active=3`) a fixed order: disable the service, remove the unit file and the
    binary, `daemon-reload`, remove the browser users, stop the service last (macOS: files, then
    `launchctl bootout`; Windows: `sc.exe delete`, then stop). With `purge` it deletes the data folder.
58. **`novad uninstall [--purge]`** does the local side and also removes the installed binary, the
    per-user bridge manifests and tokens and the browser users. Purge needs `novad`'s marker
    (`.novad-data`) or its own `device.json`, `key.seed` and `modules.json` together, and always
    refuses `/`, a folder directly under it, system folders and home folders.
59. **Routes the M6 UI lacked**, owner-only under `/api/v1/devices`: the management channel state
    (`/devices/management-tls`), managed services (from `POST /agent/v1/services`; an older `novad`
    answers `capability_missing` `{reason: update_required}`), the build available from the Hub's
    agent-dist manifest (information only), and the owner's overrides with push-now.
60. **Compute nodes** report VRAM (`nvidia-smi` or `rocm-smi`, probed only from the command line,
    so tests never start them) in the signed document and every heartbeat; the owner's node policy
    (quiet hours, routing eligibility) comes back in the heartbeat answer; quiet hours are read in
    the policy's time zone, else the node's `locale.timezone`, else UTC. The node refuses new jobs
    in quiet hours or while its jobs service is stopped, and routing skips it. `/node/v1/services`
    lists and starts, stops, restarts or reports `jobs` and, only with `--backend-unit`, the model
    server through `systemctl` (a unit name is checked against a pattern and passed after `--`).
61. **Migrations.** 0040_firmware (with `approval.answer_in`), 0041_boot, 0042_oob,
    0043_browser_device, 0044_device_ops (`device_decommission`, `node_policy`).

### D10. Not built in M7.5
62. Firmware updates through `fwupd` (listing only); BIOS settings on Windows and macOS
    (`os_not_supported`); Intel AMT (WS-Man) and out-of-band console access and BIOS settings over
    IPMI; DHCP and TFTP servers; kernel arguments in boot profiles; the `novad` `screen` module
    (computer use on a real desktop moved to M9 with N1's capture work) and `capture` module; the
    `novad` `compute` module (`services/compute` is the compute node); a Windows bridge (no named
    pipe, no registry manifest).

### Shared fixes
63. **Long-lived children** (modules a management request starts, Code processes, browser sessions)
    are spawned on one `novad` thread that lives as long as `novad` (`spawn_kept` in
    `hardening.rs`, with the ETXTBSY retry). Linux sends the parent-death signal when the forking
    thread exits, so a module started by a request used to die when the request returned and count
    as a crash. `ring` 0.17.14 is now a direct dependency (SHA-1 for the WebSocket handshake; the
    same crate rustls already builds, so the lock file gains no crate).
64. **Protected system folders on the device.** `/sys`, `/proc`, `/dev`, `/boot`, `/efi` and `/etc`
    can no longer be granted, resolved or used as an exec working folder (`protected_path`), and an
    older grant of one is never mounted into the sandbox, so a management-token holder cannot reach
    BIOS settings or bootloader files through the file and exec modules. The service unit keeps
    `ProtectSystem=full` and adds `ReadWritePaths=-/boot/grub -/boot/grub2 -/boot/efi -/efi
    -/sys/firmware/efi/efivars` for the boot backends.
65. **Tooling.** CI's checks job installs bubblewrap; the Hub's tests against the real `novad`
    count the `browser` module on client devices.

## Consequences
A device that holds a certificate is now managed over mutual TLS end to end, and its firmware,
boot and decommission cannot be changed with a stolen management token: every such change needs
the owner's switch, the owner's own answer on a Hub-only card and a short-lived Hub signature over
the exact body. A failed boot trial or firmware change undoes itself where the hardware allows,
and the Hub says plainly when it could not (`revert_failed`, `missed`, `unverified_trial`).
BMCs are reachable only after the owner confirms their certificate. An agent blocked by a site
can continue on the owner's own computer, from a clean profile limited to that site or in the
owner's browser on hosts the owner granted, without the agent ever seeing cookies or passwords.
The price is more consent steps and more Hub-only cards, three new kinds of owner-only routes,
and two dedicated system users on every root client. R-022 now covers only devices without a
certificate (the `none` trust mode and devices added before certificates).

## Known limitations
- Hardware: nothing ran against a real BIOS, bootloader or BMC. Vendor attribute names are checked
  against mock sysfs trees, the BMCs are a fake Redfish server and a fake `ipmitool`, and the
  `novad` browser tests use a fake Chromium (the Hub side ran against a real Chromium in the
  Playwright container). Device-lab runs are T-M9-05.
- Firmware: the watchdog cannot restore a BIOS with an admin password (the Hub refuses a guarded
  restart there); on a device without a certificate the BIOS password is never sent, so such a
  BIOS cannot be changed until the device uses the local CA; no firmware updates.
- Boot: GRUB trials are verified only by the kernel path, and `grub-set-default` needs
  `GRUB_DEFAULT=saved`; the Hub cannot revert a machine that never comes up (the one-shot does that
  on the next power cycle); many BMCs drop an IPMI boot override after about 60 s without a
  restart.
- PXE: tokens travel in clear over plain-HTTP iPXE, so boot images must hold no secrets; iPXE over
  HTTPS needs the Hub CA built into iPXE; a LAN client can tell PXE is on from 429 versus 404.
- Browser on a device: sessions an earlier Hub connection opened inside Chromium stay attached after
  a reconnect (the pipe outlives the WebSocket); a visible (non-headless) browser run as a
  dedicated user probably cannot use the desktop user's display; on kernels without unprivileged
  user namespaces Chromium's sandbox does not start (`browser_start_failed`); WebRTC traffic
  policy and LAN discovery were not checked against a real Chromium; macOS needs the owner to
  create the browser users.
- Bridge: no Windows bridge; the extension id is not pinned with a manifest `key`, so
  `bridge.extensionId` must be set from the unpacked or store id; connection state and tab
  consents do not survive a Hub restart.
- Certificates: only `novad` devices renew theirs through the heartbeat; compute node
  certificates are not renewed.
- Device toggles: anyone holding a device's management token can set its device-side
  `firmwareChanges` and `lowLevelBoot` through `POST /agent/v1/config` (D3), so a stolen token
  removes the device-side half of the double check; the Hub-signed authorization (D2) still blocks
  every firmware and boot change.
- Fallback: nothing asks for it on purpose yet (`BrowserService.localFallback` has no caller, so
  the `requested` cause never occurs): it is offered only after a block.
- Not built (D10): `fwupd` updates, BIOS on Windows and macOS, Intel AMT, out-of-band console,
  DHCP/TFTP, kernel arguments, the `novad` `screen`, `capture` and `compute` modules.
