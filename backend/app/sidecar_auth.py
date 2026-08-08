"""Bearer headers for the two privileged sidecars (ROADMAP #44 item 1).

`git-landing` holds the only read-write mount of the operator's repository;
`inference-control` holds the docker socket, which is root on the host. Both
answered any container on the compose network until 2026-08-08 — the
2026-08-07 review called closing that the non-negotiable precondition for
#47 rail 6, and mcp-runner already had the shape to copy: one shared token
per sidecar, `Authorization: Bearer`, constant-time compare on the server.

ONE module because there are ~15 call sites across eight files, and a header
each of them assembles by hand is a header one of them forgets.
`tests/test_sidecar_auth.py` scans the call sites mechanically so a new one
cannot ship bare.

An empty token sends NO header rather than an invented one — the same choice
`mcp_client._runner_auth` makes: the sidecar is the thing that refuses, and
the sidecar decides the unconfigured posture. Sending the header to a sidecar
image that does not yet CHECK it is harmless (both servers ignored unknown
headers before they enforced them), which is what keeps the rollout window
safe: the backend starts sending before the sidecar images start requiring.
"""

from app.config import settings


def git_landing_headers() -> dict:
    """Auth header for git-landing calls; {} when no token is configured."""
    token = settings.nova_git_landing_token
    return {"Authorization": f"Bearer {token}"} if token else {}


def inference_control_headers() -> dict:
    """Auth header for inference-control calls; {} when unconfigured."""
    token = settings.nova_inference_control_token
    return {"Authorization": f"Bearer {token}"} if token else {}
