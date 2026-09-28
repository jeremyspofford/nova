"""The `systemone` adapter: a decision-model server (decision-role spec §1).

A decision model answers TYPED QUESTIONS — `{state, model, questions}` in,
`{model, answers, usage}` out — at `{base_url}/systemone`. TypeSafe's Jev
serves that shape, and so does Jared Palmer's Kev ("the TypeSafe Python SDK
works against a Kev server unchanged"). A provider row on THIS adapter is a
server that speaks nothing else — a Kev box on the owner's network: a base
URL and an optional bearer key, and no chat, which it says.

The decision call itself is not a method here: POST /v1/systemone forwards to
ANY link whose adapter carries `systemone` (Adapter.protocols) — OpenRouter's
openai-chat row carries both — with that row's own adapter's auth headers.

F6: the listing fetch and the wrong-key probe are shared with
`openai_chat.OpenAIChat` (`base.fetch_listing`, `base.wrong_key_probe`) —
lifted there rather than copied, each adapter supplying its own row
normaliser and its own wording.
"""

from __future__ import annotations

from fastapi import Request
from starlette.responses import Response

from app.adapters import base
from app.adapters.base import (
    DECISIONS,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    VerifyResult,
)
from app.adapters.openai_chat import DESCRIPTION_CAP
from app.providers import base_url_of


def normalize_models(body: object, *, owned_by: str) -> list[dict]:
    """A decision server's GET /models in the one listing shape: TypeSafe's
    model cards (`{"models": [{"name", "description", ...}]}` — what Kev
    serves) or OpenAI's `{"data": [{"id"}]}`. Every row is a decision model —
    the protocol says so — and states it as `output_modalities: ["decisions"]`."""
    if not isinstance(body, dict):
        raise ProviderRefused(502, "the model listing was not a JSON object")
    if isinstance(body.get("models"), list):
        entries, key = body["models"], "name"
    elif isinstance(body.get("data"), list):
        entries, key = body["data"], "id"
    else:
        raise ProviderRefused(502, "the model listing carried neither `models` nor `data`")
    rows: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get(key)
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        row: dict = {
            "id": model_id.strip(),
            "owned_by": owned_by,
            "output_modalities": [DECISIONS],
        }
        description = entry.get("description")
        if isinstance(description, str) and description.strip():
            row["description"] = description.strip()[:DESCRIPTION_CAP]
        rows.append(row)
    return rows


class SystemOne:
    name = "systemone"
    protocols = frozenset({"systemone"})

    def headers(self, row: dict) -> dict[str, str]:
        # providers.validate_shape allows `none` and `static-bearer` only.
        return base.bearer_or_header(row, header_name="api-key")

    async def list_models(self, app, row: dict) -> Listing:
        return await base.fetch_listing(
            app,
            row,
            base_url_of(row),
            headers=self.headers(row),
            normalize=normalize_models,
            # F13: no "type a model id" — no page offers a typed id for a
            # decision server.
            unavailable_note="this server has no model listing",
        )

    async def verify(self, app, row: dict) -> VerifyResult:
        """What a save must prove: the server answers and, when it has a key,
        the key is accepted. The listing is read with the key, then with one
        that is certainly wrong (base.wrong_key_probe): a 401/403 to the
        wrong one means the right one was accepted (Kev answers 401 on every
        /v1 path when KEV_API_KEY is set). A listing that answers the wrong
        key too proved nothing about the key, and the note says so — never
        "verified"."""
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(
                listing="unavailable",
                note=f"{exc} — the key was not tested; the first decision will tell",
                key_proven=None,
            )
        note = f"{len(listing.models)} decision models listed"
        if row.get("auth_shape") == "none":
            return VerifyResult(
                listing="available", models=listing.models, note=note, key_proven=None
            )
        bucket, status, detail = await base.wrong_key_probe(
            app, row, base_url_of(row), headers_for=self.headers
        )
        if bucket == "protected":
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note}; the listing accepted the key",
                key_proven=True,
            )
        if status is None:
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note}; the wrong-key check could not reach the server — "
                f"{detail} — the key is NOT proven; the first decision will tell",
                key_proven=None,
            )
        return VerifyResult(
            listing="available",
            models=listing.models,
            note=f"{note}; the listing answered {status} to a wrong key too, so "
            "the key is NOT proven — the first decision will tell",
            key_proven=None,
        )

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        """A decision-model server has no chat, and says so — a 400 about THIS
        request, so nothing is walled. Routing never picks one for a chat role
        (routing.speaks); this is what a caller with no role, naming the model
        outright, is told."""
        raise ProviderRefused(
            400,
            f"{row['name']} is a decision-model server (systemone): it answers typed "
            "questions at POST /v1/systemone and has no chat",
        )


ADAPTER = SystemOne()

__all__ = ["ADAPTER", "DECISIONS", "SystemOne", "normalize_models"]
