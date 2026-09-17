"""Bearer-token auth middleware — identical across all three services.

Every route but /health/live requires `Authorization: Bearer <SERVICE_TOKEN>`.
Refuse-all-when-unset: if SERVICE_TOKEN is missing or empty, every
non-health request gets 503 rather than silently running unauthenticated.
"""
from __future__ import annotations

import hmac
import os

from starlette.requests import Request
from starlette.responses import JSONResponse

TOKEN_UNSET_BODY = {"error": "service token unset — refusing all requests"}
_BEARER_PREFIX = "Bearer "


async def bearer_auth_middleware(request: Request, call_next):
    if request.url.path == "/health/live":
        return await call_next(request)

    token = os.environ.get("SERVICE_TOKEN", "")
    if not token:
        return JSONResponse(TOKEN_UNSET_BODY, status_code=503)

    header = request.headers.get("authorization", "")
    presented = header[len(_BEARER_PREFIX):] if header.startswith(_BEARER_PREFIX) else ""
    if not presented or not hmac.compare_digest(presented, token):
        return JSONResponse({"error": "invalid or missing bearer token"}, status_code=401)

    return await call_next(request)
