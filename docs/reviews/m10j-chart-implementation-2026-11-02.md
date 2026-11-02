# M10j Task 1 report

Status: implemented, focused verification clean, ready for independent task review. No process runner,
cluster API, broker fallback, workload execution, real/fake Helm CLI gate, network mutation or preview action.

Base: `5392d52b1697e4b37cdb501cf183b2253906792d`, branch `codex/m10j-k3s`.
Scope: builder, repository chart/schema, focused tests, services barrel export. The existing
`src/core/index.ts` services star-export already exposes all new public exports; no edit needed.
Controller owns the plan/records; this report remains a local ignored handoff record.

## Exact public contract

Consume only `src/core/index.ts`. `Resolution` below is the existing placement resolver union,
publicly exported as `PlacementResolution`; `PlacementMode` and `Port` are the existing definition types.

`buildK3sValues(definitions: readonly ServiceDefinition[], context: K3sChartContext): K3sChartValues`

Throws sanitized `Error` on malformed input/unrenderable required semantics; returns fresh plain JSON.
No timestamp, randomness, IO, credential value, native program/command or contract-test payload enters output.
Input definition order is retained. Context records use only own keys, including prototype-named versions.

```ts
export interface K3sChartContext {
  namespace: string;
  hubId: string;
  live: string | null;
  kept: readonly string[];
  replicas?: Readonly<Record<string, number>>;
  placements?: Readonly<Record<string, Resolution>>;
}
export interface K3sSelector { 'nova/service': string; 'nova/version': string }
export interface K3sNodeExpression { key: string; operator: 'Gt' | 'In'; values: string[] }
export interface K3sVersionValues {
  identity: string;
  name: string;
  previewName: string;
  networkPolicyName: string;
  selector: K3sSelector;
  replicas: number;
  image: { repository: string; digest: string };
  ports: Port[];
  probe: { httpGet: { path: string; port: string; scheme: 'HTTP' }; periodSeconds: number };
  placement: { mode: PlacementMode; device: string | null; roles: string[]; needs: Record<string, number>; failover: string | null; allowedDevices: string[] };
  nodeSelector: Record<string, string>;
  requiredNodeExpressions: K3sNodeExpression[];
  preferredNodeExpressions: K3sNodeExpression[];
  spread: boolean;
  resources: { requests: { memory?: string }; limits: { memory?: string } };
  state: { claimName: string; volume: string; sizeGi: number; mountPath: '/var/lib/nova/state' } | null;
  secretRefs: { reference: string; name: string }[];
  alongside: 'full' | 'none';
  egress: 'none' | 'internet';
  soakSeconds: number | null;
}
export interface K3sChartValues {
  namespace: string;
  service: { identity: string; name: string; selector: string; ports: Port[] };
  live: string | null;
  stableSelector: K3sSelector;
  versions: K3sVersionValues[];
}

```

Exact serialized schema: `charts/nova-service/values.schema.json` (draft-07, closed objects throughout,
local-only `$ref`; schema SHA256 `083a90163c551bf5410710b53da1bf718060df4218a6b9c14856d9f7c5d91d37`). The schema is the authoritative field/range/enum
artifact, pinned by tests. It permits an empty versions list only for inert repository defaults;
the builder requires at least one validated definition. TypeScript strings/numbers are narrowed by
runtime checks/schema. Do not accept arbitrary caller-supplied values in a future driver: always call the builder.

## Literal values snapshot

Pinned in `tests/core/k3s-chart.test.ts` for one definition containing both pinned image and native program.
The same definition has a literal native supervisor plan snapshot there; no program is launched.

```json
{
  "namespace": "nova-services",
  "service": {
    "identity": "inference",
    "name": "service-11fb499f16d38045efc6b601d6bfea77ffbd584c",
    "selector": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
    "ports": [
      {
        "name": "api",
        "port": 11434
      }
    ]
  },
  "live": null,
  "stableSelector": {
    "nova/service": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
    "nova/version": "unselected-f31542a884ee7b8b7d1c728ae9c82f8952b7d94d"
  },
  "versions": [
    {
      "identity": "1.4.2",
      "name": "deployment-dd330cc4d8b63dbdbd236b95606c27779999a6ba",
      "previewName": "preview-8c280df3ddbe85755210f65e314093532e2b306c",
      "networkPolicyName": "network-6f133be8f2240420c4cb512c96a76e713014014c",
      "selector": {
        "nova/service": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
        "nova/version": "version-5e5b18e3b3d6153fa86ba4dfdd722b766b8d58ca"
      },
      "replicas": 1,
      "image": {
        "repository": "registry.example/runtime",
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "ports": [
        {
          "name": "api",
          "port": 11434
        }
      ],
      "probe": {
        "httpGet": {
          "path": "/api/version",
          "port": "api",
          "scheme": "HTTP"
        },
        "periodSeconds": 30
      },
      "placement": {
        "mode": "pinned",
        "device": "hub-one",
        "roles": [
          "compute"
        ],
        "needs": {
          "gpu_vram_gb": 8
        },
        "failover": null,
        "allowedDevices": []
      },
      "nodeSelector": {
        "kubernetes.io/os": "linux",
        "nova/role-compute": "true",
        "nova/device": "hub-one"
      },
      "requiredNodeExpressions": [
        {
          "key": "nova/gpu-vram-gb",
          "operator": "Gt",
          "values": [
            "7"
          ]
        }
      ],
      "preferredNodeExpressions": [],
      "spread": false,
      "resources": {
        "requests": {
          "memory": "4096Mi"
        },
        "limits": {
          "memory": "4096Mi"
        }
      },
      "state": null,
      "secretRefs": [],
      "alongside": "full",
      "egress": "none",
      "soakSeconds": 86400
    }
  ]
}
```

## Meaning and handoff constraints

- Stable Service: `stableSelector` explicitly names live's generated token; null live uses an unreachable
  domain-separated token. Kept and alongside-none candidate counts are zero. Overrides cannot start them.
- One Deployment and preview ClusterIP Service per version; one per-version NetworkPolicy; stable public
  port lists must agree. Per-kind service/deployment/preview/network/pvc/secret/selector/version tokens
  retain 160 SHA256 bits. Device label-safe IDs stay literal except reserved `device-[0-9a-f]{40}`
  IDs, which are also hashed to prevent aliases. Node provisioning must follow the documented mapping.
- Linux and all roles (default general-server) are required. Hardware minimums become integer label
  Gt ceil(minimum)-1 constraints; positive requirements require labels. Floating uses spread plus
  hard per-version anti-affinity. Preferred requires explicit successful resolver output selecting one
  actual device; it adds required allowed-device and preferred-node rules. Resolver/driver owns ranking,
  Linux eligibility, health windows and failover. Values do not prove observed readiness.
- State supports pinned/alongside-none only. Shared claim size/device must agree and aggregate desired
  writers cannot exceed one. PVC is local-path/RWO, default 1Gi if size omitted, retained on uninstall;
  stateful Deployment is Recreate. RWO is not a writer lock. Task 2 must observe old writer pods stopped
  before starting another Deployment. Stable selection and other-version changes do not rewrite Pod
  templates. Copy/shadow and state transfer are explicitly refused, not simulated as successes.
- State mount: `/var/lib/nova/state`; existing secret references mount read-only at
  `/var/run/nova/secrets/<generated-name>`. Workloads must support these file contracts. No secret
  keys/environment variables are guessed, no Secret is created, no credential values enter core/chart.
  Broker/launcher is absent; credentialed production paths remain fail-closed and #275 remains parked.
- Egress none/internet policies are declarative artifacts only. Applying them changes networking and
  must require existing M10d tier 3/dead-man authority in the later driver. The supporting network plugin,
  actual enforcement and any network mutation are unproven/unauthorized here.
- Narrow refusals: native-only artifact, copy/shadow, local-egress ambiguity, any OS permission,
  unresolved/failed preferred result, unsupported failover, floating state, stateful alongside execution,
  port-contract drift, invalid/inconsistent retained context, unrenderable repository/port names,
  unknown nested semantics, nonfinite hardware needs. No manual installation or cluster/cloud operation.
- Namespace guard requires Release.Namespace exactly equal validated values namespace. No Namespace,
  hostPath, host namespaces, cluster RBAC, privileged pod or user template evaluation.

## RED / GREEN evidence

All Node commands used
`PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH`.

Initial RED (before production edits):

`sh scripts/test.sh tests/core/k3s-chart.test.ts`

`tests 1; pass 0; fail 1`: actual missing exported builder assertion,
`actual 'undefined', expected 'function'`; no harness syntax failure; tripwire never fired.
Expanded literal behavior tests then failed the same missing builder (6 failed/1 passed).
Additional real behavioral REDs covered absent preferred-resolution support, namespace primitive
acceptance, hostile device token aliasing, and malformed resolver entries; each was corrected.

Final commands/output:

`sh scripts/test.sh tests/core/k3s-chart.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts`

`tests 35; pass 35; fail 0; skipped 0`; tripwire armed and never fired.

`sh scripts/test.sh --test-name-pattern='module boundary' tests/core/api.test.ts`

Actual repository module-boundary test: `tests 1; pass 1; fail 0; skipped 0`; tripwire never fired.

`npm run typecheck`: `tsc -p tsconfig.json`, exit 0.

`git diff --check` and `git diff --cached --check`: exit 0.

Task-specific tests count: 17. Full host suite intentionally not repeated under task constraints.
Schema conformance uses a transparent test-only evaluator for exactly the schema vocabulary used;
artifact checks inspect repository template structure. Neither is a real/fake Helm process gate.
Task 2 must add its committed fake-Helm schema/lint process gate. Real Helm rendering, API validation,
scheduling, PVC permissions/provisioning, network enforcement and cluster readiness are unproven.
No runtime dependencies were added. Intermediate typecheck errors were corrected; no unresolved check failure.

## Source pins

- Binding section only: `docs/plans/M10-orchestration.md`, The service definition/chart-values,
  git blob `4871b4d2a493db685de12917e790366bbc12f0ac`.
- Validator: `src/core/services/definition.ts`, blob `5f47977342a91d6fa43adab053e692c2b7707df4`.
- Placement: `src/core/services/placement.ts`, blob `03fa521ef0316a5e279567643b4667ce11395878`.
- Native plan: `src/supervisor/services.ts`, blob `f5f9a5157fa3622378f56204899e62ffb40f54c4`.
- Public barrel: `src/core/index.ts`, blob `8e70cb652c3d7c2e29077f3dd7ef6e2b4ef8da33`.
- Controller's Task1 brief and constraints read first; preferred-resolution and RWO boundaries reread
  after controller clarification. No entire-plan or owner-data/keychain read was needed.

Task1 implementation commit: `f31ccb0a986f7df8e17fbd660baff62ef8994250`.
Commit contains only the 10 assigned source/export/chart/test files; controller plan remains uncommitted.


# Task1 fix round 1 — I1 / I2 / accepted M1

Fix base: `f31ccb0a986f7df8e17fbd660baff62ef8994250`. Status: implemented with fresh RED/GREEN
logs, ready for the original reviewer's scoped patch check. This appendix supersedes the earlier
contract/schema/snapshot where it adds strategy and singleton-overlap limits; earlier evidence
remains historical rather than being rewritten as a newly captured run.

## Historical stdout disclosure

Original pre-review stdout was displayed through tool results but was not saved to a workspace log.
There are no recoverable original raw-log paths supplied here. The initial implementation's
missing-builder RED and 35+1 GREEN/typecheck results above remain report-only evidence.
No historical revision was restored or rerun to fabricate those logs. All logs below were captured
fresh in the current fix workspace, and include the exact argv-equivalent command, combined stdout/
stderr and exit status. They cover the amended current source and regression wave only.

## Findings resolved

**I1.** The K3s builder's positive port pattern is now `^[a-z]([a-z0-9]|-[a-z0-9])*$` with an explicit
15-character maximum. The shared schema port definition (used for service/container lists) and
HTTP probe port use the same pattern plus `maxLength: 15`. No lookahead is required; the expression
uses ordinary capturing groups/repetition compatible with Go-style schema regex engines. This
preserves the first-letter/end-alphanumeric requirements and rejects adjacent hyphens. Generic
`ServiceDefinition` validation and native behavior remain unchanged: the regression verifies the
shared validator still accepts the synthetic `api--http` definition while the K3s builder refuses it.
Independent schema mutations test service-list, container-list and probe-port positions separately.

**I2.** `K3sVersionValues` now requires `strategy: { type: 'Recreate' | 'RollingUpdate' }`, and the
closed schema requires that same object/enum. The template consumes `.strategy | toJson`
unconditionally instead of hiding Recreate behind `.state`. The builder emits Recreate for every
`alongside: none` or stateful workload, including live stateless preferred workloads whose resolved
device changes Pod inputs; stateless full explicitly emits RollingUpdate. The literal snapshot was
updated for full's explicit strategy. A focused regression uses two different successful preferred
results with the same Deployment identity, asserts changed placement input, null state, one live
replica, and Recreate in both returned versions, then checks actual template consumption.

The controller's singleton clarification is included: whenever any `alongside: none` version has
positive desired replicas, the aggregate desired count across every retained version must be <=1.
The builder rejects floating none replicas=2, explicit override=2, and a live none with an active full
candidate. It does not silently clamp requested counts. Positive controls retain a zero-replica
candidate and a stopped previous none after promotion. This complements the existing claim-writer
check rather than treating RWO as a lock.

**M1.** The test-only schema evaluator now walks an explicit supported keyword vocabulary before
it evaluates data. Unknown semantic keywords throw (regression uses `not`); properties/definitions
map keys remain arbitrary data names, and their schema values are visited as schema nodes. The
positive regression deliberately uses property `not` and definition `if`, local references, and the
understood inert string annotations `$schema`, `title`, `description`, `$comment`. There is no
remote reference fetch. Boolean additionalProperties is the supported form; unsupported schema
forms are not silently advertised as a full draft-07 implementation. Evaluation recursion is separate
from the vocabulary walk so roots are not repeatedly rechecked for each datum.

Changed production/schema/docs files: `src/core/services/k3s/values.ts`,
`charts/nova-service/templates/workloads.yaml`, `charts/nova-service/values.schema.json`,
`charts/nova-service/README.md`. Test changes stay in `tests/core/k3s-chart.test.ts`.
No barrel change is necessary; the original public core exports expose the amended type.

## Current exact public contract

`buildK3sValues(definitions: readonly ServiceDefinition[], context: K3sChartContext): K3sChartValues`

`Resolution` remains the existing public `PlacementResolution`; context is unchanged.

```ts
export interface K3sChartContext {
  namespace: string;
  hubId: string;
  live: string | null;
  kept: readonly string[];
  replicas?: Readonly<Record<string, number>>;
  placements?: Readonly<Record<string, Resolution>>;
}
export interface K3sSelector { 'nova/service': string; 'nova/version': string }
export interface K3sNodeExpression { key: string; operator: 'Gt' | 'In'; values: string[] }
export interface K3sVersionValues {
  identity: string;
  name: string;
  previewName: string;
  networkPolicyName: string;
  selector: K3sSelector;
  replicas: number;
  strategy: { type: 'Recreate' | 'RollingUpdate' };
  image: { repository: string; digest: string };
  ports: Port[];
  probe: { httpGet: { path: string; port: string; scheme: 'HTTP' }; periodSeconds: number };
  placement: { mode: PlacementMode; device: string | null; roles: string[]; needs: Record<string, number>; failover: string | null; allowedDevices: string[] };
  nodeSelector: Record<string, string>;
  requiredNodeExpressions: K3sNodeExpression[];
  preferredNodeExpressions: K3sNodeExpression[];
  spread: boolean;
  resources: { requests: { memory?: string }; limits: { memory?: string } };
  state: { claimName: string; volume: string; sizeGi: number; mountPath: '/var/lib/nova/state' } | null;
  secretRefs: { reference: string; name: string }[];
  alongside: 'full' | 'none';
  egress: 'none' | 'internet';
  soakSeconds: number | null;
}
export interface K3sChartValues {
  namespace: string;
  service: { identity: string; name: string; selector: string; ports: Port[] };
  live: string | null;
  stableSelector: K3sSelector;
  versions: K3sVersionValues[];
}

```

Current exact schema: `charts/nova-service/values.schema.json`;
SHA256 `729fae00f61f823f5b5a7191668d97843609804aefb4205f8eb8e6424565e67a`.
All prior field/range mappings remain, plus required version strategy and stricter named ports.

Current literal JSON snapshot (same dual-artifact definition/native-plan test):

```json
{
  "namespace": "nova-services",
  "service": {
    "identity": "inference",
    "name": "service-11fb499f16d38045efc6b601d6bfea77ffbd584c",
    "selector": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
    "ports": [
      {
        "name": "api",
        "port": 11434
      }
    ]
  },
  "live": null,
  "stableSelector": {
    "nova/service": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
    "nova/version": "unselected-f31542a884ee7b8b7d1c728ae9c82f8952b7d94d"
  },
  "versions": [
    {
      "identity": "1.4.2",
      "name": "deployment-dd330cc4d8b63dbdbd236b95606c27779999a6ba",
      "previewName": "preview-8c280df3ddbe85755210f65e314093532e2b306c",
      "networkPolicyName": "network-6f133be8f2240420c4cb512c96a76e713014014c",
      "selector": {
        "nova/service": "selector-2d571c62ef00c5813578d5dd8b5e52396719ade6",
        "nova/version": "version-5e5b18e3b3d6153fa86ba4dfdd722b766b8d58ca"
      },
      "replicas": 1,
      "strategy": {
        "type": "RollingUpdate"
      },
      "image": {
        "repository": "registry.example/runtime",
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "ports": [
        {
          "name": "api",
          "port": 11434
        }
      ],
      "probe": {
        "httpGet": {
          "path": "/api/version",
          "port": "api",
          "scheme": "HTTP"
        },
        "periodSeconds": 30
      },
      "placement": {
        "mode": "pinned",
        "device": "hub-one",
        "roles": [
          "compute"
        ],
        "needs": {
          "gpu_vram_gb": 8
        },
        "failover": null,
        "allowedDevices": []
      },
      "nodeSelector": {
        "kubernetes.io/os": "linux",
        "nova/role-compute": "true",
        "nova/device": "hub-one"
      },
      "requiredNodeExpressions": [
        {
          "key": "nova/gpu-vram-gb",
          "operator": "Gt",
          "values": [
            "7"
          ]
        }
      ],
      "preferredNodeExpressions": [],
      "spread": false,
      "resources": {
        "requests": {
          "memory": "4096Mi"
        },
        "limits": {
          "memory": "4096Mi"
        }
      },
      "state": null,
      "secretRefs": [],
      "alongside": "full",
      "egress": "none",
      "soakSeconds": 86400
    }
  ]
}
```

## Fresh commands, actual output and raw log paths

Each test/tool command used the existing Node 26 path prepended:
`PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH`.
Flags precede file paths. Full raw outputs are in these absolute local paths:

1. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-red.log`
   Command: `sh scripts/test.sh tests/core/k3s-chart.test.ts`.
   First new-wave RED: `tests 24; pass 18; fail 6; skipped 0`, exit 1, real assertion failures.
2. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-red-confirmed.log`
   Command: `sh scripts/test.sh --test-name-pattern=fix1 tests/core/k3s-chart.test.ts`.
   RED after separating every schema location: `tests 8; pass 1; fail 7; skipped 0`, exit 1.
   Actual failures: missing K3s port refusal; service/container/probe schema acceptance `true !== false`;
   absent strategy `undefined !== {type: Recreate}`; accepted none overlap; ignored schema `not`.
   No production/schema/template/evaluator logic had been changed before either RED capture.
3. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-green-focused.log`
   Command: `sh scripts/test.sh tests/core/k3s-chart.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts`.
   Output: `tests 43; pass 43; fail 0; skipped 0`, exit 0 (25 chart, 10 definition, 8 placement).
4. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-green-boundary.log`
   Command: `sh scripts/test.sh '--test-name-pattern=module boundary' tests/core/api.test.ts`.
   Actual repository module-boundary test: `tests 1; pass 1; fail 0; skipped 0`, exit 0.
5. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-green-typecheck.log`
   Command: `npm run typecheck`; output `tsc -p tsconfig.json`, exit 0.
6. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-green-diff.log`
   Command: `git diff --check`; no diagnostics, exit 0.
7. `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build/.superpowers/sdd/M10j/task-1-fix1-green-staged-diff.log`
   Command: `git diff --cached --check`; captured immediately before the scoped fix commit.

Every fresh Node test run reports the unchanged Kubernetes tripwire armed and never fired.
No full host suite, real/fake Helm process, Kubernetes/Flux call, installation, credential access,
workload launch, cluster operation, network mutation, push, merge or preview action occurred.

## Limits after this patch

The previous stateless-none surging strategy and >1 desired-instance cases are now refused/prevented
in desired configuration. This is still not runtime singleton exclusion: the driver must observe
**all old instances stopped**, including stateless none, before it starts a replacement. Recreate,
desired counts, RWO, separate Deployments, deletion/restart and reconciliation do not prove that stop.

The schema vocabulary guard makes the local test evaluator honest about unsupported keywords; it
still does not validate the complete JSON Schema specification or prove a Helm process/API gate.
Task2's meaningful committed fake-Helm schema/lint process gate remains pending. Real Helm rendering,
Kubernetes API acceptance, scheduling/probes, storage permissions/provisioning, network enforcement
and real-cluster readiness remain unproven. Inert NetworkPolicy application still requires M10d
 tier3/dead-man authority; broker production paths remain absent/fail-closed and #275 remains parked.
The shared validator/resolver/native plan/public-barrel/ADR source pins from the original report are
unchanged. Controller-owned `docs/plans/M10j.md` remains unstaged and excluded from this patch.

Consolidated fix1 commit: `683f54d762866a6d7700484c1d45a271a85cc8e7`.
Only the five assigned files listed above were committed; root plan remains uncommitted/unstaged.
Staged diff log confirms exit 0. Ready for the original reviewer's scoped fix check.
