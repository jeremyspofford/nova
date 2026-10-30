# M4 gate — evidence

Run 2026-10-30T05:21:58.984Z. Mesh over HTTPS at 172.17.0.2 (not loopback); every process real.

- Fresh hub: setup done; its console answers only on loopback (http://172.17.0.2:44701 refused); devices use https://172.17.0.2:21214.
- Standby: enrolled by command (digits matched, approved on the hub’s screen with confirm), started from a blank home, syncing.
- Phone: QR decoded from the hub’s screen, opened over HTTPS on a phone-sized browser, non-extractable keys, same digits on both screens, approved with confirm; signed in and saved a memory.
- Computer: the exact command from the sheet (`curl -fsS https://172.17.0.2:21214/join.sh | sh -s -- <code>`) installed the boot agent, digits matched, approved with confirm; its runtime heartbeats and it shows Online.
- Data on the hub: a memory (plus the phone’s), a verified workspace task, a conversation, a file in the workspace.
- Revoked the phone from the hub’s screen (tier 3): its page went back to /pair at once and its next request got 401.
- Standby caught up (lag 0 rows); the hub was killed with SIGKILL.
- While the hub was down, the computer queued a task request and a memory note.
- Promoted the standby from its own screen (tier 3): epoch 2, recorded in the ledger as a verified task.
- No data loss: profile, the task and its events, both memories, receipts, device trust and the files match the dead hub by content hash.
- The computer moved to the new hub by itself (signed roster, epoch 2); its queued task and note each arrived exactly once, with provenance.
- No orphaned trust: the phone is still revoked on the new hub; the old hub, restarted, saw epoch 2 and stepped down (writes refused, saying why); exactly one hub.
- Local-only held: neither Nova process tried to connect anywhere outside this machine and its own mesh.

Screenshots: docs/screenshots/m4/gate-*.png
