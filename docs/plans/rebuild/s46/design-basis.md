# S46: on-demand machines — the design basis

**Status:** agreed in discussion with the owner, 2026-09-22 and 2026-09-23.
This is a **design basis, not a plan**: nothing here is built, and no task
list follows from it until the open questions at the end are answered.
Decisions marked **OWNER** are Jeremy's and locked; everything else is the
design argument and may be changed.

It reframes the S46 section of [`../hub-topology.md`](../hub-topology.md)
rather than replacing it. Most of that section's mechanics survive, and
§7 below says exactly what changes.

---

## 1. Why this exists

The move is done (S45, 2026-09-22): `nova.<tailnet>.ts.net` is served from
the always-on mini PC, and the Dell's 3090 answers chat whenever the Dell is
awake. When it is asleep, chat falls back to a cloud model — and **nothing
wakes the Dell.** The owner turns it on by hand.

His stated end state, 2026-09-22: *"The dell should sleep but be woken via
'wake on lan'. Chat should be patient and wait for it to start if we set it to
the WoL device. Yes, I know the mini pc doesn't have a gpu, that was the point.
That is always on. Dell or other devices can be on-demand/WoL when needed."*

S46 is the slice that delivers the on-demand half of that sentence.

---

## 2. The frame: machines as on-demand nodes

Owner proposal, 2026-09-23: *make the Nova agent behave like Kubernetes nodes,
except dynamic — on-demand / WoL workloads instead of ensuring a service is
always available.*

**Take Kubernetes' object model, not its software.** The node object is
well-known for good reason, and nearly every part of it has a Nova equivalent.
The one thing that changes is the meaning of desired state: Kubernetes
reconciles towards *always running*; Nova reconciles towards *running while
something needs it, asleep otherwise*. **Asleep is a normal, schedulable
state, not a failure.**

| Kubernetes | Nova, on demand |
|---|---|
| `kubectl get nodes` | a live machines view: **online · asleep · waking · offline** |
| capacity / allocatable | GPU, VRAM, installed models, RAM, free disk |
| labels / selectors | `gpu=cuda`, `vram=24G`, `os=windows`, `wakeable=true` |
| taints / tolerations | "this machine sleeps": only work that tolerates a wake can land there — so a background beat never wakes the Dell |
| node lease / heartbeat | the **hold**: keep it awake while it is in use, release after |
| controller reconciling | wake it when a turn needs it; let it sleep when idle |

**Why not Kubernetes itself** (settled 2026-09-22, recorded so it is not
re-argued):

- To Kubernetes a sleeping node is a *failed* node — it goes `NotReady` and its
  work is evicted. The whole design is machines that sleep on purpose.
- macOS cannot be a Kubernetes node at all, Windows nodes run only Windows
  containers, and Mac-only users are an explicit target. A Mac's models have to
  run in native Ollama anyway (Docker on macOS has no GPU).
- The agent's "hands" — open an app, show a notification, read the Desktop —
  must run inside the user's logged-in session, which a pod is isolated from.
- Even k3s is real weight on a mini PC with 12.5 GB free beside minecraft.

**Much of the model already exists in pieces:** the S40 `engines` table is
effectively a node registry; `machine_status` is `kubectl get nodes` for her;
the plan's rule that only a role's own chain may wake a machine *is* a
toleration; and the gateway's walls are a circuit breaker. What this frame adds
is one model that joins them, and it makes the missing piece obvious: **the
reconciler that wakes, holds and releases.**

---

## 3. Owner decisions, 2026-09-23 (locked)

1. **One global chat model.** No per-conversation model. Topics are isolated by
   **threads** (S24 — a room seeded from one message, branching off the
   hallway), not by models.
2. **The wake policy is a setting, and both modes are offered:**
   - **Wait** — wake the target, show progress, and answer from the preferred
     model, subject to a deadline.
   - **Answer now** — an **interim model**, which the owner assigns in
     settings and which may be **a cloud model or a local model on the hub**,
     answers straight away while the target wakes; once the target is serving,
     the conversation moves to it.
3. **The hold after the last message defaults to 15 minutes and is
   configurable in settings.**
4. **Multi-machine setup is a spike to discuss** — §9.

### Still binding from 2026-09-18

- **Windows owns when the Dell sleeps.** Nova only holds it awake while in use;
  it never puts a machine to sleep.
- **A wake is never assumed.** Wake-on-Wi-Fi in particular is measured, never
  assumed — the Dell stays on Wi-Fi.
- **The wake relay is any Nova agent on the sleeping machine's LAN.** In this
  owner's setup the hub itself is on that LAN (both are on `192.168.0.0/24`),
  so the hub is the relay — but it must send from the **host**, because a
  magic packet broadcast from a bridge-networked container never reaches the
  physical LAN.
- **No SSH keys and no secrets manager** for reaching machines; access is
  pairing plus a per-link bearer.

---

## 4. The two wake policies, as sequences

A turn arrives. `chat.model` names a model on a machine that is asleep.

**Wait:**

1. Send the wake signal. The turn shows *"sent a wake signal to the Dell"* —
   never *"the Dell is waking"*.
2. Poll until the machine answers or the deadline passes. Show progress as it
   happens: *reached · loading qwen3.8:27b · ready*.
3. **Answered in time** → the preferred model answers. The hold starts.
4. **Deadline passed** → the chain's next link answers and says why, exactly as
   a fallback does today.

**Answer now:**

1. Send the wake signal, and **in the same moment** answer from the interim
   model. The reply says which model answered and that the Dell is being woken.
2. The wake continues in the background.
3. **The machine answers and the model is loaded** → the *next* message goes to
   the preferred model. Nothing already answered is re-run.
4. **It never answers** → the interim model keeps answering, and the failure
   rules in §5 apply.

**Interim model vs fallback — distinct on purpose.** The *fallback* (the
chain's later links) answers when the target **fails**. The *interim* model
answers while the target is **waking**, which is a planned state, not a
failure. They may be the same model, and a sensible default is for the interim
model to be the chain's next link when none is set.

---

## 5. The mechanical rules — honesty controls, whichever policy is set

These are the lines of code that refuse when Nova is wrong. Most are already in
the S46 section of `hub-topology.md`; they are restated because they are what
make either policy safe.

| Rule | Status |
|---|---|
| **A wake reports *sent*, never *woke*.** A magic packet has no acknowledgement; the only proof is the machine answering afterwards. | in the plan |
| **"Woke" is backed only by a wake span whose outcome is `ready`.** A reply claiming the machine woke without one is corrected. | in the plan (`_WOKE_MACHINE`) |
| **The deadline is derived from measurement**, not typed: `ceil(1.5 × p90)` of the measured wake-to-answer time, clamped. | in the plan (P0-3) |
| **After three consecutive wakes with no answer, stop waiting.** Answer straight from the fallback or interim model, and raise a non-urgent notice that the machine is not answering its wake attempts. | in the plan |
| **When a woken machine answers, lift its wall.** Measured 2026-09-22: one failure walls a link for about a minute, so chat stayed on the fallback for a minute after the Dell was back. The wake flow must clear it. | **new** |
| **Every fallback and interim answer says which model answered and why.** `route_reason` already records this; the reply must surface it. | exists in the trace |
| **The switch from interim to target is visible**, never silent. | **new** |

---

## 6. What this rests on — measured, 2026-09-22

| Reading | Value |
|---|---|
| First token from the Dell after a full boot (cold 17 GB model load) | **20.8 s**, and it succeeded |
| Model load on the 3090 alone, measured separately | about **50 s** |
| How long a failed link stays walled | about **1 minute** |
| How long Ollama keeps a model loaded after its last use | **5 minutes** (its default) |
| Cloud fallback, first token | **9.3 s**, about **$0.0015** a turn |
| After a real Dell reboot | only its ollama came back; GPU published on the right port; the parked Nova stayed parked |
| Whether the Dell answers **ping** from the hub while fully awake (2026-09-23) | **No: 100% loss.** Its firewall drops ICMP on the Wi-Fi network. ARP does answer, but a sleeping Wi-Fi card can answer ARP too. So "the machine answered" must be read over the tailnet (the node answering `tailscale ping`, then the model port accepting a connection), never from ping or ARP. |

**Not measured, and it gates everything: Wake-on-LAN over Wi-Fi from sleep
(P0-1).** A lot of hardware cannot do it reliably. If this Dell cannot, then
*answer now* is the only policy that works for it, and *wait* becomes a timeout
on every message.

---

## 7. What this changes in the existing S46 plan

- **S46 does not need an agent on the Dell to wake it**, in this owner's setup:
  the hub is on the same LAN. It needs a **host-side sender on the hub**.
  Decision 6 is unchanged — the relay is any agent on the machine's LAN, and
  here that is the hub.
- **The Dell is currently a provider row, not an engine.** The S46 plan's turn
  flow (`409 engine_asleep` → `through_sleep`) assumes S44 has made the Dell an
  engine behind an agent. Today it is reached through `tailscale serve` and an
  `openai-chat` provider row, and **that path already survives a reboot**.
  Either S46 learns to wake a machine behind a provider row, or S44 lands
  first. **An open question, not a decision** — §8.
- **The wake policy and the interim model are new settings.** The plan listed
  only `machines.wake_max_wait_s`. Proposed names, not final:
  `machines.wake_policy` (`wait` | `answer_now`), `machines.interim_model`, and
  `machines.hold_after_last_turn_min` (default 15).
- **The hold** in the plan is a lease the agent keeps on the machine (Windows:
  `PowerSetRequest`). That is still the only thing that can stop Windows
  sleeping mid-conversation, so **the hold is the one piece that does need an
  agent on the Dell.** Without it, Windows' own idle timer can sleep the Dell
  between messages.

---

## 8. Open before this becomes a plan

1. **Does the Dell wake over Wi-Fi?** Measure P0-1 first. Everything else
   depends on the answer. Needs the owner: put the Dell to sleep; send the
   packet from the mini PC; repeat enough times to trust the rate.
2. **Engine or provider row** for a wakeable machine — which does S46 build
   on? (§7)
3. **Which hub-local model is viable as the interim model?** The owner allows
   only tiny models on the mini PC. Its N150 embeds at 5.15 ms a token;
   **generation speed on it has never been measured.** Measure a couple of
   candidates before offering "local on the hub" as a choice.
4. **How the switch is shown** — a line in the reply, a badge on the message, a
   notice when the Dell becomes ready?
5. **The hold beyond its duration** — is 15 minutes after the last message
   enough, or should the hold also follow the app being open?

---

## 9. Spike: setting up Nova across machines — to discuss

Owner, 2026-09-23: *"the process of setting up nova on multi machines should
include using a code, CLI command, and or QR code. Then that nova agent on the
device should go through a process to set settings on the device such as
prepping it for WoL or walking through how to do it, or the nova hub needs to
handle that. It also needs to allow downloading of models on specific devices
that are syncd or whatever."*

**Scope for discussion, not design.** The pieces the plan already has, and what
this spike would join:

| The owner's ask | What the plan already has | What is open |
|---|---|---|
| **Join by code, CLI command or QR** | S42b: a per-OS card with a one-line command (POSIX `sh` and PowerShell), each verifying the download's sha256 before running; the code never enters her context. S47: a QR code for thin clients. | A QR code suits a **phone**; on a desktop a copyable command is easier. Does one flow offer all three and let the device pick? |
| **Prep the device for WoL, or walk the user through it** | S46: a per-OS wake checklist derived from the machine's facts — Windows WoMP, hibernate-after, Fast Startup; macOS "Wake for network access"; Linux `ethtool` and NetworkManager; BIOS steps stated but not performed. | **What the agent can do itself vs what needs admin, a reboot or the BIOS.** Firmware settings are unreachable from software, so some of this is always a walkthrough. Does the agent change what it can and hand the rest to the user? |
| **Download models onto specific devices, kept in sync** | S44: pulls per engine, checked against that machine's free disk. | **Agreed by the owner, 2026-09-23:** each machine has a *desired model list*, and its agent **reconciles towards it** — pulling what is missing and reporting what cannot fit — rather than copying every model everywhere. It is the §2 frame again: the list is the desired state, the agent is the reconciler. Still open: who edits the list (the owner in Settings, Nova when asked, or both) and what happens to a model that is on the machine but no longer on its list. |

Constraints that already bind anything this spike produces:

- **No approvals** (`services/core/tests/test_no_approvals.py`): the agent may
  state that it *cannot* do something; it never gates the owner.
- **The pairing code is a secret**: it reaches a card, never her context.
- **Nothing is claimed as done that was not verified** — a WoL setting "applied"
  is not the same as a wake that landed.
