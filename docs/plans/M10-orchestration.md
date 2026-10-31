# M10 addendum (ADR): service orchestration

**Sources:**
- The owner's input of 2026-10-31, binding for M10 design: `docs/builder-packet/INPUT-2026-10-31-SERVICE-ORCHESTRATION.md`. Its points are numbered 1–11 below as they are there.
- `docs/plans/M10.md`, the M10 ADR this adds to. It was merged before the input arrived.
- AMENDMENT-2026-10-30-C Part 4: design doc first, then build.
- ARCHITECTURE-AND-DECISIONS: ADR-1, ADR-2, ADR-3, ADR-8, ADR-9, ADR-10, ADR-11.
- NOVA-SPEC §6 (tiers), CONTRACTS §1 and §5, DESIGN-SYSTEM §1 and §5, CONTEXT-AND-CAPTURE, LOCAL-FIRST-AND-DEVICE-MESH, OPERATING-RULES.

**Status:** this is the design. Nothing here is built. The build starts only after this ADR and M10d (PR #241) are merged, in the phases under Order. Each phase lands as its own PR with its own gate.

**Tier numbers** follow NOVA-SPEC §6, as in M10.md: 0 silent, 1 act and report with undo, 2 ask first, 3 explicit confirmation every time.

## Decision

Nova gets a **Service Manager**: one place that knows which services Nova runs, which version, where, and how healthy each is. It has two drivers.
- **Supervisor (the default):** services run as plain programs, on the hub under the supervisor and on other devices under their device agent. No Kubernetes anywhere.
- **K3s (optional):** container services run as pods on Linux nodes, packaged with one Helm chart and synced from git by Flux.

The same service definitions drive both. Turning K3s on changes where a service runs, never what it is. Every placement, version or replica change is a git diff carried by the Work Ledger and gated by the tiers.

It is built **from what exists**, not beside it:

| Need | Built on | New |
|---|---|---|
| Running services | `src/supervisor/` (one child, the Nova server: restarts, safe mode, health, release slots, canary, rollback) | N services from definitions, not one |
| Services on other devices | `src/device/` (boot + runtime agents, signed runtime bundles, watchdog, heartbeat with hardware) | Native workloads run by the device agent |
| Changes | `src/core/changes/` (ADR-9 pipeline; releases committed to the home's git) | A `service` change kind; a services repo Flux reads |
| Where things run | `device` registry, `device_hardware` (`models/hardware.ts`) | Device roles; a placement resolver |
| Hub moves | `src/core/mesh/promote.ts`, `replica.ts`, fencing, `boot.ts findHub` | Planned promotion of any hub candidate, with drain, transfer and roll-back |
| Credentials | `vault.ts`; injection at use (`browser/logins.ts`; `infra/tool.ts` in PR #241) | Per-cluster kubeconfigs, never in a model's context |
| Network changes | M10d's dead-man's switch (`src/core/network/`, PR #241) | Nothing parallel: cluster network changes use it |
| Proof | M4c's two real Nova processes in temp homes; the restore drill; stand-in commands (`fake-tofu` in PR #241) | Fake `kubectl`/`helm`/`flux`, a simulated cluster, a promotion drill |

## Tiers used throughout

| Action | Tier |
|---|---|
| Reading status, the map, a plan or a diff | 0 |
| Proposing a placement, version or replica change (a git diff in the ledger) | 0: drafting |
| A new version started alongside, with no production traffic | 1: nothing serves from it; undo removes it |
| Promotion (traffic moves) of the console, a device agent, capture, or anything with secrets or OS permissions | 3 |
| Promotion of any other service; a replica count; moving a floating service | 2 |
| Automatic rollback after failed health | 1: Nova acts and reports |
| A rollback the person asks for | 2 |
| Turning the K3s driver on or off; joining a node to a cluster; cluster credentials | 3 |
| Any network change to a cluster (node joins over a tailnet, ingress, firewall) | 3, with the dead-man's switch |
| Widening a device's roles | 3: it changes what may run there |
| Narrowing a device's roles | 2: it may stop services there, and Nova says which |
| Hub promotion, planned or emergency; activating a cold cloud site | 3 |

## Point 1: the Service Manager and its two drivers

**What exists:**
- `src/supervisor/supervisor.ts` keeps exactly one child running: the Nova server. Restarts back off; three crashes a minute is safe mode; health is polled; code releases are git tags in slots (`releases.ts`), tested, started in a sandbox on a copy of the home, switched, watched by a canary, rolled back by themselves.
- Nova doesn't run Ollama or Screenpipe. It reaches them over HTTP (`models/ollama.ts`, `capture/screenpipe.ts`).
- Adapters behind thin interfaces: `Computer` in `computer/computer.ts` (ADR-8).
- `children.ts` tracks every process Nova starts.

**What's new:**
- `src/core/services/`: the registry of definitions, their releases and their live state.
- A `ServiceDriver` interface, so a third driver needs no caller changes: `available`, `plan`, `apply`, `status`, `switch`, `rollback`.
- **The supervisor driver** generalises the supervisor from one child to many. The Nova console becomes one definition (`nova-console`) whose artifact is the git tag it already uses. Its deploy path is unchanged.
- **The K3s driver** renders Helm values, proposes them as a git change, and reads the cluster through `kubectl` (Point 3).
- **Settings › Services**: what runs, where, at which version; the driver in use; switching it.

**Tiers:** as in the table above. Switching driver is tier 3. Each service moves through the pipeline, so a switch is a series of ordinary promotions, each one able to roll back.

**Gate:**
- the console runs from its definition, through the supervisor driver, with today's restart, safe-mode and canary tests unchanged and green;
- a second, plain-program service (a stand-in) is deployed, promoted, soaked and rolled back;
- the driver interface is exercised by both drivers' tests.

## With the K3s driver off

**What stays true: everything.** Every feature of Nova works through the supervisor driver:
- chat, memory, the ledger, the tiers;
- devices, pairing, failover and hub promotion;
- capture and other native workloads on every enrolled device;
- deploy alongside, health and contract tests, promotion, soak and one-step rollback;
- the map.

What only K3s adds:
- container services scheduled across several Linux nodes;
- pod-level restarts and rescheduling by the cluster;
- Flux keeping the cluster in step with git.

None of those is needed for Nova to work.

**How it is tested:**
- The whole suite (`npm test`, the UI gate and the fresh-user test) runs in CI with no Kubernetes anywhere.
- No `kubectl`, `helm`, `flux` or `k3s` on the machine. A tripwire put first on `PATH` fails the test if any of them is called. This follows the egress tripwire in `tests/acceptance/egress-guard.ts`.
- No `KUBECONFIG` is set, and no `~/.kube` exists in the test homes.
- The K3s driver's own tests are the only ones that put the fakes on `PATH`.
- **Gate:** that CI run is green, and its log shows the tripwire was armed and never fired.

## The service definition

**One format, both drivers.** A definition is a JSON file (plain files, ADR-4; no YAML library is needed). It is versioned and released through the change pipeline like any other change.

```json
{
  "service": "inference",
  "version": "1.4.2",
  "artifact": {
    "image": "registry.example/runtime@sha256:…",
    "program": {
      "linux-x64":    { "url": "…", "sha256": "…", "command": ["bin/runtime", "serve"] },
      "darwin-arm64": { "url": "…", "sha256": "…", "command": ["bin/runtime", "serve"] },
      "win32-x64":    { "url": "…", "sha256": "…", "command": ["bin\\runtime.exe", "serve"] }
    }
  },
  "ports": [{ "name": "api", "port": 11434 }],
  "health": { "http": "/api/version", "every_s": 30 },
  "contract_tests": ["probe:runtime-lists-models"],
  "alongside": "full",
  "placement": { "mode": "preferred", "roles": ["compute"], "needs": { "gpu_vram_gb": 8 }, "failover": "any" },
  "resources": { "memory_mb": 4096 },
  "state": { "volume": "models", "size_gb": 50 },
  "secrets": [],
  "egress": "local",
  "os_permissions": [],
  "soak_s": 86400
}
```

- **`artifact`** holds up to two forms:
  - `image`, a container, pinned by digest;
  - `program`, signed files per OS and CPU, with the command that starts them.
- **Which form runs where:**
  - The K3s driver runs `image` as pods on Linux nodes.
  - Both drivers run `program` as a native workload, through the supervisor on the hub and the device agent elsewhere. A native workload is never a pod (Point 6).
  - With no `image`, the service never enters the cluster.
  - With no `program`, the supervisor driver runs the image only where Docker is (M10a's adapter rules). Elsewhere it says plainly that the service can't run on this device.
- **`alongside`** is how a new version runs next to the old one:
  - `full`: both serve, on different ports;
  - `shadow`: the new one runs, but its output is thrown away (capture);
  - `copy`: the new one runs on a copy of the state. This is what the supervisor already does for the console: a sandbox on a copy of the home, since SQLite has one writer.
- **Validation** refuses each of these, in plain words:
  - a floating service that has state;
  - an `image`-only service pinned to a macOS or Windows device;
  - a placement no device's roles allow;
  - a secret written as a value rather than a `secret://` name.

**How it maps to the `nova-service` chart's values** (the K3s driver writes a JSON values file; Helm accepts JSON, since JSON is YAML):

| Definition | Chart value | Supervisor driver |
|---|---|---|
| `service`, `version` | release `<service>`; one Deployment per version, `<service>-<version>` | one slot per version |
| `artifact.image` | `image.repository`, `image.digest` | Docker, where present |
| `artifact.program` | not rendered | started by the supervisor or the device agent |
| `ports` | `service.ports`; a stable Service plus a preview Service per version | a stable port, forwarded by the supervisor or the boot agent |
| `health` | readiness and liveness probes | the supervisor's health loop |
| `contract_tests` | not rendered; Nova runs them against the preview Service | Nova runs them against the new port |
| `placement` pinned | `nodeSelector: nova/device=<id>` | that device |
| `placement` preferred and failover | preferred node affinity, then a required rule on the failover's labels | the resolver picks, and moves it on failure |
| `placement` floating, `replicas` | `replicas`, topology spread | one instance per eligible device asked for |
| roles and `needs` | `nodeSelector` on `nova/role-<role>` labels, `nova/gpu-vram-gb` | the device record and `device_hardware` |
| `resources` | requests and limits | refused where the device can't fit it |
| `state` | a local-path volume | a folder under the service's own home |
| `secrets` | names only; Nova creates the Secret at apply time, never in git | from the vault, at start |
| live version | `live: <version>` (the stable Service's selector) | which slot the stable port points at |
| `soak_s` | the previous Deployment kept with 0 replicas | the previous slot kept, stopped |

- **Gate:**
  - a validator test for each refusal above;
  - one definition rendered by both drivers, with snapshot tests of the values file and of the supervisor's plan;
  - the chart linted by the fake `helm`, against a schema kept in the repo.

## Point 2: K3s topologies, and losing the control plane

**What exists:** the mesh and its addresses (`NOVA_MESH_PUBLIC_URL`), heartbeats and the Online window (`mesh/spokes.ts`, `devices.ts`). Nova has no cluster concept today.

**What's new:**
- A `cluster` record: id, name, control-plane address, site (`home` or `cloud`), state (`active` or `cold`), and its kubeconfig's vault name.
- Two topologies, both supported by the same driver:
  - the control plane on a local Linux node (mini-PC class);
  - the control plane on a small cloud VM, with home devices as agent nodes over a tailnet or WireGuard.
- **The supervisor and the boot agent always live outside the cluster.** The console may run as a workload, but only pinned to the hub, with the home on that node's disk. The supervisor watches it. If the cluster can't run it, the supervisor starts the last good console release as a plain program. It does this only once the pod is confirmed stopped on that node, so that one home never has two writers.
- **Proposed default:** the console stays under the supervisor even with K3s on. Running it as a workload is a later opt-in.

**When the control plane can't be reached (changes stop; service doesn't):**

| Keeps running | Stops, and says why |
|---|---|
| Every pod already running on a reachable node, restarted locally by its kubelet | New deploys, promotions, rollbacks and replica changes for cluster services: they queue as ledger tasks, waiting |
| Every native workload and supervisor-run service | Rescheduling: a pod on a node that dies stays down until the control plane is back |
| The hub, the ledger, chat, devices, capture | Flux sync: git keeps the changes, and the cluster catches up when it is back |
| Health from device heartbeats | Cluster health on the map: shown as "last known, at <time>", never as healthy |

- Nova never treats an unreachable control plane as an outage of the services. It is a problem with a playbook, shown on Health.
- **Gate:** the simulated cluster loses its control plane. Running pods report healthy through heartbeats. A promotion queues with a plain-words reason, and finishes once the control plane is back. Nothing is rescheduled, and nothing is shown as healthy that wasn't checked.
- **Honest limit:** the simulation proves Nova's side. That a real kubelet keeps pods running without its server is K3s's own documented behaviour. Proving it on a real cluster needs the owner's OK (Hard limits).

## Point 3: Helm, releases and GitOps

**What exists:**
- The change pipeline commits each release into the home's git, as `changes/<target>/<version>-<id>/` (`changes/pipeline.ts`, `#release`).
- Supervisor releases are git tags (`supervisor/releases.ts`).
- M10c gives Nova its own repository and worktrees (`coding/git.ts`).

**What's new:**
- **One chart, `charts/nova-service/`, in this repo,** versioned with Nova. Values per service and per placement.
- **A `service` change kind** in `changes/gates.ts` (a core change, so tier 3, made by this build). It covers placement, version and replica changes. Its artifact is the definition plus the rendered values. Its stages are the pipeline's own: sandbox, tests, health, release, approval, canary, promote.
- **The services repository:** a git repository inside the home (`services.git`), written only by the pipeline's promote stage. Each commit carries the change's id and ledger task, and Flux reads it.
  - Why a separate repository: the home's own history holds the person's files. A cluster, possibly on a cloud VM, must never be able to read them. It is the same change surface (the pipeline and the ledger), as a repository that holds only service manifests. See Conflicts, row 7.
- **Flux** watches one branch of that repository, read-only, with a per-cluster deploy key held in the vault.
- **Rollback is a git revert, made by the pipeline, which Flux applies.** Nova never runs `helm rollback` by hand: Flux would apply the old state again.

**Tiers:** per the table. A diff the person hasn't approved never reaches the branch Flux reads.

**Gate:**
- a version change is a ledger task whose evidence is the diff and the commit;
- the fake `flux` applies only commits on the watched branch;
- a commit put there by anything other than the pipeline is reported as drift and reverted through the pipeline;
- a rollback is a revert commit, and the simulated cluster ends on the previous version.

## Point 4: deploy alongside, promote, soak, roll back

**What exists:** the pipeline's fixed stages and canary with automatic rollback (`changes/gates.ts`, `pipeline.ts`). The supervisor's sandbox start on a copy of the home, its switch and its canary (`supervisor.ts deploy`).

**What's new:** the same stages, applied to services:

| Pipeline stage | For a service |
|---|---|
| sandbox | the new version starts alongside (`full`, `shadow` or `copy`), with no production traffic |
| tests | contract tests against its preview port or Service |
| health | its own health check, passing several times running |
| release | the signed release; the commit to the services repository |
| approval | per the tier |
| canary | traffic shifts (the stable port or the Service selector), then a watch window |
| promote | the old version kept with 0 replicas (or stopped, with its slot kept) for `soak_s`; rollback is shifting back |

- Failed health after promotion rolls back by itself, at any point in the soak (tier 1).
- After the soak, the old version is removed and the record says so.
- **Gate:**
  - a version that fails its contract tests is never offered;
  - a version that fails health in its canary rolls back by itself;
  - a version that fails during the soak rolls back in one step, with no rebuild or download;
  - all of this on both drivers.

## Point 5: placement

**What exists:** the device registry (`mesh/devices.ts`), hardware per device from the heartbeat (`device_hardware`, `models/hardware.ts`), and the Online window.

**What's new:** a resolver from a definition's placement to a device, using roles (Point 9), hardware and health.
- **Pinned:** that device only. If it is down, the service is down, and Nova says so.
- **Preferred plus failover:** the best eligible device, for example a compute-role device with enough GPU memory. If it is unhealthy past a set window, the service moves to the failover target. With K3s, that move needs a reachable control plane.
- **Floating:** stateless only, on any healthy eligible device.
- **A cloud failover site is a second, independent cluster** reading the same services repository. It is cold: its values say `site: cold`, so everything is at 0 replicas, and Flux is suspended there. One site is active at a time, and the cluster is never stretched over a WAN. Activating it is tier 3 (it spends) and is part of the emergency hub promotion when the hub moves to the cloud (Point 10).

**Gate:** resolver tests, one per mode and per refusal. A preferred service moves to its failover when the stand-in device stops heartbeating. A cold site in the simulation runs nothing until it is activated, and activating it asks at tier 3.

## Point 6: native workloads on devices

**What exists:**
- The device agent in two parts (`src/device/`, ADR-3, written in TypeScript; see the LEDGER, M4b).
- The boot agent installs runtime bundles only when a pinned key signed them (`trust.ts verifyBundle`), reports refusals to the hub, and keeps the runtime under a watchdog (`watchdog.ts`).
- The runtime runs under Node's permission model: no network, **no child processes**, no addons. It asks the boot agent to make its hub calls (`RUNTIME_CALLS`).
- Capture today: the hub pulls a Screenpipe the person runs themselves (`capture/screenpipe.ts`). Devices can send `capture_event` through the inbox. The LEDGER (M6a) records that the runtime can't read the active window, because it may not start processes.

**What's new:** native workloads, first-class in the same system: the same definitions, versions, health, promotion gates and placement, executed by the device agent instead of as a pod.
- **Who starts them** (needs owner decision, Conflicts row 2). Proposed:
  - the boot agent gains a small, fixed set of verbs: install a verified artifact, start, stop, switch, probe health on loopback;
  - the runtime agent decides when to call them and reports results in its heartbeat;
  - workloads run as the person's own user, never as root, under the boot agent's watchdog.
- **The heartbeat** gains `workloads[]`: service, version, health and since when.

**6(a), as given:**
- K3s agent nodes are Linux only.
- macOS and Windows devices join the Nova network through Nova's device agent, never as kubelets.
- Container workloads are scheduled only onto Linux nodes. Native workloads go onto any enrolled device whose roles allow them.
- The validator refuses anything else (The service definition).

**6(b), as given:** an update of a native workload rolls out through the same promotion pipeline, executed locally by the device's agent:
1. fetch the signed new version;
2. verify it: the hub's signature over the manifest, with a pinned key, and every file's hash, like `verifyBundle` (which today accepts only `.ts` file names, so binaries need a verifier of their own);
3. run it alongside, or in shadow, where the service supports it;
4. health-check it;
5. switch;
6. keep the prior version for one-step rollback.

**Capture is the pilot.**
- Deploying capture to a device never turns capture on. Consent stays off by default, per source and per device (CONTEXT-AND-CAPTURE, `capture/capture.ts`).
- In shadow, the new version's output is discarded on the device and never stored or sent.
- iPhones and iPads get no capture workload: the platform allows no passive capture.

**Tiers:** promoting capture is tier 3, since it touches OS permissions and the most private data.

**Gate:** with a stand-in capture program, deployed to stand-in devices labelled Linux, macOS and Windows:
- a signed update installs, shadows, passes health and switches;
- a tampered artifact is refused and reported;
- a failing version rolls back in one step;
- an image-only service can't be placed on the macOS or Windows device;
- capture consent stays off throughout.

**Honest limit:** on macOS, a screen-recording permission is tied to the program's code signature. An update with a different signature asks the person again. Real updates without that prompt need a stable signing identity, which is an account and a cost: the owner's call (Hard limits).

## Point 7: the topology view

**What exists:**
- Settings › Devices: the registry, roles, Online, revoke. Health's Devices check, with the standby's lag. The tier-3 promotion sheet (`ui/js/components.js promoteSheet`).
- The UI is plain JavaScript modules with no build step and **no runtime dependencies** (LEDGER, Dependencies). There is no graph library.

**What's new:** a live map of the person's system, reached from Settings › Services and from Health's Devices card. It is not a new rail destination.
- **Nodes:** machines and cloud sites. **On each:** its services, with version, health and placement.
- **Health is merged:**
  - Kubernetes status (nodes, pods) where there is a cluster;
  - Nova's heartbeats for every device, so native workloads and devices outside the cluster appear too;
  - a device in both shows the worse of the two, with both reasons;
  - stale data shows its age.
- **Actions:** promote and roll back open the existing approval sheet at the right tier.
- **Low density** (DESIGN-SYSTEM §1), in three layers:
  1. machines as cards, each with a name, its roles and one status;
  2. tapping one shows its services;
  3. tapping a service shows its versions and actions.

  On a phone, the same structure is a list.
- **The interactive graph** uses hand-drawn SVG, with no new dependency. This is proposed; it needs owner decision (Conflicts row 6).
- **Export:** a Mermaid `flowchart` generated as plain text from the same state, for docs. Nova writes the text; it doesn't need Mermaid's library to do it.
- **Headlamp** may be linked from Settings › Services as an optional admin page, if the person runs one. Nova never installs it, and it doesn't replace the map.
- **Gate:**
  - browser tests at phone and desktop widths, in every starter package;
  - merged health correct for a cluster node, a non-cluster device and a native workload;
  - the export's text matches the state, in a snapshot test;
  - promote and rollback reach their sheets;
  - the M9 budgets hold.

## Point 8: credentials and network changes

**What exists:**
- The vault (`vault.ts`): values by `secret://` name, redacted from logs and receipts.
- Injection at the moment of use: M10b's logins and redactor (`browser/logins.ts`); M10d's tool adapter handing provider secrets to one process (`infra/tool.ts`, PR #241).

**What's new:**
- **One kubeconfig per cluster,** at `secret://clusters/<id>/kubeconfig`, scoped to Nova's own namespaces where the cluster allows it. Full admin rights are used only for the tier-3 bootstrap.
- Each call to `kubectl`, `helm` or `flux` takes an argv, never a shell string. The kubeconfig is written for that one call to a 0600 file in a 0700 temp folder, then removed. The tool's output passes through the redactor.
- Nova never uses an ambient `~/.kube/config` or `KUBECONFIG`, as M10a pins Docker's socket.
- **The chat model never holds a kubeconfig.** Tools take a cluster id; their results are redacted.
- **With a cloud control plane, no vault secret is stored as a cluster Secret** (ADR-10: the cluster's store would leave the home). A service that needs a secret stays on the supervisor driver or a home control plane. Proposed default (Conflicts row 10).
- **Network changes to a cluster** follow M10d's rule: snapshot, diff, apply, dead-man's switch. That includes a node joining over a tailnet, ingress and firewall. Tier 3 always.

**Gate:**
- canary secrets never appear in a transcript, a log, the services repository or the simulated cluster's state;
- a fake `kubectl` sees the kubeconfig only during its own call;
- an ambient kubeconfig is ignored;
- a cluster network change reverts by itself when the stand-in loses contact.

## Point 9: device roles at pairing

**What exists:**
- Enrollment (`mesh/enroll.ts`, CONTRACTS §5) carries name, platform and capabilities, shown on the hub's approval screen.
- `device.role` is the mesh role (client, spoke, standby, hub).
- Hardware arrives with the device agent's heartbeat, right after pairing (`device_hardware`). Phones and browsers run no agent, so they have no hardware record.

**What's new:**
- **Roles,** chosen at pairing as a multi-select of intents, shown on the hub's approval screen and confirmed there:
  - thin client (UI only);
  - hub candidate;
  - compute (inference, model serving);
  - storage (models, data);
  - capture source;
  - general server.
- They are stored as labels on the device record, in a new field (`purposes` in code, "Roles" on screen), so they never collide with the mesh `role`.
- **Roles plus hardware drive placement:** for example, "preferred" for an inference service resolves to compute-role devices with a suitable GPU.
- **Roles bound what may be deployed.** A thin-client-only phone never receives a workload. This is checked twice: when a change is proposed, and by the device agent, which refuses an assignment its roles don't allow.
- **Editable later** in Settings › Devices, never permanent. Widening is tier 3; narrowing is tier 2.
- **Hub stays an elected role** under the one-active-hub rule. Hub candidate only makes a device eligible.
- **Devices paired before this:** phones and browsers become thin clients and a standby becomes a hub candidate. Computers get no workload role until the person picks one. Nothing runs on them today, so nothing moves.

**Gate:**
- pairing with roles in the browser test;
- the approval screen shows and can change them;
- placement on a thin client is refused at proposal and again at the device;
- an edit in Settings › Devices is tiered as above;
- the fresh-user test passes.

## Point 10: hub promotion

**What exists (M4):**
- `mesh/promote.ts` promotes **the standby only**: the epoch goes up by one, a new roster is signed with the standby's own key, the promotion is recorded as a verified ledger task, and the old hub fences itself when it returns.
- Devices pin only the hub's and the standby's keys (`trust.ts rosterKeys`). They follow the roster to the new hub without pairing again (`boot.ts findHub`), never to a lower epoch.
- A hub that stepped down keeps no live copy, and must be enrolled again before it could take over.
- There is no drain. `ledger.recover()` requeues running work on the new hub.
- Automatic failover exists, off by default (`mesh.auto_failover_after_s`).
- Backups never hold private keys or the vault's key (`resilience/backup.ts`). A restore sets the epoch to max + 1 (`restore.ts`).
- Proven with two real Nova processes in temp homes on loopback (`tests/acceptance/m4c-failover.test.ts`, `m4c-support.ts`).

**What's new:** "Promote to hub" on any hub-candidate device, from Settings › Devices. Tier 3. Each step is a ledger task in one chain, as M10c's coding run is:

| Step | What happens | Evidence |
|---|---|---|
| 0. Become standby | If the candidate isn't the standby, it is enrolled as standby first, replacing the current one (said on the sheet) | its replica's state |
| 1. Pre-checks | role; hardware (free disk at least three times the home's size, enough memory); the same release and schema version (`schemaVersion`); a backup in the last 24 h whose restore drill passed | each check, in words |
| 2. Catch-up | replication lag to zero (`lag()`) | the acknowledged sequence |
| 3. Drain | the hub starts no new tasks. Running ones finish within a bound, or are handed over and requeued on the new hub. A step past its commit point is never cut (`uncancellable`, M10c). Then writes are held, so the last sequence is fixed. | the drained list |
| 4. Transfer | the candidate confirms it holds the last sequence. The old hub signs a handover naming the candidate at epoch + 1. The candidate signs the new roster: itself as hub, the old hub as standby. The stable mesh name now points at the candidate. Devices re-point through that name, with no new pairing. | the roster, the handover, devices back online |
| 5. Demote | the old hub becomes the standby: a live copy of the new hub, not today's stepped-down, read-only node | its replica's lag |
| 6. Verify | a window (30 min proposed, longer allowed, never shorter) of health probes and device reconnects. On failure, an automatic roll-back: the same swap in reverse, at epoch + 2 (tier 1). Epochs only rise. | probe runs |

- **The stable name** is the mesh address devices already use first (`NOVA_MESH_PUBLIC_URL`, for example `hub.example`). Moving it is a DNS or tailnet change, so it is tier 3 with the dead-man's switch. In tests, it is a loopback forwarder the test controls.
- **Keys never move.** What transfers is the mesh's identity: the roster's lineage and the stable name (Conflicts row 4).
- **Emergency variant** (the old hub can't be reached):
  - With a live standby, it is today's promotion, which is already built and tested.
  - Without one, the candidate restores the latest backup that passed its drill. It keeps its own keys and takes epoch max + 1. This is cold.
  - What it says plainly: what was written after that backup is lost, with the backup's time shown. Connectors need signing in again, because the vault's key is never in a backup (open question 5).
  - Devices accept the candidate only if they pinned its key. **Proposed:** the roster pins every hub candidate's key, not only the standby's, so a cold promotion needs no new pairing (Conflicts row 5).
  - If the old hub comes back, it is fenced, as today.
- **Rehearsable:** a promotion drill, as the restore drill is. Settings › Devices can rehearse on scratch copies of the hub's home on the hub, never touching the live home (`resilience/drill.ts` pattern).
- **Gate: the promotion drill with two test devices.** It runs safely as M4c does: two Nova homes in temp dirs on this machine, real processes on loopback, a stand-in computer agent (`tests/core/mesh-support.ts`), and a stand-in stable name. No real device, DNS or tailnet is touched. Cases:
  1. a planned promotion succeeds, with no data lost (content hashes) and the computer re-pointed without pairing again;
  2. the new hub fails its verification and the old one is back as hub by itself;
  3. an emergency promotion from a backup, saying what it couldn't bring;
  4. the old hub returns and fences itself;
  5. at no moment do two nodes accept writes.

  Its evidence goes in the M10 gate evidence, next to the restore drill.

## Point 11: onboarding

**What exists:**
- First-run setup is a scripted conversation (`core/setup.ts`, steps `user_name` … `done`). It already says per-platform limits in plain words (`CAPTURE_NOTE`).
- Pairing has three front doors. The computer's is `join.sh`, a POSIX shell script that needs Node 26, so Windows has no native front door today.
- Settings has Devices (`ui/js/settings-ia.js`) and no Services.

**What's new:**
- **One installer for every platform:** one address and one flow that detect the OS and resources. In the build it is the same Node-based agent behind `join.sh` and a PowerShell one-liner. Signed native packages are the owner's call (Hard limits).
- **Flow order:**
  1. detect the device;
  2. create or join a network (pairing, with the roles from Point 9);
  3. backend options for this OS;
  4. done.
- **The backend step, in plain words.**
  - **Windows and macOS:** the supervisor only. K3s isn't offered, because it needs Linux:

    > "On this computer, Nova runs its services as ordinary programs. You get all of Nova, including capture (with your permission) and the services Nova runs for you. You can join a network whose cluster runs on a Linux machine or in the cloud. What this computer can't do is host container services itself; those run on a Linux device. You can change this later in Settings › Services."

  - **Linux:** both backends, on one screen, with the supervisor pre-selected as Nova's recommendation (DESIGN-SYSTEM: fewer choices). K3s is an opt-in, never a quiz:

    > "Recommended: ordinary programs. It's lighter and needs nothing extra. Or K3s, a small Kubernetes: it adds side-by-side deploys and one-step rollback for container services, and uses more memory and disk (its published minimums are shown next to this computer's). You can switch later in Settings › Services, without reinstalling."

  - **A Linux inside WSL2 counts as Windows here:** K3s inside WSL2 is out of scope for v1.
- **Not permanent:** the choice can be switched in Settings › Services (tier 3, Point 1), and onboarding says so.
- **Only what is built is offered.** Until the K3s phase lands, Linux shows the supervisor alone.

**Gate:**
- browser tests of the flow on stand-in Linux, macOS, Windows and WSL2 detections, each showing its own summary;
- the supervisor is pre-selected;
- the switch in Settings › Services asks at tier 3;
- the fresh-user test passes.

## Hard limits during the build

These follow M10.md's, and the build never crosses them:
- **No real cloud VMs or accounts, and no spending.**
- **No K3s, Helm or Flux installed on the owner's machine** without the owner's OK.
- **No real network changes:**
  - no tailnet, WireGuard, DNS or router change;
  - no moving of a real stable name;
  - no change to the owner's Tailscale Serve settings or ports.
- **Tests use stand-ins only:**
  - fake `kubectl`, `helm` and `flux` in `scripts/stand-ins/`, on a test-only `PATH`, as `fake-tofu` is in PR #241;
  - a simulated cluster: a state file the fakes read and write, with nodes, pods, readiness and a "control plane reachable" switch;
  - temp homes for every Nova, as in M4c;
  - a stand-in capture program;
  - a loopback forwarder for the stable name.
- **No image pulls** beyond M10a's one pinned image.
- **No real device receives a workload,** and no real hub is promoted. Real-device checks stay deferred, as pairing is (LEDGER).

**What would need the owner's OK to go real:**
- installing K3s, Helm or Flux on any machine, and running a real cluster;
- a cloud VM or account, any spend, and a cold cloud site;
- joining real devices as nodes over a tailnet or WireGuard; moving the real stable name;
- deploying a real capture program to a real device, and the OS permission grants it needs;
- signing identities for macOS and Windows programs and installers (accounts and a cost);
- pulling real service images, such as a model runtime;
- running a real promotion between the owner's own hub and standby;
- linking a Headlamp; any new runtime dependency, such as a graph library.

## Packet conflicts

Each place where the input pulls against the packet or an ADR, with a proposed resolution. None is resolved silently.

| # | The input | Pulls against | Proposed resolution | Owner? |
|---|---|---|---|---|
| 1 | Many services, possibly the console as a workload | ADR-1: one deployable core | Nova core stays one deployable. Services are things Nova runs, not pieces of Nova, and the console is never split. | No: consistent if the rule holds |
| 2 | 6(b): native updates run by "the device's runtime agent" | ADR-3: the runtime can't start processes or use the network (tested) | The boot agent gains fixed verbs (install a verified artifact, start, stop, switch, probe); the runtime decides and reports. Alternative: a third, confined "workload host". | **Needs owner decision** |
| 3 | Native capture as the pilot | ADR-2: capture and native parts in Rust. The device agent is TypeScript (LEDGER M4b: no Rust toolchain here). | The build uses a stand-in program. Which real program is the pilot is open question 4. | **Needs owner decision** |
| 4 | Point 10: "hub identity/fingerprint … move to the candidate" | ADR-11 and CONTRACTS §5: keys are made on the device and never leave it | The mesh's identity (the roster's lineage at a higher epoch, signed by a pinned key) and the stable name move. Private keys never do. | **Needs owner decision** |
| 5 | Promotion of any hub candidate, transfer and roll-back | One active hub (ADR-11). Devices pin only the hub's and standby's keys; a stepped-down hub keeps no copy. | Writes are held during transfer, and epochs only rise (a roll-back is epoch + 2). Fencing covers every candidate. The roster pins every hub candidate's key, which widens who devices accept as hub, each one approved at tier 3. | **Needs owner decision** (the widened pinning) |
| 6 | A Cytoscape or React Flow class graph | No runtime dependencies (LEDGER); plain-JS UI with no build step. React Flow needs React and a bundler. | Hand-drawn SVG with drill-in. Or vendor Cytoscape as one pinned file, MIT licensed and with no dependencies of its own, as the first runtime dependency. | **Needs owner decision** |
| 7 | GitOps "from the same git repo Nova already uses" | ADR-9: the pipeline is the only way in. The home's history also holds the person's files, which a cluster must not read. | A services repository in the home, written only by the pipeline's promote stage. Flux applies it, and drift is reverted through the pipeline. Rollback is a revert, never `helm rollback`. | **Needs owner decision** (separate repo vs. the home's own) |
| 8 | K3s on a mini-PC or a cloud VM, agent nodes, Helm, Flux | M10's hard limits: containers only on this machine, one image pull, no real infra or network changes | The whole build is stand-ins. Going real is the list above. | **Needs owner decision** to go real; none to build |
| 9 | A live architecture graph | DESIGN-SYSTEM: low density, no cockpit; a card never becomes a table; the rail has at most 6 destinations | Three layers with drill-in, machines first. It is reached from Settings › Services and Health, not the rail. A list on phones. | No: the input asks for low density too |
| 10 | A control plane on a cloud VM | ADR-10, local-first: a cluster's Secrets would sit on the cloud VM | No vault secret is stored in a cloud-controlled cluster. Services needing one stay at home. | Proposed default; the owner may relax it |
| 11 | Deploy capture "to any enrolled device" | CONTEXT-AND-CAPTURE: off by default per source and device; no passive capture on iOS | Deploying is not consenting: consent stays separate and off. iOS gets no capture workload. | No |

## Order

After M10d (PR #241). These are **phases of M10**, named M10e–M10k, not a new milestone:
- The input is binding for M10's design and puts the promotion drill in the M10 gate evidence.
- ROADMAP-AND-GATES has no M11, and a new milestone would need a packet amendment.

Each phase is its own PR with its own gate, an independent review (adversarial for M10g, M10h and M10j), CI and a merge. The preview is restarted after each. Gate evidence goes in `docs/evidence/m10<x>-gate.md`.

| Phase | What | Needs first |
|---|---|---|
| **M10e** | Service Manager, the supervisor driver, the definition format and validator, the `service` change kind; the console as a definition; the no-Kubernetes suite and tripwire | M10d merged |
| **M10f** | Device roles at pairing and in Settings › Devices, the placement resolver; onboarding's order and per-OS summaries (supervisor only) | M10e |
| **M10g** | Hub promotion, planned and emergency, and the promotion drill | M10f (hub candidates); the owner's answer to open question 2 |
| **M10h** | Native workloads on devices (6(a), 6(b)), with the capture pilot on a stand-in | M10f; the owner's answer to open question 1 |
| **M10i** | The map: merged health, drill-in, actions, the Mermaid export | M10e–M10h; the owner's answer to open question 3 |
| **M10j** | The K3s driver: the `nova-service` chart, the fakes, the simulated cluster, per-cluster credentials, control-plane loss | M10e; M10d's dead-man's switch |
| **M10k** | GitOps (the services repository, Flux), the cold second site, switching backend in Settings › Services, K3s in onboarding on Linux | M10j; the owner's answer to open question 6 |

**Why this order:**
- the supervisor path and device roles come first, because everything else rests on them and they work with no Kubernetes;
- hub promotion builds on tested M4 code and needs no ADR-3 change, so it comes before native workloads, which do;
- the map comes once there is something to draw, and gains cluster data in M10j;
- K3s comes last, because it is optional.

## Open questions for the owner

Each has a proposed default. None blocks M10e or M10f.
1. **Who starts native workloads on a device** (Conflicts row 2)? Proposed: the boot agent, with a fixed set of verbs, for hub-signed workloads only.
2. **What "hub identity moves" means** (rows 4 and 5)? Proposed: the roster's lineage and the stable name move, keys never move, and every hub candidate's key is pinned.
3. **The graph** (row 6)? Proposed: hand-drawn SVG, with no new dependency.
4. **The real capture pilot,** once the owner allows real devices. Proposed: Screenpipe as a managed native workload, since the hub already ingests it, with a Nova-built Rust component later under ADR-2. Signing identities for macOS and Windows are the owner's accounts.
5. **Secrets after an emergency promotion from a backup:** escrow the vault's key under the recovery key, or ask the person to sign connectors in again? Proposed: sign in again, said plainly on the sheet. No escrow until the owner decides.
6. **The GitOps repository** (row 7)? Proposed: a services repository in the home, written only by the pipeline.
