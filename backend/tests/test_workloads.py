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


async def run() -> None:
    from app import db, settings_store, workloads
    from app.tools import scopes
    from app.tools import registry as tr

    await db.init_pool()
    await settings_store.warm()

    print("0. the enforced set and the described set are ONE set")
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

    print("3. the API server refuses what the policy forbids — not this module")
    r = await workloads.apply(PRIVILEGED)
    obj = (r.get("objects") or [{}])[0]
    check("a privileged pod is refused", obj.get("status") == "refused")
    check("...and the refusal names the control, so she can fix it rather "
          "than guess", "PodSecurity" in str(obj.get("detail")),
          str(obj.get("detail"))[:100])

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
