Owner input, 2026-10-31, binding for M10 design. Verbatim below.

---

Add this to the M10 Execution Plane design work as a binding input.
When the M10 ADR is written, it must cover service orchestration as
specified here; do not start implementing orchestration until the ADR
is merged, per Part 4's ADR-first rule.

SERVICE ORCHESTRATION (optional layer):
1. Nova gets a Service Manager with two drivers. Default: the existing
   supervisor running services as plain processes — Nova must remain
   fully functional with NO Kubernetes anywhere. Optional: a K3s
   driver. Same service definitions drive both; enabling K3s changes
   where services run, never what they are.
2. K3s topology choices the ADR must support: control plane on a
   local node (mini-PC class) OR on a small AWS/GCP VM with home
   devices as agent nodes over Tailscale/WireGuard. Running workloads
   must survive control-plane unreachability (no change != no service).
   Nova's own console may run as a workload, but the boot/supervisor
   agent always lives OUTSIDE the cluster.
3. Packaging: Helm. One standard "nova-service" chart; per-service and
   per-placement values. Releases are versioned; rollback is a
   first-class operation. GitOps sync (Flux preferred) from the same
   git repo Nova already uses as its change surface — every placement,
   version, or replica change is a git diff proposed through the Work
   Ledger and gated by the existing approval tiers.
4. Deployment pattern: new versions deploy ALONGSIDE the old, receive
   no production traffic, pass health + contract tests, then promote
   by shifting traffic after the applicable approval. Old version
   remains (scaled to 0) for a soak window; rollback = shift back.
   Auto-rollback on failed health after promotion.
5. Placement policy per service, expressed in its values: pinned to a
   device; preferred node + failover target; or floating (stateless,
   any healthy node). AWS/GCP failover is a SECOND independent cluster
   consuming the same GitOps repo (cold active-passive, one active
   site) — never a WAN-stretched cluster.
6. Device-native workloads: some services (capture above all) cannot
   run as containers on macOS/Windows — they need host screen/audio
   and OS permissions. Model them as first-class workloads in the same
   system: same manifests, versions, health, promotion gates and
   placement policy, executed by the device agent natively instead of
   as a pod. Capture must be deployable this way to any enrolled
   device (Mac, Windows, Linux). Two mechanics the ADR must state:
   (a) K3s agent nodes are Linux-only — macOS/Windows devices join
   the Nova network through Nova's device agent, never as kubelets;
   container workloads schedule only onto Linux nodes, native
   workloads onto any enrolled device. (b) UPDATES of a native
   workload roll out through the same promotion pipeline, executed
   locally by the device's runtime agent: fetch the signed new
   version, verify, run it alongside/shadow where the service
   supports it, health-check, switch, keep the prior version for
   one-step rollback. Nova-native capture is the pilot workload.
7. Topology view: the console gains a live architecture view — nodes
   (machines + cloud), the services on each with version, health
   (Kubernetes status MERGED with Nova device heartbeats, so native
   workloads and non-cluster devices appear too), placement policy,
   and promote/rollback actions. Interactive graph (Cytoscape/React
   Flow class), low density per DESIGN-SYSTEM (drill-in, never a
   dense cockpit), plus an exportable auto-generated diagram
   (Mermaid) of the same state for docs. An off-the-shelf cluster UI
   (Headlamp) may be linked as an optional admin surface but does not
   replace this view.
8. Credentials: cluster access is vault-held and per-cluster scoped;
   the chat model never holds a kubeconfig. Networking changes to the
   cluster follow the existing dead-man's-switch rule.
9. Device ROLES at pairing: enrollment asks what the device is FOR —
   multi-select intent, shown on the hub's approval screen and
   confirmed there: thin client (UI only), hub candidate, compute
   (inference / model serving), storage (models, data), capture
   source, general server. Roles are labels on the device record —
   combined with its hardware inventory (already collected at
   enrollment) they drive placement: e.g. an inference service's
   "preferred" resolves to compute-role devices with a suitable GPU.
   Roles are editable later in Settings > Devices, never permanent,
   and a device's roles bound what Nova may deploy to it (a
   thin-client-only phone never receives workloads). Hub remains an
   elected role per the existing one-active-hub rule, not a pairing
   declaration alone.
10. HUB PROMOTION as a first-class process (extends the M4 failover
    takeover into an explicit, user-initiated procedure): from
    Settings > Devices, "Promote to hub" on any hub-candidate device
    (Tier-3). Steps, all ledgered: eligibility pre-checks (role,
    hardware minimums, version parity, backup freshness) → state
    replication catch-up to the candidate → drain the current hub
    (no new tasks; in-flight work finishes or queues) → transfer
    (hub identity/fingerprint and the stable mesh name/address move
    to the candidate; devices re-point via that stable name, not by
    re-pairing) → old hub demotes to standby/spoke → verification
    window with automatic roll-back to the old hub if the new hub
    fails health checks. Emergency variant: promotion from the latest
    backup when the old hub is unreachable (cold, per the existing
    one-active-hub rule). The procedure must be rehearsable — a
    promotion drill with two test devices belongs in the M10 gate
    evidence, same as the backup restore drill.

11. ONBOARDING surfaces the backend choice. ONE installer for every
    platform; the setup flow detects the device (OS, resources) and
    explains, in plain language, what applies THERE:
    - Windows/macOS: the supervisor backend only — K3s is not offered
      (it needs Linux), with an honest get/miss summary: they get full
      Nova, native workloads (capture included), supervisor-run
      services, and full membership in a network whose K3s cluster
      lives on a Linux device or in the cloud; what this device cannot
      do is HOST container workloads locally. (K3s-inside-WSL2 is
      explicitly out of scope for onboarding v1.)
    - Linux: both backends, one screen, plain trade-offs (resources,
      the deployment/rollback extras K3s adds), supervisor
      pre-selected as the recommendation per DESIGN-SYSTEM "Nova
      recommends, fewer choices" — K3s is an opt-in, never a quiz.
    The backend choice is NOT permanent and never requires reinstall:
    it is switchable later in Settings > Services, and onboarding
    says so. Flow order: detect device -> create or join a network
    (pairing, incl. the role/intent selection from point 9) ->
    backend options for this OS -> done.

In the ADR, state explicitly what stays true with the K3s driver
disabled (answer: everything, via the supervisor driver), and sequence
any implementation AFTER the core M10 sandbox/browser work unless the
ADR argues otherwise with evidence.
