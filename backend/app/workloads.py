"""Nova's own runtime — the client for the namespace she owns.

`docs/plans/capability-acquisition.md` shape 4. Jeremy, 2026-07-29, rejecting
the design where a human writes the service and she gets an on/off switch:
"Home assistant is supposed to be something that nova can implement and
manage!" So she authors the workload and applies it herself, and containment
is the runtime rather than a review.

THE ONE DESIGN DECISION THAT MATTERS HERE, and it is about who we authenticate
as. This module talks to the API server with the **nova-deployer
ServiceAccount token**, never a kubeconfig with admin credentials. That is
what makes `workloads/rbac.yaml` a real boundary instead of a decorative one:
if this code has a bug, or is talked into something by a poisoned page, the
API server refuses it anyway. A privileged client validating her manifests in
Python would be the denylist shape — a check that holds until someone finds
the entry it is missing.

So there is deliberately NO manifest inspection in here. No scan for
`privileged`, no hostPath check, no image allowlist. Every one of those is
enforced by Pod Security Admission at the API server, which cannot be argued
with. Adding a Python copy would create a second, weaker authority that drifts
from the first — and the day they disagree, the wrong one is the one the model
learns to satisfy.

The credential's PRESENCE is the feature switch: no token file means no
runtime, and the tools say so plainly rather than failing obscurely. That
keeps a stack with no cluster working exactly as before.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

TOKEN_FILE = "/app/data/runtime/k8s-token"
CA_FILE = "/app/data/runtime/k8s-ca.crt"

# What she may create, and the API path each lives at. A closed set, because a
# generic "apply anything" would need cluster discovery and would let her
# submit kinds the Role cannot touch anyway — the refusal is better spelled
# here, where the error can say which kinds ARE available.
#
# Deliberately absent: Namespace, NetworkPolicy, ResourceQuota, LimitRange,
# Role, RoleBinding, ServiceAccount. Her Role has no verb on those (see
# rbac.yaml), so the API server would refuse them regardless; listing them
# would only invite the attempt.
KINDS: dict[str, tuple[str, str]] = {
    "Deployment":            ("apps/v1", "deployments"),
    "StatefulSet":           ("apps/v1", "statefulsets"),
    "Service":               ("v1", "services"),
    "ConfigMap":             ("v1", "configmaps"),
    "Secret":                ("v1", "secrets"),
    "PersistentVolumeClaim": ("v1", "persistentvolumeclaims"),
    "Pod":                   ("v1", "pods"),
    "Job":                   ("batch/v1", "jobs"),
    "CronJob":               ("batch/v1", "cronjobs"),
}

_TIMEOUT = 20.0


def namespace() -> str:
    return os.environ.get("NOVA_K8S_NAMESPACE") or "nova-workloads"


def api_url() -> str:
    return (os.environ.get("NOVA_K8S_API_URL") or "").rstrip("/")


def configured() -> bool:
    """Is there a runtime to talk to? Derived from the credential on disk, so
    there is no flag to leave switched on after the cluster is gone."""
    return bool(api_url()) and os.path.exists(TOKEN_FILE)


def _auth() -> tuple[dict[str, str], str]:
    with open(TOKEN_FILE) as f:
        token = f.read().strip()
    return {"Authorization": f"Bearer {token}"}, CA_FILE


def _path(api_version: str, plural: str, name: str = "") -> str:
    root = "/api/v1" if api_version == "v1" else f"/apis/{api_version}"
    p = f"{root}/namespaces/{namespace()}/{plural}"
    return f"{p}/{name}" if name else p


async def _request(method: str, path: str, *, json_body: Any = None,
                   params: Optional[dict] = None) -> tuple[int, Any]:
    headers, ca = _auth()
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    async with httpx.AsyncClient(verify=ca, timeout=_TIMEOUT) as client:
        r = await client.request(method, api_url() + path, headers=headers,
                                json=json_body, params=params)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def _reason(status: int, body: Any) -> str:
    """The API server's own words. Its refusals are unusually good — Pod
    Security names the exact control violated — so passing them through
    verbatim tells her what to fix. Paraphrasing loses the only part that
    is actionable."""
    if isinstance(body, dict) and body.get("message"):
        return str(body["message"])
    return f"HTTP {status}: {str(body)[:400]}"


async def apply(manifest: str) -> dict:
    """Create or replace the objects in a YAML manifest.

    Multi-document YAML is supported because a service is usually several
    objects (a Deployment plus a Service plus a PVC), and making her submit
    them one at a time would mean a half-applied service on any failure.
    """
    import yaml
    try:
        docs = [d for d in yaml.safe_load_all(manifest) if d]
    except yaml.YAMLError as e:
        return {"status": "error", "detail": f"manifest is not valid YAML: {e}"}
    if not docs:
        return {"status": "error", "detail": "manifest is empty"}

    results = []
    for doc in docs:
        if not isinstance(doc, dict):
            results.append({"status": "error", "detail": "not a Kubernetes object"})
            continue
        kind = str(doc.get("kind") or "")
        name = str((doc.get("metadata") or {}).get("name") or "")
        if kind not in KINDS:
            results.append({
                "kind": kind or "(none)", "name": name, "status": "error",
                "detail": (f"'{kind}' is not something you can create here. "
                           f"Available: {', '.join(sorted(KINDS))}.")})
            continue
        if not name:
            results.append({"kind": kind, "status": "error",
                            "detail": "metadata.name is required"})
            continue
        api_version, plural = KINDS[kind]
        # the namespace is IMPOSED, not read from the manifest — otherwise a
        # manifest naming another namespace would be an attempt the API server
        # has to refuse, and the refusal would read as a bug rather than as the
        # boundary. One namespace, always, and it is not hers to choose.
        doc.setdefault("metadata", {})["namespace"] = namespace()
        doc.setdefault("apiVersion", api_version)

        status, body = await _request("POST", _path(api_version, plural),
                                      json_body=doc)
        if status == 409:  # exists → replace, so apply is idempotent
            status, body = await _request(
                "PUT", _path(api_version, plural, name), json_body=doc)
        ok = 200 <= status < 300
        results.append({
            "kind": kind, "name": name,
            "status": "applied" if ok else "refused",
            **({} if ok else {"detail": _reason(status, body)})})
        log.info("workload %s %s/%s: %s", "applied" if ok else "REFUSED",
                 kind, name, "" if ok else _reason(status, body)[:200])

    applied = [r for r in results if r.get("status") == "applied"]
    return {"status": "ok" if len(applied) == len(results) else "partial",
            "applied": len(applied), "of": len(results), "objects": results}


async def listing() -> dict:
    """Everything running in her namespace, plus why anything is unhealthy."""
    out: dict[str, Any] = {"namespace": namespace(), "objects": []}
    for kind, (api_version, plural) in KINDS.items():
        status, body = await _request("GET", _path(api_version, plural))
        if status != 200 or not isinstance(body, dict):
            continue
        for item in body.get("items") or []:
            meta = item.get("metadata") or {}
            entry = {"kind": kind, "name": meta.get("name")}
            st = item.get("status") or {}
            if kind == "Pod":
                entry["phase"] = st.get("phase")
                # the reason a pod is not running is the whole value of this
                # call when something is wrong
                waiting = [c.get("state", {}).get("waiting", {}).get("reason")
                           for c in (st.get("containerStatuses") or [])]
                if any(waiting):
                    entry["waiting"] = [w for w in waiting if w]
            elif kind in ("Deployment", "StatefulSet"):
                entry["ready"] = f"{st.get('readyReplicas') or 0}/" \
                                 f"{(item.get('spec') or {}).get('replicas', 0)}"
            out["objects"].append(entry)
    return out


async def delete(kind: str, name: str) -> dict:
    if kind not in KINDS:
        return {"status": "error",
                "detail": f"unknown kind '{kind}'. Available: {', '.join(sorted(KINDS))}."}
    api_version, plural = KINDS[kind]
    status, body = await _request("DELETE", _path(api_version, plural, name))
    if 200 <= status < 300:
        log.info("workload deleted: %s/%s", kind, name)
        return {"status": "deleted", "kind": kind, "name": name}
    return {"status": "error", "detail": _reason(status, body)}


async def logs(pod: str, lines: int = 60) -> str:
    """A pod's recent output. `pods/log` is granted and `pods/exec` is not —
    reading what a container said is how she debugs a deployment; getting a
    shell in it is arbitrary code with that pod's identity."""
    headers, ca = _auth()
    async with httpx.AsyncClient(verify=ca, timeout=_TIMEOUT) as client:
        r = await client.get(
            api_url() + _path("v1", "pods", f"{pod}/log"), headers=headers,
            params={"tailLines": str(max(1, min(int(lines), 500)))})
    if r.status_code != 200:
        try:
            return "Error: " + _reason(r.status_code, r.json())
        except Exception:
            return f"Error: HTTP {r.status_code}"
    return r.text or "(no output)"


async def health() -> dict:
    """Is the runtime reachable, and is the boundary the one we think it is?

    Reports the quota alongside, because "why did my deployment not start" is
    answered by the quota more often than by anything else.
    """
    if not configured():
        return {"configured": False,
                "detail": ("No runtime is set up. An operator creates it with "
                           "workloads/setup.sh; until then nothing can be "
                           "deployed and that is not a fault you can fix.")}
    status, body = await _request("GET", _path("v1", "pods"))
    if status != 200:
        return {"configured": True, "reachable": False,
                "detail": _reason(status, body)}
    out = {"configured": True, "reachable": True, "namespace": namespace()}
    qs, qb = await _request("GET", _path("v1", "resourcequotas"))
    if qs == 200 and isinstance(qb, dict):
        for item in qb.get("items") or []:
            st = item.get("status") or {}
            out["quota"] = {"used": st.get("used"), "limit": st.get("hard")}
    return out
