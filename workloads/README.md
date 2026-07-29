# Nova's runtime — the namespace she owns

The boundary for `capability-acquisition.md` shape 4. Inside this namespace
Nova creates, destroys and manages workloads with no merge and no per-action
approval (Jeremy, 2026-07-29). Everything that makes that safe is in this
directory, and it is safe for one reason:

> **The namespace policy is the control. Inspecting what she submits is not.**

A workload spec is arbitrary text — `privileged: true`, `hostPath: /`,
`hostNetwork: true`, a mounted docker socket. Checking her manifests for those
is a denylist, and a denylist is the prompt-shaped answer: it holds until
someone finds the entry it is missing. What holds instead is the API server
refusing those specs whatever they say, and the objects in this directory are
what make it refuse.

## Why these files are the durable artifact, and the cluster is not

Jeremy's stated direction (2026-07-29): ollama eventually runs only on the
Dell that has the GPU, most other services on a mini PC, possibly a VM or a
database or storage in the cloud. That is a multi-node cluster, and **k3d is a
single-host tool** — it runs k3s inside Docker on one box. It is the right
place to start and the wrong place to end.

The migration is nearly free IF the cluster stays disposable:

* **Every policy object lives here, in version control.** A cluster is
  recreated with `apply -f workloads/`; nothing important exists only inside
  it. If a control was ever added by hand at a terminal, it is not a control —
  it is a thing that will be missing on the next cluster.
* **Nothing depends on k3d-specific features** — not its bundled
  loadbalancer, not its local registry. Those are the parts that do not exist
  on real k3s nodes.
* **Manifests are plain Kubernetes.** k3d → k3s across the Dell and the mini
  PC is a cluster rebuild, not a rewrite.

Two things in his topology that Kubernetes then gives for free, and worth
knowing before designing around them:

* **The GPU pinning problem solves itself.** "ollama only on the Dell" is a
  node label plus a taint; scheduling is not something Nova has to be told
  about. That is a genuinely better answer than the current compose profile.
* **`remote-shared-state.md` phase 1 is already built** — real leader
  election on a pg advisory lock, 24s failover measured. The multi-instance
  half of his plan does not start from zero.

**A better start once the mini PC exists:** run k3s natively on it and give
Nova a kubeconfig pointing at it over the tailnet. That decouples "where Nova
runs" from "where her workloads run" — which is his end state anyway — and
avoids k3s-on-WSL2, which wants systemd and cgroup layout that WSL2 makes
awkward. k3d on this box is worth doing now because it proves the policy set
against a real API server; it is not worth defending later.

## What each file does

| File | The control it is |
|---|---|
| `namespace.yaml` | Pod Security Admission at `restricted`, via namespace LABELS |
| `networkpolicy.yaml` | default-deny both ways, then DNS and deliberate egress |
| `quota.yaml` | ResourceQuota + LimitRange — the cap costs were meant to provide |
| `rbac.yaml` | the ServiceAccount Nova acts as, and the verbs it does NOT have |

### Pod Security Admission, and the correction that matters

Enforcing `restricted` cluster-wide in k3s needs a server flag
(`--kube-apiserver-arg=admission-control-config-file=...`), which means
reconfiguring the cluster. Per-namespace enforcement needs no server flag at
all — it is three labels on the namespace, and the `PodSecurity` admission
controller is on by default in k3s. Only her namespace needs locking down, so
labels are both simpler and narrower.

**The consequence, and it is the whole reason `rbac.yaml` looks the way it
does:** if enforcement is a namespace label, then anyone who can edit the
namespace can delete the label and lift the enforcement. So her Role carries
no verb on namespaces — no `patch`, no `update`, not even on her own. Same
rule as everywhere else in this codebase: nothing she can write may be the
switch.

By the same logic she holds no RBAC verbs — no ServiceAccounts, Roles or
RoleBindings. An identity that can grant is not bounded by what it was
granted.

### NetworkPolicy

k3s enforces NetworkPolicy through an embedded kube-router controller, but
ships with **no policies**, which means the default is allow-all. Default-deny
is therefore something this directory creates, not something the cluster
provides. Without it, "deploy a workload" is a route to the Nova stack, the
host, and the LAN — every fence the containment plan spent five phases
building, bypassed by a pod.

Egress is opened deliberately, per workload need, and the interesting case is
that a service she deploys usually needs LESS than she will assume: Home
Assistant needs the LAN devices it controls, not Postgres, and not the
internet at large.

## Status — APPLIED and ATTACKED 2026-07-29. Exit criterion NOT met.

Cluster: `k3d cluster create nova --servers 1 --agents 0 --no-lb`, k3d v5.9.0
(checksum-verified against the release `checksums.txt`), k3s v1.35.5+k3s1, on
its own Docker network (`k3d-nova`, 172.20.0.0/16) separate from
`nova_default`. traefik and servicelb disabled — nothing here depends on
k3d-specific pieces.

**Three of the four controls hold. The network one has a hole, and it is the
hole that matters most for the workload type Nova would actually deploy.**

### Holds

| Attack | Refused by |
|---|---|
| `privileged: true` | PodSecurity `restricted:latest` — privileged |
| `hostPath: /` | PodSecurity — restricted volume type "hostPath" |
| `hostNetwork` + `hostPID` | PodSecurity — host namespaces |
| mounting `/var/run/docker.sock` | PodSecurity — restricted volume type |
| `runAsUser: 0` | PodSecurity — runAsUser=0 |
| 16 CPU / 64Gi request | LimitRange — max per container (note: the LimitRange caught it before the ResourceQuota did) |
| patch namespace, delete netpol, patch quota, create Role/RoleBinding/ServiceAccount, `pods/exec`, `pods/attach`, cluster-scoped verbs, other namespaces' secrets | RBAC |

Network, for an ESTABLISHED pod, all verified against a control pod in an
unpoliced namespace so "blocked" could not be confused with "unreachable":

* egress to the Nova backend and Postgres — REJECTED, while the same request
  from `default/control` succeeded
* cross-namespace ingress to a pod here — REJECTED
* intra-namespace pod-to-pod — 200, as intended
* DNS — works (`getent hosts kubernetes.default` resolves)

### The hole: pods are unpoliced for their first ~15 seconds

kube-router reconciles NetworkPolicy asynchronously after a pod starts.
Measured on the same pod, same target:

    t=0s    REACHED the Nova backend (curl=0)
    t=15s   rejected
    t=30s   rejected
    t=60s   rejected

**So a short-lived workload bypasses egress policy entirely.** A Job-based
probe — which lives a few seconds — reached every single target: the Nova
backend, Postgres, the compose bridge, the LAN gateway, 1.1.1.1 on the public
internet, and the kube-apiserver.

This is not a test artifact, it is the containment story failing for the exact
case that matters: Nova holds `create jobs.batch`, so "deploy a Job that
exfiltrates" is inside her granted rights and outside the policy's reach.
Nothing else in the boundary compensates — PSA constrains what a pod may BE,
not who it may talk to.

**The fix is the CNI, not the policy.** These manifests are correct; kube-router's
reconcile-after-start model is what leaves the window. A CNI that programs
policy as part of CNI ADD — Calico or Cilium — has no unpoliced moment,
because the pod's network does not exist until policy is attached. k3s
supports this: `--flannel-backend=none --disable-network-policy`, then install
the CNI. That is the next piece of work, and until it is done the network half
of this boundary should be treated as advisory.

### Three false signals, worth recording as method

The first probe reported the boundary as mostly holding. It was wrong three
times over, and each failure looked like a pass:

* `http://example.com` needs DNS. DNS was failing, so "blocked" meant "could
  not resolve" — not policy.
* `telnet://…:5432` and `http://192.168.0.1/` fail when nothing serves those,
  which is indistinguishable from being dropped.
* `nslookup kubernetes.default` returns NXDOMAIN in an UNPOLICED pod too — a
  search-domain quirk read as a policy failure.

The rewrite distinguished curl exit 0/52 (reached) from 7 (reached, refused)
from 28 (silently dropped), used raw IPs only, and compared every result
against an unpoliced control pod. It then showed nothing was blocked at all.

**A probe whose failure mode is indistinguishable from the property it tests
proves nothing.** Same rule as the eval harness: the fallthrough case must be
refusal, never a pass.

### Reproducing

    k3d cluster create nova --servers 1 --agents 0 --no-lb \
      --k3s-arg "--disable=traefik@server:0" \
      --k3s-arg "--disable=servicelb@server:0"
    kubectl apply -f workloads/

Headroom when created: 23 GB of 31 free, GPU 13.4 of 24.5 used.

Sources for the two enforcement facts above:
- <https://docs.k3s.io/security/hardening-guide>
- <https://kubernetes.io/docs/concepts/security/pod-security-admission/>
