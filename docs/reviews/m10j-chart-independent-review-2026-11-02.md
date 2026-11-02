# M10j Task 1 independent review

Reviewed: 2026-11-02. Base `5392d52b1697e4b37cdb501cf183b2253906792d` to HEAD `f31ccb0a986f7df8e17fbd660baff62ef8994250`, branch `codex/m10j-k3s`.

**Spec: issues. Code quality: needs fixes.** Two Important findings below; no Critical findings. The authorized narrow chart checkpoint is otherwise substantially implemented. This is not approval of a Helm/process/API/credential or real-cluster gate.

Read the task brief, constraints and report first, then the supplied 67,277-byte package once in bounded chunks (all 1,388 lines). Consulted only the binding ADR service-definition/chart mapping and relevant current validator/resolver/harness/boundary code. Verified branch/HEAD, report source blobs and schema hash. Did not recompute diffs, edit source/index, change HEAD/branch, run broad suites, invoke Helm/Kubernetes/Flux, access credentials or touch prior M10i implementation. Only this review file was written.

## Findings

### I1 — Reject consecutive hyphens in named ports

**Important, required fix.** `src/core/services/k3s/values.ts:47` and `:94`; corresponding schema `charts/nova-service/values.schema.json:95`.

The accepted definition port `api--http` passes the shared validator, builder PORT expression, and schema port expression. It is copied into the container port name and HTTP probe port. Kubernetes applies `IsValidPortName` to both fields, which forbids adjacent hyphens; this produces a chart value advertised as renderable whose Deployment is rejected. Verified the accepted builder output and schema pattern with the focused pure probe below. The [Kubernetes core validator](https://raw.githubusercontent.com/kubernetes/kubernetes/v1.34.0/pkg/apis/core/validation/validation.go) calls this check for container names and probe ports; the [port-name validator](https://raw.githubusercontent.com/kubernetes/apimachinery/master/pkg/util/validation/validation.go) explicitly rejects `--`.

Reject this case in the builder and both schema port-name locations (port definition and probe port), and add a regression for `api--http`. Keeping the current narrower requirement that names start with a letter is fine. This is an actual validation defect, not a request to run real API validation now.

### I2 — Stateless alongside-none deployments still use a surging rollout

**Important, required fix.** `charts/nova-service/templates/workloads.yaml:55`–`:58`; accepted stateless path and changing placement inputs at `src/core/services/k3s/values.ts:104`, `:109`–`:114`, `:125`–`:137`.

`Recreate` is conditional on `.state` only. A stateless service with `alongside: none`, preferred placement, one live replica, and a successful resolver result is accepted. Changing its resolved device changes both the required affinity and Pod placement annotation under the same Deployment identity. The default RollingUpdate strategy can start a second pod before the first stops, contrary to the supported `none` meaning. The focused probe confirms this accepted path and changing Pod input; [Kubernetes Deployment documentation](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy) specifies default RollingUpdate and a default 25% surge rounded up (one extra pod for a desired count of one).

Render Recreate for `alongside: none` as well as stateful workloads, or explicitly refuse this combination at this checkpoint. Add a stateless-none strategy regression. This does not remove the later driver's responsibility to observe shutdown or provide a runtime singleton guarantee: Recreate only governs Deployment upgrades, and separate Deployments, deletions, failures and reconciliation still need driver handling. The finding concerns the chart actively permitting a normal surge, not those deferred runtime guarantees.

### M1 — Make the test schema vocabulary explicit

**Minor, nonblocking.** `tests/core/k3s-chart.test.ts:142`–`:169`.

The evaluator meaningfully implements the vocabulary currently used and the tests exercise malformed nested values. It silently ignores unknown future keywords, however. A small schema-walk assertion against its supported keyword set would prevent a later schema constraint being added without actually being enforced by these tests. This is a maintenance suggestion, not a claim that the current evaluator is a Helm gate or currently ignores a used constraint.

## Spec and safety assessment

- Public builder/context/value exports exist; the existing `src/core/index.ts:159` services star export supplies the intended public boundary. Inputs receive shared validation plus chart-specific refusals. Own-key context lookups handle prototype-named versions.
- Literal values and literal native supervisor plan use the same image-plus-program definition. Program execution, argv, contract-test payloads and credential values are absent from chart values. The test calls the native driver's plan only, using a disposable directory; it does not launch that program.
- Service/version/resource identity tokens are domain separated and retain 160 SHA256 bits. The hostile device mapping reserves its generated-token namespace to prevent literal/generated aliases. Resource names, annotations and nested strings are JSON-escaped; no input `tpl`, lookup, arbitrary manifest or remote schema reference is introduced.
- Stable selection requires explicit live; null live has a disjoint selector domain. Kept and alongside-none candidates stay at zero, positive overrides refuse, and missing/duplicate/mixed retained definitions refuse. Public ports agree across versions. One Deployment and preview Service per version plus the stable Service are present in templates.
- Preferred placement consumes an explicit successful resolver output, with one selected device used as the required allowed-device boundary and preferred affinity. Its real-resolver test is present. Linux and role constraints are required; hardware thresholds and memory request/limit mapping are explicit. This pure builder does not authenticate resolver provenance or prove actual node eligibility/health; it correctly avoids inventing ranking or timed failover.
- Every resource template sets the validated namespace. The workload template fails when Release.Namespace differs; a normal whole-chart render therefore fails closed. No Namespace, cluster RBAC, privileged container, host namespace/path or service-account token mount is introduced.
- Supported state is pinned/alongside-none, local-path/RWO, retained PVC, fixed mount path, matching claim device/size, at most one aggregate desired writer, and Recreate. Pod template input is independent of live/kept/other-version selection. These are desired-state limits, not runtime writer exclusion.
- Copy/shadow, local egress ambiguity, unsupported OS permissions and other documented unrenderable semantics are explicitly refused, which is permitted by the clarified checkpoint. The chart creates no Secret and introduces no credential production path, launcher or legacy fallback.
- NetworkPolicy artifacts implement the stated none/internet cases. README/report explicitly require the later M10d tier 3/dead-man authority before applying network changes. There is no apply side effect in this package.
- Closed draft-07 schema, inert defaults, literal values, nested malformed cases and template shape assertions are useful Task 1 evidence. Findings I1/I2 are not covered by the existing assertions and must be fixed before approval.

## Verification and evidence limits

The named report commands match the code they purport to cover:

| Reported command | Source check and reported result |
| --- | --- |
| `sh scripts/test.sh tests/core/k3s-chart.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts` | 17 chart + 10 definition + 8 placement tests = 35; reported 35 pass, 0 fail, 0 skipped. Harness uses the existing tripwire. |
| `sh scripts/test.sh --test-name-pattern='module boundary' tests/core/api.test.ts` | Actual test at `tests/core/api.test.ts:262` walks source imports; reported 1 pass. |
| `npm run typecheck` | `package.json:20` resolves to `tsc -p tsconfig.json`; reported exit 0. |
| `git diff --check` / `git diff --cached --check` | Reported exit 0; not recomputed during this review. |
| Initial chart RED | Report says missing export assertion failed with undefined versus function before implementation; final source contains that exact export assertion. Historical RED is report evidence, not independently recreated. |

Original suite stdout was not saved in the supplied package. Thus these are source-correlated worker-reported results, not independent reruns or recovered historical logs. The controller requested existing excerpts; none had been appended to the report when this review was written. This evidence limit is explicit and is not itself an implementation finding.

One focused probe was run to resolve I1/I2, using Node 26.3.1 under the unchanged tripwire: `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/tripwire.sh node --input-type=module` with a stdin module. It imported the public builder, constructed a synthetic stateless-none preferred definition with port `api--http`, built live values with node-a and node-b resolver results, read the schema and workload template, and emitted only boolean/count diagnostics. Exit 0:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"consecutiveHyphenPortAccepted":true,"schemaPortPatternAccepts":true,"statelessNone":true,"replicaCount":1,"placementPodInputChanges":true,"recreateOnlyWhenState":true}
no-Kubernetes tripwire: never fired
```

This verifies builder acceptance/template conditions; the Kubernetes consequences are static inferences from the official validation and rollout definitions cited above. No actual pod behavior is claimed.

All five reported source blobs matched `git hash-object`: definition `5f47977342a91d6fa43adab053e692c2b7707df4`, placement `03fa521ef0316a5e279567643b4667ce11395878`, native plan `f5f9a5157fa3622378f56204899e62ffb40f54c4`, public barrel `8e70cb652c3d7c2e29077f3dd7ef6e2b4ef8da33`, binding ADR `4871b4d2a493db685de12917e790366bbc12f0ac`. Schema SHA256 matches report: `083a90163c551bf5410710b53da1bf718060df4218a6b9c14856d9f7c5d91d37`. The only tracked worktree modification seen was the controller-owned `docs/plans/M10j.md`; it was not read or changed for this review.

## Declined-to-judge behaviors for controller ruling

1. **Task 2 fake-Helm schema/lint process gate:** explicitly deferred by the clarified brief; no process implementation exists in this package. Current shape checks must not be presented as completion of that gate.
2. **Real Helm rendering/lint, Kubernetes API acceptance beyond identified static defect, actual scheduling/probes/resource enforcement, PVC provisioning/permissions, and network enforcement:** forbidden real-tool/real-resource scope and no runtime evidence. These remain unproven even after the two fixes.
3. **Actual old-writer shutdown, singleton exclusion across versions, crash/deletion behavior, storage copying/transfer and readiness:** chart desired counts/Recreate cannot establish these facts. Later driver capability and observations must prove them; copy/shadow are currently explicit refusals.
4. **Resolver authenticity, current trust/roles/hardware/health, failover timing, stale/out-of-order observations, measured health versus readiness and control-plane-loss behavior:** builder takes resolved context and renders constraints; driver/observation work is absent. No M10i re-review or invented serving status.
5. **Serialized expected-state binding, approval replay, cancellation/restart/unknown-completion reconciliation, retries and source/cluster ownership:** no driver transaction/process layer in Task 1. Defer to later driver tasks.
6. **Credential broker/launcher production use, ambient config/plugin/proxy isolation, wrong-cluster prevention, registration/joins and deploy keys:** production paths are absent here, not proven operational. Broker foundation and #275 remain blocked/parked; no fallback is authorized.
7. **M10d network authority enforcement:** explicit documentation is correct for inert artifacts; enforcing tier 3/dead-man authority belongs to the later driver before any apply. This review authorizes no network change.
8. **Backend switching, GitOps/services.git/Flux ownership, cold-site activation, service-change-kind pipeline, UI/preview and milestone completion:** outside the pure chart scope and unchanged by this package.

Controller recommendation: return I1 and I2 to the worker within Task 1, obtain focused regression evidence, and re-review only the resulting patch. M1 may be addressed opportunistically. Do not mark the later process/schema/credential gates complete.
