"""S28 — which model can actually look at the picture he sent.

THE ANSWER IS DERIVED, and that is the whole of this module's reason to
exist. ollama reports capabilities per model (`/api/show`), the gateway
already folds them into every catalogue row, and the household's own models
disagree about this:

    qwen3:8b        completion, tools, thinking
    qwen3.8:27b     completion, tools, thinking, vision
    gemma4:12b      completion, tools, thinking, vision, audio

So "can she see this" has a live answer for the model actually selected, it
changes when he installs or removes a model, and nothing here may name one.
A hardcoded list would be wrong the day he pulls a new model — and wrong
SILENTLY, because the failure is an image quietly missing from a turn and a
reply written from the filename.

THE SWITCH IS STATED. The owner's ruling (2026-09-16): an image he sent is a
thing he wants read, so the turn runs on a model that can read it and the
reply says which and why. A model switch he cannot see is how "she answered
from a different brain" becomes invisible — so the swap goes in the turn as
a fact and the span records the model that actually ran.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from app import peers

# How long to wait for the catalogue before deciding without it. Short: this
# sits in front of a turn the owner is waiting on, and the fallback (send it
# to the model he chose and say the capability could not be checked) is
# honest rather than merely faster.
CATALOG_TIMEOUT = 10.0


@dataclass(frozen=True)
class Choice:
    """What to run this turn on, and what to say about it."""

    model: str
    # None when nothing was swapped. Otherwise the sentence the turn carries
    # — never silent, never invented later.
    note: str | None
    # True when the picture is going to the model. False means it is not, and
    # `note` says why in words he can act on.
    can_see: bool
    # Whether the capability is KNOWN. False only when the catalogue could
    # not be read — and the difference matters: "nothing here can see" is a
    # claim about his machine, "I could not tell" is a fact about a request
    # that failed. Saying the first when the second is true is the defect
    # the live walk found (2026-09-16).
    certain: bool = True


def capable(rows: list[dict], capability: str) -> list[str]:
    """Installed models that report a capability, in the catalogue's order.

    Reads the capability MAP rather than any name: `{"vision": {"value":
    true}}` is the shape the gateway publishes, and a row that reports
    nothing simply does not qualify. Uninstalled rows are skipped — a model
    that would be able to see if it were here cannot see now, and offering it
    is offering a download.
    """
    out = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("installed"):
            continue
        caps = row.get("capabilities") or {}
        fact = caps.get(capability)
        value = fact.get("value") if isinstance(fact, dict) else fact
        if value:
            model = row.get("id")
            if isinstance(model, str) and model:
                out.append(model)
    return out


def rows_of(body: object) -> list[dict] | None:
    """The catalogue's rows out of whatever hop answered.

    The gateway publishes them as `rows`; core's own /api/v1/models/catalog
    republishes the same list as `models`. Both are real names for one
    thing, and a helper that can reach either hop should not care which it
    landed on — reading only one of them is how every turn came to decide
    the catalogue was unreadable (the walk, 2026-09-16).

    None means "no readable list here", which the caller treats as a THIRD
    answer rather than as an empty one.
    """
    if not isinstance(body, dict):
        return None
    for key in ("rows", "models"):
        found = body.get(key)
        if isinstance(found, list):
            return found
    return None


def bare(model: str) -> str:
    """A catalogue id without its provider. The gateway builds every id as
    `<provider>:<model>` (catalog_row.base_row), so the FIRST colon is the
    provider's — `hub:qwen3.8:27b` -> `qwen3.8:27b`, whatever the machine is
    called (S40). Only for catalogue ids: a setting may be bare (`qwen3.8:27b`),
    whose first colon is the tag's own, and `choose` matches it against both
    halves instead of splitting it. What a person reads; the Settings picker
    writes the row's own fields instead (models_catalog.vision_models)."""
    _provider, sep, rest = model.partition(":")
    return rest if sep and rest else model


def _said(model: str, rows: list[dict]) -> str:
    """How a person reads a model named in a SETTING: without its provider
    when the catalogue lists a row under that provider, as-is otherwise — only
    the rows can tell `hub:` (a machine) from `qwen3.8:` (a model's own name)."""
    head, sep, rest = model.partition(":")
    if (
        sep
        and rest
        and any(isinstance(r, dict) and str(r.get("id") or "").startswith(f"{head}:") for r in rows)
    ):
        return rest
    return model


def choose(
    rows: list[dict],
    *,
    wanted: str,
    capability: str = "vision",
    preferred: str = "",
) -> Choice:
    """The model this turn should run on, given what he attached.

    `preferred` is HIS choice (`chat.vision_model`), and it wins over any
    automatic pick — but it is checked, not obeyed: a model he named that is
    not installed, or that cannot actually see, is passed over for one that
    can, and the note says which ran. The capability is read from the model
    every time; this setting chooses BETWEEN capable models, it never asserts
    that one is.

    Outcomes, each saying something different:

      * the chosen model can already see it — nothing changes, nothing is
        said, because a note about a swap that did not happen is noise;
      * it cannot, and another installed model can — swap, and SAY which and
        why;
      * it cannot and nothing here can — keep his model and say plainly that
        no installed model can see images, so she does not describe it from
        its name;
      * the catalogue could not be read — keep his model and say the
        capability could not be checked. Never assume either way: assuming
        yes sends an image to a model that will ignore it, assuming no
        withholds a picture from a model that could have read it.
    """
    if rows is None:
        return Choice(
            model=wanted,
            note=(
                "The model catalogue could not be read this turn, so whether this model can "
                "see images is unknown — say so rather than describing the image."
            ),
            can_see=False,
            certain=False,
        )
    able = capable(rows, capability)
    bares = {bare(m) for m in able}
    # A setting names a catalogue row exactly (`hub:qwen3.8:27b`) or by its
    # model alone (`qwen3.8:27b`). Never split: its first colon may be the
    # tag's own.
    if wanted in able or wanted in bares:
        return Choice(model=wanted, note=None, can_see=True)
    if not able:
        return Choice(
            model=wanted,
            note=(
                f"No model installed on this machine reports the {capability} capability, so "
                "the attachment below is NOT in this turn. Say that; do not describe it."
            ),
            can_see=False,
        )
    # HIS pick first, matched with or without the catalogue's prefix, and
    # only if it is in the capable set — a name in a settings row is a claim,
    # and the capability map is the fact.
    picked = able[0]
    if preferred:
        for model in able:
            if model == preferred or bare(model) == preferred:
                picked = model
                break
    said = _said(wanted, rows)
    return Choice(
        model=picked,
        note=(
            f"This turn is running on {bare(picked)} rather than {said}, because "
            f"{said} cannot see images and {bare(picked)} can. Say so in the reply."
        ),
        can_see=True,
    )


async def catalog_rows(app) -> list[dict] | None:
    """The gateway's catalogue, or None when it could not be read.

    None is a THIRD answer and the callers above treat it as one. Returning
    [] on a failure would read as "no model can see", which is a statement
    about the machine rather than about the request that failed.
    """
    try:
        async with peers.client(app, peers.GATEWAY, CATALOG_TIMEOUT) as client:
            # Relative: peers.client sets base_url from GATEWAY_URL, and the
            # test transports are keyed on that same URL.
            upstream = await client.get("/admin/catalog")
        if upstream.status_code != 200:
            return None
        body = upstream.json()
    except (httpx.HTTPError, peers.PeerUnconfigured, ValueError):
        return None
    return rows_of(body)
