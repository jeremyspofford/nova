---
title: "Your Nova, your account: owner identity, safe defaults, monitoring inside the app"
date: 2026-07-07
---

This release makes Nova yours in the literal sense: an account you create is the key to everything, the dangerous defaults are gone, and you can watch the autonomous brain work without leaving the app.

**Accounts are the front door now.** First boot asks you to create your owner account — name, email, password — and that's the administrator credential from then on. Invite others with real roles (owner, admin, member, viewer, guest — each explained where you pick it), copy invite links any time, edit anyone's name, email, role, and account expiry, and sign out from the new sidebar account menu. The `.env` admin secret still exists, but demoted to what it should be: break-glass recovery and automation, entered on the login page if you ever need it. Sign-in itself got hardened — brute-force throttling per IP *and* per account, with identical response timing whether an email exists or not.

**Safe by default.** Your home directory mounts read-only into agent sandboxes unless you explicitly opt into writes — a prompt-injected agent can't touch dotfiles or keys on a default install. Network position no longer grants admin: being on the LAN lets you *use* Nova (chat, view, Inbox), but changing settings, reading secrets, or touching recovery always requires credentials, no matter where the request comes from. Fresh installs trust only localhost until you say otherwise.

**Monitoring, embedded.** An opt-in Grafana profile ships two provisioned dashboards over Nova's own database — autonomy (goals, schedules, what the brain learned) and operations (throughput, spend, delivery receipts) — embedded at **Infrastructure → Monitoring** with your Nova session as the login. Same username, same password, no second sign-in; `make observability` starts it.

**First boot, actually verified.** The whole first-run path — onboarding gate, invite-exempt first registration, wizard setup authorized by your brand-new account, one-shot completion — is now walked end-to-end on a pristine instance as part of development, which is exactly how we caught (and removed) a leftover migration that had been silently breaking every fresh install.

**The overnight shift got debugged too.** Standing goals no longer double-fire outside their schedule, and if the morning-briefing agent fumbles its push notification, the briefing text itself still reaches your phone and Inbox through the completion notice.

**Removed:** the screenpipe workstation-capture experiment (service, UI, and docs) — six thousand lines lighter.
