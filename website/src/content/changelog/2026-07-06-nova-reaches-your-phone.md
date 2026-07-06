---
title: "Nova reaches your phone: push notifications, human checkpoints, lockscreen decisions"
date: 2026-07-06
---

Autonomous work is only useful if it can reach you when it matters. This release gives Nova a complete human-in-the-loop channel: push notifications to your phone, a way for agents to park mid-task and ask you for something, and one-tap decisions straight from the lockscreen.

**Bundled push notifications (ntfy).** Nova now ships its own self-hosted [ntfy](https://ntfy.sh) server — no cloud account, no phone-number registration. Approvals, task failures, review/clarification requests, and finished goal work publish to a private random topic (the topic name is the subscription secret). Install the ntfy app, subscribe, done. Interactive chat tasks deliberately don't buzz your phone; autonomous work does.

**Human checkpoints: agents can ask for help mid-task.** A new `request_human_checkpoint` tool lets the Task Agent stop on things only a human can do — solve a CAPTCHA, provide an emailed verification code, make a judgment call — without losing its place:

- The task parks in a new `waiting_human` status with its full conversation snapshotted; a checkpoint card appears in Pending Approvals and pushes to your phone.
- Your reply (typed in the card or the task's new Checkpoint tab) is injected back as the tool's result, and the agent resumes *exactly* where it stopped — no re-running, no double-submitted forms.
- If the agent was driving a browser, it attaches a screenshot of the page it's parked on, so you see what it sees.
- Declining also resumes the task — the agent is told to wrap up gracefully instead of stranding. Unanswered checkpoints cancel after 24h.

**Lockscreen decisions.** Set the dashboard URL your phone can reach (Settings → Notifications → Lockscreen actions) and approval/checkpoint pushes carry Approve/Deny buttons that decide directly from the notification. Each button is a signed one-shot link — an HMAC scoped to that single approval, decision, and expiry, minted with a server-side key that never leaves the machine. No admin secret on your phone, nothing to steal from the notification history, and a spent or tampered link is rejected.

**A morning briefing, delivered.** The channel's first standing use: a seeded **Morning briefing** goal distills yesterday's journal and fresh intel into one push a day (11:00 UTC by default — it's a normal scheduled goal, edit it in Goals). It rides the new `send_push` tool: informational pushes any agent can send, storm-braked at 10/hour — the counterpart to `request_human_checkpoint` for messages that don't need an answer.

**An Inbox, so the phone is optional.** Everything Nova sends — briefings, agent messages, task outcomes — also lands in a dashboard **Inbox** with unread badges and full message bodies. Delivery receipts and a live connected-subscriber count in Settings make the push channel honest: "accepted by ntfy" is not "delivered to a device", and when nothing is subscribed, Nova says so instead of glowing green.

**Scheduled goals actually fire now.** Two fixes surfaced while wiring the briefing: migration-seeded schedules (nightly memory curation, intel sweeps) were never armed — cortex now initializes any cron goal it finds unscheduled — and a scheduled goal's instructions now reach the executing agent verbatim instead of as a lossy one-line paraphrase.
