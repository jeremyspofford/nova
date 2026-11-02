# nova-service

Repository-owned chart for `buildK3sValues` from `src/core/index.ts`. The builder validates all
service definitions, requires digest-pinned images and emits only the closed JSON shape described
by `values.schema.json`. Programs and their commands remain native; no commands, arbitrary
manifests, user templates or credential values enter this chart. Defaults are inert: no versions
or pods, and a stable Service whose selector matches nothing. The driver supplies JSON values.

Each retained version has one Deployment and preview ClusterIP Service. The stable ClusterIP
Service selects exactly the explicitly live version; `live: null` uses a domain-separated token
that no version receives. Kept versions and `alongside: none` candidates have zero desired
replicas. Soak seconds are descriptive metadata; the driver owns expiration and removal.
Version port lists must agree so the public contract stays stable.

Names are domain-separated SHA256 tokens retaining 160 bits: hash the UTF-8 JSON array
`[kind, service, version]`, using compact JSON, and prefix the first 40 lowercase hex digits with
`kind-`. Service/selector tokens omit version; PVC uses `["pvc", service, volume]`; secret refs use
`["secret", service, reference]`; the no-live token uses `["unselected", service]`. Display
identities appear only as escaped annotation strings or JSON values. Device IDs that are valid,
nonempty Kubernetes label values remain unchanged unless they match the reserved
`device-[0-9a-f]{40}` token namespace; otherwise use `["device", id]` with the same
hash rule. Node provisioning must use this identical label mapping. Nothing provisions nodes here.

Scheduling always requires `kubernetes.io/os=linux` and `nova/role-<role>=true` for every requested
role (default `general-server`). Pinned `hub` resolves to context `hubId` and requires
`nova/device=<device-token>`. Hardware minimums become required integer label comparisons:
`nova/gpu-vram-gb`, `nova/memory-gb`, `nova/disk-gb` use `Gt ceil(minimum)-1`. Nodes must report
conservative whole-GiB capacity labels; absent labels cannot satisfy positive minimums. Zero
minimums impose no extra constraint. Floating placement uses the requested replicas, topology
spread and required per-version pod anti-affinity, one instance per node. An optional successful
resolver result adds a required allowed-device boundary. Preferred placement requires such a
result selecting exactly one device; that device is both required and preferred in node affinity.
The existing resolver owns ranking, health and delayed failover; the chart invents none of them.
Memory MB maps to equal memory requests/limits in MiB. No CPU requirement is invented.

State support is deliberately narrow: pinned placement and `alongside: none`, one aggregate desired
writer per claim, matching retained claim size/device, and Deployment strategy `Recreate`.
The logical volume maps to one service/volume-named local-path PVC (`ReadWriteOnce`, default 1Gi
when the definition omits a size), mounted at `/var/lib/nova/state`. RWO is node-level access,
not a writer lock. The driver must observe previous writer pods stopped before it starts another
version; replica counts and `Recreate` across separate Deployments do not prove exclusion.
Traffic changes and other versions do not appear in immutable Pod templates. PVCs are marked
`helm.sh/resource-policy: keep`: uninstall/soak must not silently delete state. Cleanup requires
separate ownership. No storage copy, snapshot, transfer, provisioning success or readiness is
promised. A workload must already support the documented mount path.

Secrets are references only. The driver/broker must provision the generated names in the target
namespace; this chart creates no Secret. Existing secrets are mounted read-only under
`/var/run/nova/secrets/<generated-secret-name>`. No environment variable name or secret key is
guessed. The workload must already support this file contract. Credentialed execution remains
fail-closed until the broker/launcher foundation is available; this chart supplies no fallback.

`egress: none` emits an empty egress NetworkPolicy; `internet` permits all egress. Enforcement
requires a supporting cluster network plugin and is unproven here. Applying these network-changing
artifacts requires the existing M10d tier 3/dead-man authority; the later driver must gate it.
No application, cluster registration, installation or network mutation is performed by this task.

The builder refuses copy/shadow semantics, local-egress ambiguity, OS permissions, native-only
artifacts, unresolved/failed preferred placement, floating state, stateful alongside execution,
inconsistent claims, unknown nested fields and invalid contexts. Stateless full/none is supported.
All pods disable service-account token mounts, require non-root execution and RuntimeDefault
seccomp, and drop capabilities with privilege escalation disabled. Images must support these
restrictions. No host namespaces, host paths, cluster RBAC or privileged containers are rendered.

The release namespace must equal the validated values namespace. No Namespace or cluster-wide
resources are created. Helm itself and Kubernetes have not been invoked or installed for this
checkpoint. Node tests pin literal values/schema/artifact shapes and malformed cases; Task 2 adds
the meaningful fake-Helm process gate. Real Helm rendering, API validation, scheduling, networking,
PVC provisioning, process health and a real-cluster gate remain unproven.
