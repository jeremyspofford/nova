# Task 3 independent spec and quality review

specPass: false
qualityApproved: false
Task quality: Needs fixes

Scope: Task 3 only, BASE `5d40205f0809114dcae7b75a02a479e8cb0c178a`, HEAD `3f919b2de3fadede0b6830bc63d6c2e35de82d8e`. Reviewed the complete supplied 131031-byte package once in bounded chunks: one commit, 12 files, 1046 insertions and 38 deletions. This is neither a whole-branch review nor merge approval.

The brief, preflight and constraints were read first as binding requirements. The implementation report was treated as unverified claims. The accepted checkpoint permits trusted in-process registration, explicit retry, unavailable production credentials, unsupported general scaling/state/secrets, interrupted-canary Waiting, and no post-task monitor authority. Those limits are not findings. The two Important findings below violate the required current capability/access checks, including checks after awaits, within that checkpoint.

## Strengths and verified contracts

- `src/core/services/k3s/operations.ts:57` registers an internal-symbol ledger worker; proposals use existing ledger idempotency and approval, rather than a second durable queue (`operations.ts:161`). Waiting before effects uses notStarted; uncertain completion uses task evidence and never blindly replays. The reconciliation branch does not treat an interrupted promotion's selected version or elapsed soak as completion (`operations.ts:194`).
- Approved state reaches the serialized driver apply check (`src/core/services/k3s/driver.ts:182`) and fixed operation CAS. `beforeMutation` records the ledger commit point and rechecks workload authority (`operations.ts:203`). The preparation operation explicitly excludes network writes.
- The new network path uses existing M10d snapshot/diff, tier-3 apply, sealed evidence and fresh readback (`src/core/network/index.ts:747`). The actual-policy comparison is present (`src/core/services/k3s/network.ts:53`); the generic secret key/value scanners and patch gate remain unchanged. A persisted k3s-public binding refuses legacy adapter fallback (`src/core/network/index.ts:180`).
- Read-only collection uses observe, not refresh (`src/core/services/k3s/driver.ts:244`); collection does not arm rollback/cleanup timers. Configured trusted identities and explicit sites are used, with independent node/control-plane/workload/readiness evidence (`operations.ts:225`, `operations.ts:250`). Native topology remains present. The generic manager explicitly skips K3s (`src/core/services/manager.ts:86`).

## Critical

None found in this task-scoped review. No claim is made that this simulation establishes production credential safety.

## Important

1. **Cached drivers can execute after the capability provider is revoked.** `src/core/services/k3s/operations.ts:88`, especially `operations.ts:96` and `operations.ts:126`.

   The driver cache is keyed by registration fingerprint, and `tools(cluster)` is resolved only when constructing that cached driver. Later proposal and execution checks ask that old driver whether its old port is available. Replacing the current provider result with `unavailableClusterTools` does not invalidate it. The network adapter, in contrast, consults the current provider each time.

   Confirmed with an actual Core/API/ledger probe: warm collection, propose a ready-version promotion, replace the provider result with `unavailableClusterTools`, then approve. The task finished `done`, the live version became `1`, and one switch executed although the current provider reported unavailable. This is a current capability revocation bypass, not a claim about missing future production credentials. It also permits continued stale collection through the old port.

   Fix: make the execution boundary consult current trusted capability, including provider replacement/removal, before every effect and after awaited preflight. Do not allow a cached old port to remain authoritative merely because metadata is unchanged. Retain observations separately if necessary. Add a regression that swaps the provider result, rather than only mutating the old object's `available()` method, and verifies no switch/prepare/rollback effect.

   Evidence: `task-3-review-probe.mts`, `task-3-review-probe.log` (exit 0; one focused probe file; tripwire never fired). Observed record: `taskState=done, live=1, currentAvailable=false, switches=1`.

2. **Cluster network apply loses requester authority and can write after hub or requester revocation during readback.** `src/core/services/k3s/operations.ts:130` and the network proposal handoff at `operations.ts:164`; `src/core/services/k3s/network.ts:57`.

   The facade checks actor/hub permission while creating the network proposal, but hands the change to `Network.start` without binding the requesting actor to the later cluster apply check. The target closure validates registration and current capability, but never active-hub or requesting-device authority. The existing M10d apply reads its target asynchronously and then writes (`src/core/network/index.ts:579`, `index.ts:607`); it has no cluster-specific authority check to fill that gap. This is introduced by using the adapter for cluster changes, not a request to redesign unrelated legacy targets.

   Two separate actual M10d/owned-loopback probes confirmed the issue. Both proposed via the cluster API as an approver device and approved the real tier-3 apply task. During the apply's awaited target read, one changed mesh state to standby with a different active hub; the other revoked that requester's `can_approve`. Each still completed `done` with one PUT and one rendered policy. Revocation occurred after approval and before the write, so the current request-time API gate cannot prevent it.

   Fix: preserve the original actor and relevant cluster registration binding in existing durable M10d/ledger task data and enforce current cluster apply authority at the actual write boundary, after awaited reads. Cover both hub and requester revocation. Preserve separately authorized dead-man revert/recovery behavior; do not accidentally disable recovery by treating it as a fresh user apply. Do not introduce a parallel approval registry.

   Evidence: `task-3-review-network-probe.mts`, `task-3-review-network-probe.log` (exit 0; two bounded scenarios in one focused probe; tripwire never fired). Observed records for both revocations: `taskState=done, writes=1, policies=1`; hub case additionally reports `role=standby, hub_id=replacement-hub`.

## Minor

3. **The canonical renderer accepts unregistered empty service entries.** `src/core/services/k3s/network.ts:25` and `network.ts:28`.

   Registration lookup occurs only inside the versions loop. An unknown service with the otherwise valid `{state:[expected],versions:[]}` entry passes and renders an empty policy list. The new protocol promises registered service keys and strict canonical shapes. No privilege expansion or policy write was demonstrated from this empty entry alone, so this is Minor, not a security escalation claim. Validate each service key against the registration before iterating versions; explicitly define whether empty version lists are legal for registered services. Include unknown and prototype-sensitive object keys in that check. The pure parser case was confirmed in `task-3-review-probe.log` (`rendered=[]`).

4. **Retain the host browser skip warning as an environment limitation.** `.superpowers/sdd/M10j/task-3-browser.log`.

   The host run contains repeated missing Chromium/WebKit warnings, with 3 static passes and 21 skips. It is not browser proof. The separate cached-container run has 24 passes, zero skips and exit 0, so this does not independently block the task. The implementation report correctly distinguishes these results; keep that distinction in later reporting.

## Checks, evidence and limits

- Inspected actual existing final log tails and warnings: covering-1 195/195, covering-final 35/35, final-api 54/54, each exit 0 and zero skips; typecheck-final exit 0; browser-container 24/24, exit 0, zero skips. Recorded tripwires never fired. These were inspected, not rerun. No final green test warning was found beyond the separately retained host-browser skip run.
- Inspected retained RED log tails for initial behavior, topology provenance, revocation, source-age regression, policy readback, availability and composition; each records exit 1. Earlier failures were not misrepresented as current passing evidence.
- Named focused unchanged-source checks: existing Network prepare/apply/write for whether authority is rechecked after target awaits; Network targets mergePatch/validatePatch/secret scanning for how the new canonical document enters existing safety gates; ServiceExpectedState for exact shape/equality; placement resolver for current device eligibility; ledger notStarted/committing for attempt semantics; mesh role/state and network routes for the authority-revocation probe. One search named a nonexistent `src/core/network/diff.ts`; the command reported it and subsequent inspection used the actual `targets.ts` location. No broad crawl or Git rerun occurred.
- Source package context was sufficient for changed functions; no changed source file was separately reread. A later mechanical diff scan mapped known review anchors to final line numbers; it did not constitute another source review pass.
- Live probes were restricted to unanswered concrete source doubts. The first used actual Core/API/ledger with committed K3s fakes and disposable homes. The second used the real existing M10d worker, disposable dummy-token fixture, canonical port and owned loopback target. No external network, real credentials/resources, installations, images or owner data were used.
- The initial network probe failed during fixture enrollment because its helper clock was not aligned with the injected Core clock; neither revocation scenario had executed. Its raw exit-1 log is retained as `task-3-review-network-probe-setup-failure.log`. The reviewer corrected only that temporary probe's clock and ran the two scenarios once successfully. No implementation test suite was rerun.
- No general scale/state/secret capability, public registration/credential onboarding, automatic reconnect replay, interrupted-canary completion receipt, post-task monitoring authority, or full Phase J completion was inferred. The supplied accepted limits do not contradict the scoped implementation brief's explicit rulings.
- Unchanged Task 1/2 implementation and production broker behavior were not re-audited. Existing boundary/browser logs establish their reported checks, not live production readiness. Main maintenance PR 281 and other checkouts were not touched.
- Review writes are only this report and the named temporary review probe/log artifacts in the ignored task directory. Source, index, HEAD, branch, screenshots, controller records and external services were not changed. All probe processes have ended. Review ownership is released; no further review writes are planned without another dispatch.

Assessment: The implementation has meaningful real-module coverage and preserves the major ledger/network/read-only boundaries. Approval is withheld because current capability and current authority revocation can both be bypassed at concrete execution boundaries.
