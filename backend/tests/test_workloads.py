"""Nova's runtime client — the boundary holds from the backend's side.

    docker compose exec backend python tests/test_workloads.py

Phase 3 of docs/plans/capability-acquisition.md. The namespace and its policy
were proven from a terminal (workloads/README.md); this proves the thing that
actually matters day to day — that the BACKEND, holding the credential,
cannot exceed the boundary either.

The single design decision under test: `workloads.py` authenticates as the
**nova-deployer ServiceAccount**, never with a kubeconfig. If it used admin
credentials, `workloads/rbac.yaml` would be decorative and every guarantee
would rest on this module being bug-free. It does not, so the API server
refuses on its own account.

Skips cleanly when no cluster is configured — the credential's presence is the
switch, and a stack without a runtime is a supported state, not a failure.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


COMPLIANT = """
apiVersion: v1
kind: Pod
metadata: {name: test-compliant}
spec:
  securityContext: {runAsNonRoot: true, runAsUser: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: c
      image: curlimages/curl:8.11.1
      command: ["sleep", "60"]
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}
"""

PRIVILEGED = """
apiVersion: v1
kind: Pod
metadata: {name: test-privileged}
spec:
  containers:
    - name: c
      image: busybox:1.36
      securityContext: {privileged: true}
"""

OTHER_NAMESPACE = """
apiVersion: v1
kind: ConfigMap
metadata: {name: test-escape, namespace: kube-system}
data: {k: v}
"""

FORBIDDEN_KIND = """
apiVersion: v1
kind: Namespace
metadata: {name: test-second-namespace}
"""


async def identity_checks() -> None:
    """A manifest cannot choose the identity its pods run as.

    Deliberately FIRST, and deliberately needing neither a database nor a
    cluster: this is the half that must run everywhere, because the control
    it defends is the only one of its kind. Pod Security does not look at
    ServiceAccount selection at any level, so nothing upstream catches this
    if the code below stops working.

    Measured 2026-07-31, before the fix, against the live k3d cluster: a Pod
    naming `serviceAccountName: nova-deployer` was CREATED (HTTP 201),
    reached Running, and mounted a valid 1204-byte token for that account —
    which is the credential this backend itself holds.
    """
    import yaml
    from app import workloads

    def doc(kind: str, spec: dict) -> str:
        return yaml.dump({"apiVersion": "v1", "kind": kind,
                          "metadata": {"name": "t"}, "spec": spec})

    print("0. a manifest cannot choose the identity its pods run as")

    # Derived from KINDS, not from a list of the kinds that happen to carry a
    # pod today. A kind added to that map is covered the moment it is added;
    # a kind that quietly stopped being covered fails here instead of in
    # production.
    for kind in workloads.KINDS:
        r = await workloads.apply(doc(kind, {"serviceAccountName": "nova-deployer"}))
        check(f"{kind}: naming a ServiceAccount is refused",
              r["status"] == "error" and r.get("applied") == 0,
              str(r.get("detail"))[:60])

    # The scan is structural, so DEPTH must be irrelevant. `spec` in a Pod is
    # depth 1, `spec.template.spec` in a Deployment is 3, and a CronJob's
    # `spec.jobTemplate.spec.template.spec` is 5 — enumerating those is the
    # list this avoids being.
    for depth in range(8):
        buried: dict = {"serviceAccountName": "nova-deployer"}
        for i in range(depth):
            buried = {f"level{i}": buried}
        check(f"found when buried {depth} level(s) deep",
              bool(workloads._identity_requests(buried)))

    r = await workloads.apply(doc("Pod", {"serviceAccount": "nova-deployer",
                                          "containers": []}))
    check("the DEPRECATED `serviceAccount` alias is refused too — the API "
          "server still honours it, so leaving it out would be a hole with a "
          "deprecation notice on it", r["status"] == "error")

    r = await workloads.apply(doc("Pod", {"automountServiceAccountToken": True,
                                          "containers": []}))
    check("asking for the token is refused as asking for the identity",
          r["status"] == "error")

    # The pre-pass exists for exactly this: apply() POSTs as it walks, so a
    # refusal found on the second document would otherwise leave the first
    # one running — and the half that landed is the half nothing refused.
    two = (yaml.dump({"apiVersion": "v1", "kind": "ConfigMap",
                      "metadata": {"name": "innocent"}, "data": {"k": "v"}})
           + "---\n"
           + doc("Pod", {"serviceAccountName": "nova-deployer", "containers": []}))
    r = await workloads.apply(two)
    check("one grabbing document refuses the WHOLE submission — nothing is "
          "half-applied", r["status"] == "error" and r.get("applied") == 0)

    # A check that cries wolf is a check that gets deleted.
    clean = yaml.dump({"apiVersion": "apps/v1", "kind": "Deployment",
                       "metadata": {"name": "t"},
                       "spec": {"template": {"spec": {"containers": [
                           {"name": "c", "image": "nginx-unprivileged"}]}}}})
    check("an ordinary manifest is not refused",
          not workloads._identity_requests(yaml.safe_load(clean)))
    carrier = yaml.safe_load(yaml.dump(
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "t"},
         "data": {"chart.yaml": "spec:\n  serviceAccountName: someone\n"}}))
    check("...nor is a ConfigMap that merely CARRIES a manifest as data — "
          "nothing in `data` is submitted as a pod spec",
          not workloads._identity_requests(carrier))

    # The other half: every pod spec goes out with the token switched off.
    # Counted, not spot-checked, so a nesting that the walk fails to reach
    # shows up as a number rather than as silence.
    for kind, spec, want in (
            ("Pod", {"containers": [{"name": "c"}]}, 1),
            ("Deployment", {"template": {"spec": {"containers": [{"name": "c"}]}}}, 1),
            ("CronJob", {"jobTemplate": {"spec": {"template": {"spec": {
                "containers": [{"name": "c"}]}}}}}, 1)):
        parsed = yaml.safe_load(doc(kind, spec))
        touched = workloads._deny_token_mounts(parsed)
        found = []

        def walk(n):
            if isinstance(n, dict):
                if isinstance(n.get("containers"), list):
                    found.append(n.get("automountServiceAccountToken"))
                for v in n.values():
                    walk(v)
            elif isinstance(n, list):
                for i in n:
                    walk(i)
        walk(parsed)
        check(f"{kind}: every pod spec goes out with no token mounted",
              touched == want and found == [False] * want, f"{touched=} {found=}")


async def run() -> None:
    from app import db, settings_store, workloads
    from app.tools import scopes
    from app.tools import registry as tr

    await identity_checks()

    await db.init_pool()
    await settings_store.warm()

    print("\n0b. the enforced set and the described set are ONE set")
    check("registry enforces exactly what propose_goal advertises — they were "
          "two hand-kept lists until they disagreed, and Nova asked for the "
          "wrong verb because the description was the stale copy",
          tr.GOAL_SCOPED_TOOLS is scopes.GOAL_SCOPED_TOOLS)
    check("deploying is goal-scoped", "deploy_workload" in scopes.GOAL_SCOPED_TOOLS)
    check("...and an ACTOR, so a turn holding fetched text cannot deploy",
          tr.is_actor("deploy_workload"))
    check("reading what is running is neither — it changes nothing",
          "list_workloads" not in scopes.GOAL_SCOPED_TOOLS
          and not tr.is_actor("list_workloads"))

    if not workloads.configured():
        print("\n(no runtime configured — skipping the live half. "
              "Create one with workloads/setup.sh)")
        await db.close_pool()
        return

    print("1. it is reachable, as the ServiceAccount")
    h = await workloads.health()
    check("reachable", h.get("reachable"), str(h)[:120])

    print("2. a compliant workload applies")
    r = await workloads.apply(COMPLIANT)
    check("applied", r["status"] == "ok", str(r)[:160])
    # end-to-end, on the object the API server actually stored: the manifest
    # above never mentions a ServiceAccount, and the pod comes back with the
    # token volume absent entirely rather than merely unused.
    _, stored = await workloads._request(
        "GET", workloads._path("v1", "pods", "test-compliant"))
    spec = stored.get("spec") or {}
    check("...running as `default` with no token mounted",
          spec.get("serviceAccountName") == "default"
          and spec.get("automountServiceAccountToken") is False
          and not (spec.get("volumes") or []),
          f"sa={spec.get('serviceAccountName')} "
          f"automount={spec.get('automountServiceAccountToken')} "
          f"volumes={[v.get('name') for v in spec.get('volumes') or []]}")

    print("3. the API server refuses what the policy forbids — not this module")
    r = await workloads.apply(PRIVILEGED)
    obj = (r.get("objects") or [{}])[0]
    check("a privileged pod is refused", obj.get("status") == "refused")
    check("...and the refusal names the control, so she can fix it rather "
          "than guess", "PodSecurity" in str(obj.get("detail")),
          str(obj.get("detail"))[:100])

    print("3b. ...but the identity a pod runs as is OURS to refuse, because "
          "nothing upstream does")
    # dryRun=All runs the full admission chain — Pod Security included — and
    # creates nothing. If this comes back 2xx, the API server was willing to
    # hand a pod this backend's own token, and workloads.apply is the only
    # thing between a manifest and that outcome.
    probe = {"apiVersion": "v1", "kind": "Pod",
             "metadata": {"name": "sa-admission-probe",
                          "namespace": workloads.namespace()},
             "spec": {"serviceAccountName": "nova-deployer",
                      "securityContext": {"runAsNonRoot": True, "runAsUser": 65532,
                                          "seccompProfile": {"type": "RuntimeDefault"}},
                      "containers": [{"name": "c", "image": "curlimages/curl:8.11.1",
                                      "command": ["sleep", "1"],
                                      "securityContext": {
                                          "allowPrivilegeEscalation": False,
                                          "capabilities": {"drop": ["ALL"]}}}]}}
    st, _ = await workloads._request("POST", workloads._path("v1", "pods"),
                                     json_body=probe, params={"dryRun": "All"})
    check("the API server ADMITS a pod naming nova-deployer — Pod Security "
          "governs what a container may do, never whose token it holds",
          200 <= st < 300, f"HTTP {st}")
    r = await workloads.apply(
        "apiVersion: v1\nkind: Pod\nmetadata: {name: sa-grab}\n"
        "spec:\n  serviceAccountName: nova-deployer\n"
        "  containers: [{name: c, image: curlimages/curl:8.11.1}]\n")
    check("...and this module refuses it anyway", r["status"] == "error")
    st, _ = await workloads._request("GET", workloads._path("v1", "pods", "sa-grab"))
    check("...with nothing left behind", st == 404, f"HTTP {st}")

    print("4. the namespace is imposed, not chosen")
    r = await workloads.apply(OTHER_NAMESPACE)
    obj = (r.get("objects") or [{}])[0]
    check("a manifest naming kube-system lands in HER namespace instead of "
          "being refused — the boundary is not a thing she can address",
          obj.get("status") == "applied")
    st, body = await workloads._request(
        "GET", "/api/v1/namespaces/kube-system/configmaps/test-escape")
    check("...and nothing was created over there", st in (403, 404), f"HTTP {st}")

    print("5. kinds outside the Role are refused with a useful list")
    r = await workloads.apply(FORBIDDEN_KIND)
    obj = (r.get("objects") or [{}])[0]
    check("creating a Namespace is not offered", obj.get("status") == "error")
    check("...and the error says what IS available",
          "Deployment" in str(obj.get("detail")), str(obj.get("detail"))[:90])

    print("6. cleanup works")
    check("delete", (await workloads.delete("Pod", "test-compliant"))
          .get("status") == "deleted")
    await workloads.delete("ConfigMap", "test-escape")
    await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
