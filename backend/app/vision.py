"""Reading a photographed document with a model that can see (roadmap #22).

The third and last text source, after `doc_extract` (the document's own text
layer) and `ocr` (tesseract on the pixels). It exists because OCR fails on
exactly the things a phone camera produces: a letter photographed at an
angle, in kitchen light, with a fold across it. A vision model reads those.

It is also the only one of the three that can send the operator's document
off this machine, and that single fact shapes the module:

  **A cloud vision model is refused unless the operator turned it on.**

Not warned about — refused, by `_refuse_cloud` below, before any bytes are
built into a request. The setting exists because Jeremy asked for the option
to use cloud models and that is his call to make; the refusal exists because
the most sensitive thing anyone will ever attach here is a photograph of a
letter, and "it went to a third party" must be a decision he made rather
than a default he inherited. The two are not in tension: the option is real,
and it is off until chosen.

The other rule this module keeps: what comes back is a MODEL'S READING of a
picture, not the document. It can be fluently, confidently wrong about a
figure that was never on the page. Callers label it, and `text_source` says
`vision` so nothing downstream can mistake it for the text layer.
"""

import logging
from typing import Optional

from app import settings_store
from app.llm import router as llm_router

log = logging.getLogger(__name__)

# Deliberately narrow. This is a transcription, not a conversation: the model
# is asked for what the page SAYS, and told to mark what it cannot read
# rather than guess it — a guessed digit in an account number is the failure
# mode that makes the whole feature worse than nothing.
_PROMPT = (
    "Transcribe every piece of text visible in this image, in reading order. "
    "Preserve headings, dates, amounts and reference numbers exactly as they "
    "appear. If any part is cut off, blurred, or you cannot read it with "
    "confidence, write [unreadable] there instead of guessing — a wrong "
    "digit in an amount or an account number is worse than a gap. If the "
    "image contains no text at all, reply with exactly: NO TEXT.")

_NO_TEXT = "NO TEXT"


class VisionUnavailable(Exception):
    """No usable vision model. Carries a sentence naming what to change."""


class VisionEmpty(Exception):
    """A vision model looked and reported no text."""


def _refuse_cloud(model: str) -> Optional[str]:
    """Why this model may not be used, or None if it may.

    Mechanical and derived: it asks the router whether the resolved model is
    local, rather than pattern-matching a provider name that a new provider
    would silently slip past.
    """
    if llm_router.is_local(llm_router.effective_model(model)):
        return None
    if settings_store.get("attachments.allow_cloud_vision"):
        return None
    return (f"'{model}' is a cloud model, and cloud vision is off — a "
            f"photograph of a document would leave this machine. Turn on "
            f"Settings → Attachments → 'Allow cloud vision models' to use "
            f"it, or set a local vision model instead.")


async def _can_see(model: str) -> bool:
    """Positive evidence only.

    `model_fitness.assess` blocks when capabilities are KNOWN and lack
    vision, so an uncatalogued model sails through it — fine for an advisory,
    wrong here, where failing open means the pixels go to something that
    cannot read them and the operator is told the letter was read. So this
    asks for `vision` to be present rather than for it not to be absent.
    """
    try:
        from app import model_fitness
        desc = await model_fitness.describe(llm_router.effective_model(model))
        return "vision" in ((desc or {}).get("capabilities") or [])
    except Exception:
        log.exception("vision capability probe failed for %s", model)
        return False


async def read_image(data_b64: str, mime: str, *, name: str = "") -> str:
    """Transcribe an image with the configured vision model.

    Raises VisionUnavailable (nothing configured / not permitted / cannot
    see) or VisionEmpty (it looked, there was no text). Never returns a
    guess about whether it worked.
    """
    model = str(settings_store.get("attachments.vision_model") or "").strip()
    if not model:
        raise VisionUnavailable(
            "no vision model is set (Settings → Attachments → 'Vision model "
            "for images')")
    refusal = _refuse_cloud(model)
    if refusal:
        raise VisionUnavailable(refusal)
    if not await _can_see(model):
        raise VisionUnavailable(
            f"'{model}' does not report vision capability, so it cannot read "
            f"an image — pull a vision-capable model (e.g. qwen2.5vl) or "
            f"choose a cloud one")

    messages = [{"role": "user", "content": [
        {"type": "text", "text": _PROMPT},
        {"type": "image_url",
         "image_url": {"url": f"data:{mime or 'image/jpeg'};base64,{data_b64}"}},
    ]}]
    out = ""
    async for event in llm_router.stream_chat(messages, model, None):
        if event.get("type") == "text":
            out += event["text"]
        elif event.get("type") == "error":
            raise VisionUnavailable(
                f"the vision model failed: {event.get('error')}")
    out = out.strip()
    if not out or out.upper().startswith(_NO_TEXT):
        raise VisionEmpty(f"{model} looked at {name or 'the image'} and "
                          f"reported no readable text")
    log.info("vision transcription of %s via %s: %d chars", name, model, len(out))
    return out
