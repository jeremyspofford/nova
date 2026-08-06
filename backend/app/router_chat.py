"""Chat + platform API router.

SSE contract for POST /api/v1/chat/stream:
    data: {"meta": {"conversation_id": ..., "model": ...}}
    data: {"t": "text delta"}
    data: {"activity": {"kind": "tool_start|tool_result|dispatch|agent_reply", "name": ..., "agent": ..., "detail": ...}}
    data: {"error": "..."}
    data: [DONE]
"""

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from app import automations, bg, commands, compaction, consents, conversations, db, recommendations, rules, settings_store, trace, voiceprints
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.tools import registry as tool_registry
from app.config import settings
from app.llm.router import effective_model
from app.memory.memory import memory
from app.schemas import ChatRequest

log = logging.getLogger(__name__)

# Capability/platform nodes (core, user, agents, tools, automations, rules) are
# live structure, not dated memories. Stamping them with a per-request time
# churned the brain-graph fingerprint on every 20s poll — rebuilding the whole
# universe view and snapping the camera back to the selected node — and tripped
# the "freshly learned" 24h flare on every capability. One stable value (they
# came online with this instance) keeps the payload identical across polls.
_CAP_MTIME = time.time()

router = APIRouter()

# Appended LAST to the assembled system prompt for voice-initiated turns (via
# run_agent's system_suffix) — the reply is read aloud, so it must be short and
# speakable. Last position matters: patched into the front of the agent prompt
# this got buried mid-prompt and the 8b voice model ignored the emoji ban.
_VOICE_BREVITY = (
    "## This reply will be spoken aloud\n"
    "Answer in one or two short, natural sentences — the way you'd say it "
    "out loud across the room. ABSOLUTELY no tables, lists, headers, "
    "markdown, emoji, or emoticons — none of that can be spoken. Never "
    "speak instruction text or explain where a fact (like the time) came "
    "from. No sign-offs and no offers of more help, even on greetings and "
    "goodbyes: \"goodnight\" gets \"Night — sleep well.\", never "
    "\"Goodnight! If you need anything else, just say the word!\". Give "
    "the answer and stop; if they want more they'll ask."
)


def _sse(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@router.get("/api/v1/commands")
async def list_commands():
    """The slash-command catalog — the palette reads this rather than
    hard-coding a list, so a new command shows up without a UI change."""
    return {"commands": commands.catalog()}


@router.post("/api/v1/commands/{name}")
async def run_command(name: str, body: dict | None = None):
    cmd = commands.REGISTRY.get(name.lower())
    if not cmd or not cmd.run:
        raise HTTPException(status_code=404, detail=f"no such command: /{name}")
    return await cmd.run((body or {}).get("arg", ""))


# ── backups (roadmap #31) ────────────────────────────────────────────────
#
# Read-only except for `snapshot`, which writes a bundle and touches nothing
# else. Restore-in-place is deliberately NOT exposed here: it replaces the
# database and overwrites files, and it belongs behind a typed confirmation
# in a considered flow rather than one POST away from the rest of the API.


@router.get("/api/v1/backups")
async def list_backups():
    """Bundles on disk, plus what a new one WOULD contain and whether it can
    be made at all. Coverage rides along because "can I back up?" and "what
    would it hold?" are the same question to the operator."""
    from app import backup_service as bsvc
    ok, why = bsvc.store_available()
    out = {"bundles": bsvc.bundles(), "store_ok": ok, "store_error": why}
    try:
        out["coverage"] = await bsvc.coverage()
    except Exception as e:  # noqa: BLE001
        log.exception("backup coverage scan failed")
        out["coverage"] = {"may_snapshot": False, "entries": [],
                           "refusals": [{"code": "SCAN_FAILED",
                                         "subject": "coverage",
                                         "detail": str(e)}]}
    return out


@router.post("/api/v1/backups")
async def create_backup():
    from app import backup_service as bsvc, backup_snapshot as bs
    try:
        return await bsvc.snapshot()
    except bs.SnapshotRefused as e:
        # 409, not 500: nothing is broken. Something is unaccounted for, and
        # the operator is the one who can classify it.
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/api/v1/backups/{name}/verify")
async def verify_backup(name: str):
    """Restore a bundle into a throwaway database and drop it. Proves the
    bundle is restorable without touching anything live."""
    from app import backup_service as bsvc
    from app.backup_restore import RestoreRefused
    try:
        return await bsvc.verify_restore(name)
    except RestoreRefused as e:
        raise HTTPException(status_code=409, detail=str(e))


# ── forgetting one journal entry (roadmap #22) ───────────────────────────
#
# OPERATOR ONLY, and that is the whole design. `delete_memory_item` refuses
# journals for a good reason — "journals are the audit trail" — and a model
# that can erase its own history is a model that can cover a mistake. That
# refusal at builtin.py is untouched; this is a different door, behind the
# auth middleware, reached from the operator's own UI. Same shape as
# `agent_registry.update_agent(operator=True)`.
#
# It exists because "forget that document" was false. A turn where Nova
# quoted a payslip was permanent, retrieved into later prompts (measured:
# journals appear in 122 of 695 retrieval spans), and removable only by
# destroying an entire day of the operator's life.


@router.get("/api/v1/memory/journal/{date}/entries")
async def journal_entries(date: str):
    """The day's entries, each with the content hash used to address one.

    Addressed by hash rather than by the `## <stamp>` heading because a
    stamp is not unique: 2026-08-01 has 42 headings and 14 distinct ones, so
    a deletion keyed on the heading would take unrelated turns with it.
    """
    doc_id = f"journals/{date}.md"
    entries = await memory.journal_entries(doc_id)
    if not entries:
        raise HTTPException(status_code=404,
                            detail=f"no journal for {date}, or it has no entries")
    return {"doc_id": doc_id, "entries": entries}


@router.post("/api/v1/memory/journal/{date}/forget")
async def forget_journal_entry(date: str, body: dict):
    """Remove one entry and reindex. The hash is required and is the guard.

    A stale hash means the operator is acting on a view that has moved on —
    the day's next turn appended, or someone already removed it — and that
    returns 409 rather than removing whatever is now in that position.
    """
    sha = str((body or {}).get("sha256") or "").strip()
    if len(sha) != 64:
        raise HTTPException(
            status_code=422,
            detail="sha256 of the entry to forget is required (see the "
                   "entries endpoint) — entries are addressed by content, "
                   "not by their timestamp, which is not unique")
    entry = await memory.forget_journal_entry(
        f"journals/{date}.md", sha, str((body or {}).get("reason") or ""))
    if not entry:
        raise HTTPException(
            status_code=409,
            detail="no entry with that hash is in this journal any more — "
                   "it may already be gone, or the day has changed since you "
                   "loaded it. Reload and try again.")
    # Recorded AFTER the fact, never before: an event row written first and
    # then a failed write is a receipt for something that did not happen,
    # which is the one outcome worse than not having the feature.
    try:
        from app import capability_events as ce
        ce.record(ce.MEMORY, f"journals/{date}.md",
                  "entry_forgotten", actor="operator",
                  detail={"stamp": entry["stamp"], "chars": len(entry["text"])})
    except Exception:
        log.exception("journal excision succeeded but was not recorded")
    return {"forgotten": True, "stamp": entry["stamp"],
            "chars": len(entry["text"])}


# ── attachments: documents the operator handed over (roadmap #22b) ───────
#
# Uploaded on their own, BEFORE the turn, as raw multipart rather than
# base64 inside the chat body. Two reasons, both measured: base64 inflates
# by 4/3 against a body limit, and — the real one — a turn that fails must
# not be able to destroy the document that prompted it. The composer used to
# clear itself optimistically, so a refused turn ate a phone photograph that
# existed nowhere else.


@router.post("/api/v1/attachments")
async def upload_attachment(file: UploadFile = File(...),
                            conversation_id: str | None = Form(None)):
    """Keep a document. Returns the row, including whatever text was read.

    Extraction happens here rather than at turn time so the operator learns
    NOW that their scan is unreadable, while the file is still in their hand
    — not three messages later when the answer looks confidently wrong.
    """
    from app import attachments, doc_extract
    ok, why = attachments.store_available()
    if not ok:
        raise HTTPException(status_code=503, detail=why)
    data = await file.read()
    name = file.filename or "attachment"
    mime = file.content_type or ""
    kind = "image" if mime.startswith("image/") else "doc"

    # Text is best-effort and its ABSENCE is recorded with a reason. An
    # unreadable document is still worth keeping — it is the only copy — so
    # a failed read must never fail the upload.
    text = source = err = None
    try:
        if kind == "image":
            text, source = await doc_extract.extract_image(data, name)
        else:
            text, source = await doc_extract.extract_best(
                data, name, mime,
                allow_ocr=bool(settings_store.get("attachments.ocr_enabled")))
    except (doc_extract.Unsupported, doc_extract.Unextractable) as e:
        err = str(e)
    except Exception as e:            # noqa: BLE001 — never lose the bytes
        log.exception("extraction failed for %s", name)
        err = f"extraction failed: {e}"

    try:
        row = await attachments.store(
            data, name=name, mime=mime, kind=kind,
            conversation_id=conversation_id,
            text=text, text_source=source, text_error=err)
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except attachments.StoreUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    row.pop("text_content", None)     # the list view never wants it inline
    return row


@router.get("/api/v1/attachments")
async def list_attachments(limit: int = 200):
    from app import attachments
    return {"attachments": await attachments.listing(min(limit, 500)),
            "usage": await attachments.usage()}


@router.get("/api/v1/attachments/{attachment_id}")
async def get_attachment(attachment_id: str):
    from app import attachments
    row = await attachments.get(attachment_id)
    if not row:
        raise HTTPException(status_code=404, detail="attachment not found")
    return row


@router.get("/api/v1/attachments/{attachment_id}/raw")
async def get_attachment_raw(attachment_id: str):
    """The original bytes, exactly as they arrived.

    `attachment` rather than `inline`: this endpoint hands back
    operator-supplied bytes, and rendering an arbitrary uploaded file inline
    on the app's own origin is how a stored SVG or HTML becomes script in
    Nova's context.
    """
    from app import attachments
    got = await attachments.read_bytes(attachment_id)
    if not got:
        raise HTTPException(
            status_code=404,
            detail="attachment not found, or its bytes are missing from the store")
    data, row = got
    safe = row["display_name"].replace('"', "").replace("\n", " ")
    return Response(
        content=data,
        media_type=row["mime"] or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe}"',
                 "X-Content-Type-Options": "nosniff"})


@router.delete("/api/v1/attachments/{attachment_id}")
async def delete_attachment(attachment_id: str):
    from app import attachments
    if not await attachments.delete(attachment_id):
        raise HTTPException(status_code=404, detail="attachment not found")
    return {"deleted": True}


async def _model_can_see(model: str) -> bool:
    """Whether this model can accept an image, on POSITIVE evidence.

    Deliberately not `model_fitness.assess(needs_vision=True)`: that blocks
    only when capabilities are KNOWN and lack vision, so an uncatalogued
    model sails through. That is right for an advisory and wrong here, where
    failing open costs the whole turn — an image part to a text-only cloud
    model returns `404 No endpoints found that support image input` and takes
    the OCR text down with it. So this asks for `vision` to be PRESENT.
    """
    try:
        from app import model_fitness
        desc = await model_fitness.describe(effective_model(model))
        return "vision" in ((desc or {}).get("capabilities") or [])
    except Exception:
        log.exception("vision capability probe failed for %s", model)
        return False


async def _image_text(a, model: str) -> tuple[str, str]:
    """Whatever text an attached image yields, plus a note for the operator.

    Two mechanisms, and the important part is what happens when BOTH fail.
    Until now nothing checked whether the answering model could see: attach a
    photo to a text-only local model and the pixels went out as an
    `images` array to something that ignores them, and she answered anyway —
    confidently, about a letter she never received. `model_fitness.assess`
    has carried a `needs_vision` BLOCKING finding the whole time and it had
    ZERO callers (`grep -rn "needs_vision="` → nothing). A control nobody
    calls is not a control; this is the caller.

    The refusal is stated IN THE TURN TEXT rather than only logged, for the
    same reason truncation is: a model cannot flag a gap it was never shown,
    and "I couldn't see it" has to reach the operator in the reply, not in
    a container log they will never read.
    """
    import base64
    from app import doc_extract

    # 1. OCR, locally. Best case for a photographed document — it is the
    #    document's own words rather than a model's description of them.
    if settings_store.get("attachments.ocr_enabled"):
        try:
            raw = base64.b64decode(a.data, validate=True)
            text, _src = await doc_extract.extract_image(raw, a.name)
            return _attached_block(a.name, text, "ocr"), ""
        except (doc_extract.Unsupported, doc_extract.Unextractable) as e:
            # not fatal: a photo of a dog has no text and does not need any
            log.info("no OCR text from %s: %s", a.name, e)
        except Exception:
            log.exception("OCR failed on %s", a.name)

    # 2. A vision model, if the operator configured one. Local or cloud —
    #    their choice — but a cloud one is REFUSED unless they turned cloud
    #    vision on, because this is the path that can put a photograph of a
    #    letter on someone else's server (vision._refuse_cloud).
    from app import vision
    if str(settings_store.get("attachments.vision_model") or "").strip():
        try:
            text = await vision.read_image(a.data, a.mime, name=a.name)
            return _attached_block(a.name, text, "vision"), ""
        except vision.VisionEmpty as e:
            log.info("%s", e)
        except vision.VisionUnavailable as e:
            # the operator's own configuration is refusing — say which, in
            # the reply, not only in a log they will never open
            log.warning("vision unavailable for %s: %s", a.name, e)
            return (f"\n\n--- attached image: {a.name} ---\n"
                    f"[YOU DID NOT RECEIVE THIS IMAGE and no text was read "
                    f"from it: {e}. Do not describe or interpret it. Say you "
                    f"could not see it and state that reason.]"), str(e)
        except Exception:
            log.exception("vision read failed for %s", a.name)

    # 3. Otherwise the answering model has to look. Ask whether it CAN.
    if not await _model_can_see(model):
        vision_model = str(settings_store.get("attachments.vision_model") or "").strip()
        hint = ("Set a vision model in Settings → Attachments"
                if not vision_model else
                f"'{vision_model}' is configured but is not answering this turn")
        note = (f"{a.name} was NOT read: {model} cannot see images. {hint}.")
        log.warning("image attachment unread: %s", note)
        # stated to the model, so it cannot answer from the filename alone
        return (f"\n\n--- attached image: {a.name} ---\n"
                f"[YOU DID NOT RECEIVE THIS IMAGE. The model running this "
                f"turn ({model}) has no vision capability, and OCR found no "
                f"text in it. Do not describe or interpret it. Say that you "
                f"could not see it.]"), note
    return "", ""


def _attached_block(name: str, text: str, source: str) -> str:
    """One attachment's text, labelled with HOW it was read.

    The label is not decoration. `mechanical` text is the document's own text
    layer; `ocr` text is tesseract's reading of pixels, which is usually right
    and is wrong in specific ways — a misread digit in an account number, a
    two-column page linearised into nonsense, a signature rendered as noise.
    A model told only "here is the document" will quote an OCR'd figure with
    the same confidence as a typed one. Telling it which it has is the only
    thing that lets it hedge where hedging is correct, and it costs one line.
    """
    note = ("" if source == "mechanical" else
            " (read by OCR from a scan or photograph — the text may contain "
            "recognition errors, so quote exact figures and identifiers with "
            "that caveat)")
    return f"\n\n--- attached file: {name}{note} ---\n{text}"


# ONE TURN AT A TIME, PER CONVERSATION.
#
# Nothing serialized turns until now. MEASURED 2026-08-04: turn a6630aee ran
# 57.8s on conversation ec3a4260 while two other turns started AND finished
# inside it — three concurrent turns, rows interleaving by created_at, an
# "ACK" landing between a question and its answer 49 seconds later. Worse
# than the display: each later turn snapshots history (below) while the
# earlier one is still generating, so it sees the operator's previous
# message with no reply after it and answers BOTH. That is one of the three
# routes to the merged reply he reported.
#
# `busy` in ChatPanel is not this control. It is component state: it dies on
# unmount, and it does not exist across surfaces — the phone on :8080 and the
# desktop on :5173 are two clients with no shared flag, hitting one backend.
# A control the client holds is a request, not an enforcement.
#
# In-process, deliberately. A DB advisory lock is the cross-backend answer,
# but session-scoped locks pin a pooled connection for the whole turn and
# xact-scoped ones need a transaction held just as long — both trade a rare
# correctness win for pool exhaustion on every turn. Chat from every surface
# reaches one backend container today; when that stops being true this
# becomes an advisory lock and the shape here does not change.
_turn_locks: dict[str, asyncio.Lock] = {}


def _turn_lock(conversation_id: str) -> asyncio.Lock:
    """The lock for one conversation, created on first use.

    Not evicted: conversations are a handful of rows and an asyncio.Lock is
    tiny, so a reaper would be more code than the leak it prevents.
    """
    lock = _turn_locks.get(conversation_id)
    if lock is None:
        lock = _turn_locks[conversation_id] = asyncio.Lock()
    return lock


@router.post("/api/v1/chat/stream")
async def chat_stream(request: ChatRequest):
    if not request.message.strip() and not request.attachments:
        raise HTTPException(status_code=400, detail="message is empty")

    conversation = await conversations.get_or_create_active_conversation()
    conversation_id = conversation["id"]

    main_agent = await agent_registry.get_agent_by_name("main")
    if not main_agent:
        raise HTTPException(status_code=500, detail="main agent missing from registry")

    # Voice-initiated turns: (1) may answer with a dedicated model (Settings →
    # Voice → "Voice reply model"); (2) get the brevity block appended at the
    # END of the assembled prompt (system_suffix), since the reply is read
    # ALOUD. Shallow-copy so the registry dict is never mutated.
    # who's speaking (docs/plans/speaker-id.md) — the client echoes what
    # transcribe reported. Resolution can only narrow: an unknown voice gets
    # the guest tier; typed chat has no voice signal and is the operator by
    # definition; a stale/bad profile id degrades to unknown, never operator.
    speaker = None
    if request.source == "voice" and request.speaker:
        if request.speaker == "unknown":
            speaker = {"id": None, "name": "unknown voice", "role": "unknown"}
        else:
            prof = await voiceprints.get(request.speaker)
            if prof:
                speaker = {"id": prof["id"], "name": prof["name"],
                           "role": prof["role"],
                           "persona_notes": prof.get("persona_notes")}
            else:
                speaker = {"id": None, "name": "unknown voice", "role": "unknown"}

    voice_suffix = None
    if request.source == "voice":
        voice_suffix = _VOICE_BREVITY
        override = settings_store.get("voice.model_override")
        if override:
            main_agent = {**main_agent, "model": override}
        # A spoken reply is one or two sentences; thinking before it is
        # mostly latency on the most latency-sensitive path there is
        # (measured: 1.0s vs 2.2s for the same answer). Voice gets its own
        # setting because it shares the main agent's ROW but not its job.
        voice_thinking = settings_store.get("voice.thinking") or "auto"
        if voice_thinking != "auto":
            main_agent = {**main_agent, "thinking": voice_thinking}

    model_eff = agent_runner.resolve_agent_model(main_agent)
    # A share of the window this call will ACTUALLY get, which for a local
    # model is measured per model. The two `context.budget_*` settings this
    # replaces were absolute token counts split by provider, and both went
    # stale the moment a window changed. The reserve for system prompt,
    # memory, skills and summary is the remaining fraction now, rather than a
    # second hand-tuned number subtracted from the first.
    from app.agents import context_trim
    history_budget = context_trim.history_budget_for(model_eff)

    # Attachments ride THIS turn only as full content — images as image_url
    # content parts, text files inlined into the turn's text — so the model
    # sees them now. What gets PERSISTED (and shown in the chat bubble) is
    # just the typed message plus a "[Attached …: name]" marker; the full
    # text/pixels don't resurface in later turns' replayed history. Nothing
    # binary is stored in the DB.
    user_text = request.message
    turn_extra_text = ""
    image_parts: list[dict] = []
    attach_meta: list[dict] = []
    if request.attachments:
        if sum(len(a.data) for a in request.attachments) > 20_000_000:
            raise HTTPException(status_code=413,
                                detail="attachments too large (20 MB per message)")
        for a in request.attachments:
            attach_meta.append({"kind": a.kind, "name": a.name, "mime": a.mime})
            if a.kind == "image":
                # A photographed DOCUMENT is text the model may not be able
                # to read. Three things can supply it and they fail
                # differently — OCR locally, a configured vision model, or
                # the answering model's own eyes — so none is assumed. See
                # _image_text.
                extra, note = await _image_text(a, model_eff)
                if extra:
                    turn_extra_text += extra
                if note:
                    attach_meta[-1]["note"] = note
                # The pixels ride along ONLY if the answering model can
                # actually see them. Sending them unconditionally is not a
                # harmless extra: measured 2026-08-01, an image part to
                # glm-5.2 returns `404 No endpoints found that support image
                # input` and kills the whole turn — including the OCR text
                # that had already been read successfully and would have
                # answered the question. A capability we cannot confirm is
                # not one we spend the turn on.
                if await _model_can_see(model_eff):
                    mime = a.mime or "image/jpeg"
                    image_parts.append(
                        {"type": "image_url",
                         "image_url": {"url": f"data:{mime};base64,{a.data}"}})
            elif a.kind == "doc":
                # A failure here is TOLD, not swallowed. An unreadable PDF
                # that silently contributes nothing leaves the model
                # answering about a document it never saw — and sounding
                # certain, because the turn text gives it no way to know a
                # file was dropped.
                import base64
                from app import doc_extract
                try:
                    raw = base64.b64decode(a.data, validate=True)
                except Exception:
                    raise HTTPException(
                        status_code=422,
                        detail=f"{a.name}: the attachment was not valid base64")
                try:
                    text, src = await doc_extract.extract_best(
                        raw, a.name, a.mime,
                        allow_ocr=bool(settings_store.get("attachments.ocr_enabled")))
                except (doc_extract.Unsupported, doc_extract.Unextractable) as e:
                    raise HTTPException(status_code=422,
                                        detail=f"{a.name}: {e}")
                attach_meta[-1]["text_source"] = src
                turn_extra_text += _attached_block(a.name, text, src)
            else:
                turn_extra_text += _attached_block(
                    a.name, a.data[:60_000], "mechanical")
    if not user_text.strip() and image_parts:
        user_text = "(see attached image)"
    persist_text = user_text + "".join(
        f"\n[Attached {'image' if m['kind'] == 'image' else 'file'}: {m['name']}]"
        for m in attach_meta)

    turn_text = user_text + turn_extra_text
    turn_content = ([{"type": "text", "text": turn_text}] + image_parts
                    if image_parts else turn_text)

    # ── the serialized section ─────────────────────────────────────────────
    # Everything from here to the assistant row is one turn's worth of state:
    # snapshot history, write the question, answer it. Taken AFTER attachment
    # extraction on purpose — that part can raise 422 and can take seconds on
    # a scanned PDF, and neither is a reason to make another surface wait.
    #
    # Bounded, and it proceeds rather than refusing on timeout. A stuck turn
    # must not become "Nova stopped accepting messages"; the overlap this
    # prevents is bad, a swallowed message is worse. Derived from the same
    # setting evals/suites.py already treats as how long a turn may run.
    _lock = _turn_lock(conversation_id)
    _wait_s = float(settings_store.get("automations.run_timeout_seconds") or 300)
    _held = False
    if _lock.locked():
        log.info("chat turn queued behind one already running on %s",
                 conversation_id)
    try:
        await asyncio.wait_for(_lock.acquire(), timeout=_wait_s)
        _held = True
    except asyncio.TimeoutError:
        log.warning("turn lock on %s not released within %ss — proceeding "
                    "unserialized rather than dropping the message",
                    conversation_id, _wait_s)

    try:
        # user/assistant only: tool rows are an audit trail the LLM never
        # replays (to_llm_history drops them anyway), and letting them occupy
        # the row cap is what starved the window to a third of history_budget.
        #
        # UNDER THE LOCK. This snapshot is the thing concurrency corrupts:
        # read while an earlier turn is still generating, it lacks that
        # turn's answer, so this turn sees an unanswered question and merges.
        history = await conversations.load_history(
            conversation_id, roles=("user", "assistant"))
        window, _aged = conversations.window_history(history, history_budget)
        window_oldest_at = window[0]["created_at"] if window else None

        # Replay what actually RAN in each past turn alongside what was said.
        # Without it she sees only her own prose across turns, which is how she
        # promised to "dig deeper" four times after list_egress had already
        # returned, and how a read_memory_item result she never called got
        # reported as fact.
        _first = next((m["created_at"] for m in window if m.get("created_at")), None)
        _activity = await conversations.load_tool_activity(conversation_id, _first)
        replayed = conversations.to_llm_history(window, _activity)
        turn_messages = replayed + [{"role": "user", "content": turn_content}]

        user_meta: dict = {}
        if attach_meta:
            user_meta["attachments"] = attach_meta
        if speaker:
            user_meta["speaker"] = {"id": speaker["id"], "name": speaker["name"],
                                    "role": speaker["role"]}
        # Written under the lock, so the question can never land in the middle
        # of the previous turn's rows — which is how "ACK" came to sit between
        # a question and the answer to it.
        user_message_id = await conversations.append_message(
            conversation_id, "user", persist_text,
            metadata=user_meta or None)
        # Bind the kept originals to the turn that carried them. Provenance
        # only — the bytes were already safe before this request started,
        # which is the point of uploading separately — but without it
        # `attachments.message_id` is never written by anything, and "which
        # conversation was that letter from?" has no answer at all.
        if request.attachment_ids:
            from app import attachments as attachment_store
            await attachment_store.attach_to_message(
                request.attachment_ids, user_message_id)
    except BaseException:
        # Nothing downstream will run, so this is the only release path left.
        if _held:
            _lock.release()
        raise

    async def generate():
        final_text = ""
        # Everything that actually reached the client, accumulated as it
        # streams. `final_text` is assigned ONLY from the terminal `final`
        # event, so a turn cancelled mid-generation had an empty string to
        # persist — the reply the operator was watching appear existed
        # nowhere but on their screen. See the CancelledError arm below.
        streamed = ""
        # A turn that dies used to persist NOTHING: the SSE error card is
        # live-only, so after a reload the user's message sat alone with no
        # reply and no reason. That is the literal shape of "it just quits
        # without telling us" — the telling did happen, it just wasn't kept.
        turn_error = ""
        # what ACTUALLY generated, which the binding only predicts — a
        # fallback mid-turn moves it (runner yields a `model` event)
        ran_model = model_eff
        # one ledger trace per chat turn — spans land from run_agent's
        # instrumentation; the assistant message is stamped with the trace id,
        # and meta carries it so the live turn's inspector chip needs no lookup
        async with trace.turn("chat", conversation_id=conversation_id,
                              model=model_eff) as turn:
            yield _sse({"meta": {"conversation_id": conversation_id,
                                 "model": model_eff,
                                 "trace_id": str(turn.id)}})
            # held by name so the finally can close it deterministically
            events = agent_runner.run_agent(
                main_agent, turn_messages,
                conversation_summary=conversation.get("summary"),
                system_suffix=voice_suffix, speaker=speaker,
                history_count=len(replayed),
                conversation_id=conversation_id)
            try:
                async for event in events:
                    etype = event["type"]
                    if etype == "text":
                        streamed += event["text"]
                        yield _sse({"t": event["text"]})
                    elif etype == "sub_text":
                        # a specialist's live thinking (turn-speed phase 5).
                        # Its own key, and deliberately NOT persisted: at
                        # ~10 deltas/s a long dispatch would insert thousands
                        # of message rows into a table nothing prunes. (It no
                        # longer evicts real history — load_history takes its
                        # row cap over user/assistant rows only — but the
                        # bloat reason stands on its own.)
                        yield _sse({"sub": event["text"],
                                    "agent": event.get("agent")})
                    elif etype == "activity":
                        # `args` is additive (parallel tool results carry the
                        # brief so simultaneous same-name lines are
                        # distinguishable); old clients ignore unknown keys
                        # `retract` unwinds deltas the client already drew:
                        # a narration retry discards the draft it is
                        # complaining about, and that draft is already on
                        # screen. Keep `streamed` in step so an interrupted
                        # turn persists what is actually visible.
                        if event.get("retract"):
                            streamed = streamed[:-int(event["retract"])] \
                                if int(event["retract"]) <= len(streamed) else ""
                        yield _sse({"activity": {k: event.get(k) for k in
                                                 ("kind", "name", "agent",
                                                  "args", "detail", "retract")}})
                        # persist tool activity as an audit row (fire and forget)
                        # Stamped with the turn. Only assistant rows carried a
                        # trace_id, so a tool row could be attributed to a turn
                        # only by timestamp — and these are written
                        # fire-and-forget, so they can land after the row they
                        # belong to. Serialization now keeps the ordering
                        # honest, but "which turn ran this tool" should be a
                        # recorded fact rather than something reconstructed
                        # from clocks.
                        bg.spawn(conversations.append_message(
                            conversation_id, "tool",
                            content=(event.get("detail") or "")[:2000],
                            tool_calls={"kind": event.get("kind"),
                                        "name": event.get("name"),
                                        "agent": event.get("agent")},
                            metadata={"trace_id": str(turn.id)}))
                    elif etype == "model":
                        # the turn moved to another model before its first
                        # byte. Restamp the trace and tell the client, so the
                        # ledger and the header agree with the reroute note
                        # the operator can already read in the reply.
                        ran_model = event["model"]
                        turn.model = ran_model
                        yield _sse({"meta": {"model": ran_model}})
                    elif etype == "final":
                        final_text = event["text"]
                    elif etype == "error":
                        # A SPECIALIST'S failure is not this turn's failure.
                        # `scope: dispatch` is stamped at the sub-agent
                        # boundary (runner._from_sub); the parent already has
                        # the same text as the dispatch's tool result and
                        # routinely answers around it — "ingestion is
                        # unavailable, here is what I have from memory". Left
                        # untagged, a complete answer was stored with "[This
                        # turn stopped before finishing: ...]" appended, and
                        # since assistant rows are replayed by to_llm_history
                        # every later turn read that her own last answer had
                        # been cut off. The turn ledger recorded it failed
                        # too, so observability counted finished turns as
                        # failures.
                        #
                        # Still yielded: the operator sees the specialist
                        # failed. Only `turn_error`/`set_error` — the two
                        # things that speak for the WHOLE turn — are withheld.
                        if event.get("scope") != "dispatch":
                            turn_error = str(event["error"])
                            turn.set_error(event["error"])
                        yield _sse({"error": event["error"],
                                    "scope": event.get("scope"),
                                    "agent": event.get("agent")})
            except asyncio.CancelledError:
                # THE INTERRUPTED TURN. A disconnect (navigate away, Stop,
                # interject, barge-in) cancels this generator while it is
                # suspended at a yield. CancelledError is a BaseException, so
                # it walks straight past the handler below, past
                # trace.turn's `raise`, and out of generate() — skipping the
                # persist block after this `async with` entirely.
                #
                # The cost is not just a missing row. With no assistant row
                # the user's message stays unanswered FOREVER, and
                # to_llm_history replays it next turn followed immediately
                # by the new question — two consecutive user turns — so she
                # answers both at once. That is the merged reply Jeremy
                # reported on 2026-08-04, and 21 cancelled traces plus 66
                # consecutive-user pairs say it has been happening all along.
                #
                # bg.spawn, not await: our own cancel scope is dead, so every
                # await here would raise immediately. A detached task is
                # outside that scope and can finish the write. Same reasoning
                # as _cancel_and_drain in the runner.
                partial = streamed.strip()
                if partial:
                    bg.spawn(conversations.append_message(
                        conversation_id, "assistant",
                        partial + "\n\n[This turn was interrupted before it "
                                  "finished, so this reply is incomplete.]",
                        ran_model, metadata={"trace_id": str(turn.id),
                                             "interrupted": True}),
                        name="persist-interrupted-turn")
                else:
                    # Nothing had generated yet. Still mark the turn, or the
                    # question sits alone and the next one absorbs it.
                    bg.spawn(conversations.append_message(
                        conversation_id, "assistant",
                        "[This turn was interrupted before it produced a "
                        "reply.]", ran_model,
                        metadata={"trace_id": str(turn.id),
                                  "interrupted": True}),
                        name="persist-interrupted-turn")
                raise
            except Exception as e:
                log.exception("chat stream failed")
                turn_error = str(e)
                turn.set_error(str(e))
                yield _sse({"error": str(e)})
            finally:
                # A disconnect or interject cancels this task while the
                # runner sits suspended at a yield, so its own cleanup would
                # otherwise wait for GC finalization — a race the ledger
                # flush at the end of this trace context usually wins,
                # losing exactly the in-flight spans. Closing it here runs
                # the runner's cancellation contract (cancel-and-AWAIT the
                # round's tool tasks, stamp their spans cancelled) first.
                await events.aclose()

        # Say what happened, in the transcript, where the question is.
        # Phrased as a record of this turn rather than an instruction,
        # because to_llm_history replays assistant rows to the model next
        # turn and a bare error string reads as something to act on.
        if turn_error:
            stopped = f"[This turn stopped before finishing: {turn_error.strip()}]"
            final_text = f"{final_text.rstrip()}\n\n{stopped}" if final_text.strip() else stopped
            yield _sse({"t": ("\n\n" + stopped) if final_text != stopped else stopped})

        # SECOND FLOOR, behind the runner's. `run_agent` now guarantees a
        # non-empty final (see its `_floor` block), so this should be
        # unreachable — but the gate it replaces skipped the assistant row,
        # the journal, compaction AND the push in one silent branch, and an
        # unanswered user message with no assistant row after it is the merged
        # reply this file already carries 60 lines of comment about. A hole
        # with that blast radius does not get to rely on another module
        # holding. Same shape as the interrupted-turn placeholder above:
        # persist a stated failure, never the empty string.
        if not final_text.strip():
            log.warning("turn %s produced no text and no error — persisting a "
                        "stated failure rather than nothing", turn.id)
            final_text = ("[This turn produced no reply, and no error was "
                          "reported. Nothing was done.]")
            yield _sse({"t": final_text})

        if final_text.strip():
            try:
                await conversations.append_message(
                    conversation_id, "assistant", final_text, ran_model,
                    metadata={"trace_id": str(turn.id)})
                # non-operator speakers journal under their own name — what
                # the kid says must never file as the operator's words
                if speaker and speaker["role"] != "operator":
                    who = f"«{speaker['name']}» ({speaker['role']})"
                    await memory.write(
                        f"{who}: {persist_text}\n\nNova: {final_text}",
                        type="journal", source_type="chat",
                        author=speaker["name"])
                else:
                    await memory.write(
                        f"User: {persist_text}\n\nNova: {final_text}",
                        type="journal", source_type="chat")
            except Exception:
                # The operator has already READ this answer — it streamed. If
                # it never reached the database, the next turn will not have
                # it and neither will the transcript, so the conversation
                # quietly loses a turn that visibly happened. Say so on the
                # stream while the answer is still on screen.
                log.exception("failed to persist assistant turn")
                turn.set_error("assistant turn not persisted")
                yield _sse({"activity": {
                    "kind": "degraded", "name": "persistence",
                    "detail": ("this reply could not be saved — it will be "
                               "missing from the conversation after a "
                               "reload")}})
            bg.spawn(compaction.maybe_compact(
                conversation_id, main_agent["model"], window_oldest_at))
            # long turns push "Nova replied" when they finish — the device
            # itself suppresses it while the app is on screen (push-sw.js),
            # so it only lands when the operator walked away
            try:
                from datetime import datetime, timezone
                min_secs = int(settings_store.get("notify.push_reply_min_secs") or 0)
                secs = (datetime.now(timezone.utc) - turn.started_at).total_seconds()
                if secs >= min_secs:
                    from app import notify
                    bg.spawn(notify.send(
                        final_text[:120], title="Nova replied", click="/chat"))
            except Exception:
                log.exception("reply-push scheduling failed")

        yield "data: [DONE]\n\n"

    async def streamed_turn():
        """generate(), plus the release of the turn lock.

        A wrapper rather than a try/finally inside generate() so the release
        lives in one place and cannot be missed by a future early return. The
        finally runs on all three exits — normal completion, an exception,
        and the aclose() Starlette performs on client disconnect — and that
        third one is the path that matters, since disconnect is how turns
        actually end here.
        """
        try:
            async for chunk in generate():
                yield chunk
        finally:
            if _held:
                _lock.release()

    return StreamingResponse(streamed_turn(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.get("/api/v1/conversations/active")
async def get_active_conversation():
    return await conversations.get_or_create_active_conversation()


@router.get("/api/v1/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str, before: str | None = None,
                       limit: int = 100):
    """User/assistant turns plus the persisted activity trail (tool rows) —
    the UI shows past turns' actions as a dim, collapsible trace. Assistant
    rows carry their turn-ledger summary (duration, tool count) when one
    exists, feeding the duration chip → Turn Inspector.

    TWO QUERIES, ONE BUDGET EACH. This used to be a single
    load_history(limit=100) with no `roles` filter, so the LIMIT applied
    across all roles and the activity trail evicted the conversation:
    measured 2026-08-05 on the live DB, the 100 rows came back 28 user / 26
    assistant / 46 tool, and the visible transcript stopped a day and a half
    short of where the history actually started. 17 of Jeremy's 45 messages
    were unreachable, which is what "my messages were no longer to be found
    in the chat window" was. It got worse as she used more tools.

    The split is the same one load_history's own docstring prescribes and
    load_tool_activity already applies on the LLM path; the endpoint just
    never took it, because it wants the tool rows too. So: the transcript
    gets a row budget, the trail gets its own, and neither can starve the
    other.

    PAGED, AND HONEST ABOUT IT. Returns an object rather than a bare array:
    `has_more` says whether older turns exist beyond this page and `before`
    walks back through them. A window that just ends is indistinguishable
    from a conversation that started there — which is how 17 unreachable
    messages went unnoticed until someone went looking for one of them."""
    limit = max(1, min(500, limit))
    # Asking for one extra row IS the has_more test — cheaper than a separate
    # COUNT(*), and it cannot disagree with the page the way a count taken at
    # a different instant can.
    page = await conversations.load_history(
        conversation_id, limit=limit + 1, roles=("user", "assistant"),
        before=before)
    has_more = len(page) > limit
    history = page[-limit:] if has_more else page
    # Bounded by the transcript, not by a count of its own: activity older
    # than the oldest visible turn has nothing to attach to.
    oldest = next((m["created_at"] for m in history if m.get("created_at")), None)
    newest = next((m["created_at"] for m in reversed(history)
                   if m.get("created_at")), None)
    if oldest:
        tool_rows = [m for m in await conversations.load_history(
                         conversation_id, limit=300, roles=("tool",),
                         before=before)
                     if m.get("created_at") and m["created_at"] >= oldest
                     and (newest is None or m["created_at"] <= newest)]
        # (created_at, id) — created_at ties are real (an assistant row and
        # its narration warning share a microsecond), and a tie that sorts
        # differently on each reload moves the trail between messages.
        history = sorted(history + tool_rows,
                         key=lambda m: (m["created_at"] or "", m["id"]))
    out = []
    trace_ids: dict[str, list[dict]] = {}   # trace_id -> messages wearing it
    for m in history:
        if m["role"] in ("user", "assistant") and m["content"]:
            row = {"id": m["id"], "role": m["role"], "content": m["content"],
                   "created_at": m["created_at"]}
            meta = m.get("metadata")
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except ValueError:
                    meta = {}
            tid = (meta or {}).get("trace_id")
            if m["role"] == "assistant" and tid:
                trace_ids.setdefault(tid, []).append(row)
            if (meta or {}).get("attachments"):
                row["attachments"] = meta["attachments"]
            if (meta or {}).get("speaker"):
                row["speaker"] = meta["speaker"]
            out.append(row)
        elif m["role"] == "tool" and m["tool_calls"]:
            tc = m["tool_calls"]
            if isinstance(tc, str):
                try:
                    tc = json.loads(tc)
                except ValueError:
                    continue
            # The turn this ran in, so the UI can file it under that turn's
            # reply instead of under whatever message happens to sit next to
            # it in the row order. Null on rows written before tool rows were
            # stamped; the client keeps its positional fallback for those.
            tmeta = m.get("metadata")
            if isinstance(tmeta, str):
                try:
                    tmeta = json.loads(tmeta)
                except ValueError:
                    tmeta = {}
            out.append({"id": m["id"], "role": "tool", "content": m["content"] or "",
                        "created_at": m["created_at"], "tool_calls": tc,
                        "trace_id": (tmeta or {}).get("trace_id")})
    if trace_ids:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                """SELECT t.id, t.status,
                          extract(epoch FROM t.finished_at - t.started_at) AS secs,
                          count(s.id) FILTER (WHERE s.kind = 'tool')     AS tools,
                          count(s.id) FILTER (WHERE s.kind = 'dispatch') AS dispatches
                   FROM turn_traces t
                   LEFT JOIN turn_spans s ON s.trace_id = t.id
                   WHERE t.id = ANY($1::uuid[])
                   GROUP BY t.id""",
                list(trace_ids.keys()))
        for r in rows:
            summary = {"id": str(r["id"]), "status": r["status"],
                       "secs": round(float(r["secs"]), 2) if r["secs"] is not None else None,
                       "tools": r["tools"], "dispatches": r["dispatches"]}
            for row in trace_ids[str(r["id"])]:
                row["trace"] = summary
    # `oldest` is the cursor for the next page — the client hands it straight
    # back as `before` rather than deriving it from the rows, so the two can
    # never disagree about where this page began.
    return {"messages": out, "has_more": has_more, "oldest": oldest}


@router.get("/api/v1/traces")
async def list_traces(limit: int = 50):
    """Recent turn traces across ALL sources (chat, automations,
    compaction) — the Settings → Observability "Recent turns" list.
    Automations show up here with no chat message to click."""
    limit = max(1, min(200, limit))
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT t.id, t.source, t.automation, t.model, t.status,
                      t.started_at,
                      extract(epoch FROM t.finished_at - t.started_at) AS secs,
                      count(s.id) FILTER (WHERE s.kind = 'tool')     AS tools,
                      count(s.id) FILTER (WHERE s.kind = 'dispatch') AS dispatches,
                      count(s.id) FILTER (WHERE s.kind = 'llm_call') AS llm_calls
               FROM turn_traces t
               LEFT JOIN turn_spans s ON s.trace_id = t.id
               GROUP BY t.id
               ORDER BY t.started_at DESC
               LIMIT $1""", limit)
    return [{
        "id": str(r["id"]), "source": r["source"], "automation": r["automation"],
        "model": r["model"], "status": r["status"],
        "started_at": r["started_at"].isoformat(),
        "secs": round(float(r["secs"]), 2) if r["secs"] is not None else None,
        "tools": r["tools"], "dispatches": r["dispatches"],
        "llm_calls": r["llm_calls"],
    } for r in rows]


@router.get("/api/v1/traces/{trace_id}")
async def get_trace(trace_id: str):
    """One turn's full ledger: the trace row + its spans in order — the
    Turn Inspector's data source."""
    try:
        tid = uuid.UUID(trace_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="trace not found")
    async with db.acquire() as conn:
        t = await conn.fetchrow("SELECT * FROM turn_traces WHERE id = $1", tid)
        if not t:
            raise HTTPException(status_code=404, detail="trace not found")
        spans = await conn.fetch(
            "SELECT * FROM turn_spans WHERE trace_id = $1 ORDER BY seq", tid)
    return {
        "trace": {
            "id": str(t["id"]), "source": t["source"],
            "automation": t["automation"],
            "conversation_id": str(t["conversation_id"]) if t["conversation_id"] else None,
            "model": t["model"], "status": t["status"], "error": t["error"],
            "started_at": t["started_at"].isoformat(),
            "finished_at": t["finished_at"].isoformat() if t["finished_at"] else None,
        },
        "spans": [{
            "id": str(s["id"]),
            "parent_span_id": str(s["parent_span_id"]) if s["parent_span_id"] else None,
            "seq": s["seq"], "kind": s["kind"], "name": s["name"],
            "status": s["status"],
            "started_at": s["started_at"].isoformat(),
            "finished_at": s["finished_at"].isoformat() if s["finished_at"] else None,
            "detail": json.loads(s["detail"]) if isinstance(s["detail"], str)
                      else (s["detail"] or {}),
        } for s in spans],
    }


@router.get("/api/v1/agents")
async def list_agents_endpoint():
    return await agent_registry.list_agents(enabled_only=False)


@router.get("/api/v1/agents/model-chains")
async def agent_model_chains_endpoint():
    """Each agent's standby order, derived — so the UI never restates it.

    The order used to be a sentence typed into AgentsTab.tsx. A hand-copied
    restatement of runner's chain in another language starts lying the day the
    chain changes, and nothing fails when it does.

    Both lookups are hoisted: model_fitness.rank_local() issues one /api/tags
    plus a POST /api/show PER INSTALLED MODEL with no caching, so leaving them
    to each agent turns one page load into twelve probe rounds.
    """
    from app import curated_models, model_chain, model_fitness
    agents = await agent_registry.list_agents(enabled_only=False)
    curated = await curated_models.list_all(enabled_only=True)
    try:
        local_rank = await model_fitness.rank_local()
    except Exception:  # noqa: BLE001 — ollama being down must not blank the page
        log.debug("rank_local failed while building chains", exc_info=True)
        local_rank = []
    return {a["id"]: await model_chain.chain(a, curated=curated,
                                             local_rank=local_rank)
            for a in agents}


_AGENT_EDITABLE_FIELDS = {"model", "enabled", "description", "system_prompt",
                          "allowed_tools", "routing_keywords", "thinking",
                          "fallback_model"}


@router.patch("/api/v1/agents/{agent_id}")
async def patch_agent_endpoint(agent_id: str, body: dict):
    allowed = {k: v for k, v in body.items() if k in _AGENT_EDITABLE_FIELDS}
    if not allowed:
        raise HTTPException(status_code=422, detail="no editable fields provided")
    if allowed.get("enabled") is False:
        target = next((a for a in await agent_registry.list_agents(enabled_only=False)
                       if a["id"] == agent_id), None)
        if target and target["is_system"]:
            raise HTTPException(
                status_code=403,
                detail="system agents are always active — constrain them with "
                       "rules and tool grants instead")
    if allowed.get("thinking") not in (None, "auto", "on", "off"):
        raise HTTPException(status_code=422,
                            detail="thinking must be 'auto', 'on', or 'off'")
    if "model" in allowed and ":" not in str(allowed["model"]):
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    if allowed.get("fallback_model"):
        # "" and null both mean "no standby of my own, use the chain" and are
        # normalised to NULL by the trigger; anything else must be addressable
        if ":" not in str(allowed["fallback_model"]):
            raise HTTPException(
                status_code=422,
                detail="fallback_model must be 'openrouter:<id>' or 'ollama:<name>'")
    for k in ("allowed_tools", "routing_keywords"):
        if k in allowed and allowed[k] is not None and not isinstance(allowed[k], list):
            raise HTTPException(status_code=422, detail=f"{k} must be a list or null")
    # operator=True: this route is the human at Settings, already past the
    # auth middleware. The is_system guard in the registry exists to stop the
    # MODEL rewriting a system agent, not the owner.
    ok = await agent_registry.update_agent(agent_id, operator=True, **allowed)
    if not ok:
        raise HTTPException(status_code=404, detail="agent not found")
    # A model change gets its fitness reported back, never blocked. These are
    # facts with a stated basis — no tool support, a window smaller than this
    # agent's measured prompts — and the operator may have a reason. Applied
    # first so the answer describes what is now live, and non-fatal: a
    # metadata probe must not fail a successful write.
    warnings: list[dict] = []
    if "model" in allowed:
        try:
            from app import model_fitness
            warnings = await model_fitness.assess_for_agent(agent_id)
        except Exception:  # noqa: BLE001
            log.debug("fitness check failed after agent update", exc_info=True)
    return {"status": "updated", "warnings": warnings}


@router.post("/api/v1/agents", status_code=201)
async def create_agent_endpoint(body: dict):
    name = str(body.get("name", "")).strip()
    description = str(body.get("description", "")).strip()
    system_prompt = str(body.get("system_prompt", "")).strip()
    model = str(body.get("model", "")).strip()
    if not name or not system_prompt or not model:
        raise HTTPException(status_code=422,
                            detail="name, system_prompt, and model are required")
    if ":" not in model:
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    fallback_model = str(body.get("fallback_model") or "").strip() or None
    if fallback_model and ":" not in fallback_model:
        raise HTTPException(
            status_code=422,
            detail="fallback_model must be 'openrouter:<id>' or 'ollama:<name>'")
    try:
        # operator=True for the same reason the PATCH route says so: this is
        # the human at Settings, already past the auth middleware.
        agent_id = await agent_registry.create_agent(
            name=name, description=description, system_prompt=system_prompt,
            model=model, allowed_tools=body.get("allowed_tools"),
            routing_keywords=body.get("routing_keywords"),
            operator=True, fallback_model=fallback_model)
    except Exception as e:  # duplicate name etc.
        raise HTTPException(status_code=422, detail=str(e))
    return {"id": agent_id, "name": name}


@router.delete("/api/v1/agents/{agent_id}")
async def delete_agent_endpoint(agent_id: str):
    result = await agent_registry.delete_agent(agent_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="agent not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system agents can be disabled but never deleted")
    return {"status": "deleted"}


@router.get("/api/v1/models")
async def list_models_endpoint(full: bool = False):
    """Filtered (default): installed local models + approved (curated) cloud
    models. full=true: everything from authenticated providers. Providers
    without credentials never appear in either view."""
    from app import models_catalog
    return await models_catalog.list_models(full=full)


@router.get("/api/v1/models/capabilities")
async def model_capabilities_endpoint():
    """What the LOCAL server says each installed model can do.

    The UI uses this to decide whether to offer a thinking toggle at all.
    Nothing infers capability from a model's name — this is the server's
    own answer, cached, and a model it cannot describe simply gets no
    entry rather than a guess.
    """
    from app.llm import capabilities as caps
    from app import models_catalog
    out: dict[str, list[str]] = {}
    for m in await models_catalog.list_models():
        if m.get("provider") != "ollama":
            continue
        found = await caps.capabilities(m["id"])
        if found:
            out[m["id"]] = sorted(found)
    return out


@router.post("/api/v1/models/pull")
async def pull_model_endpoint(body: dict):
    """Pull a new Ollama model — proxies Ollama's native /api/pull, streaming
    progress as SSE. Nova downloads its own local models; no CLI needed."""
    import httpx
    from app import models_catalog

    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="model name is required")
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{base}/api/pull",
                                         json={"name": name}) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")[:200]
                        yield _sse({"error": f"pull failed: {detail}"})
                        return
                    async for line in resp.aiter_lines():
                        if line.strip():
                            yield f"data: {line}\n\n"
        except httpx.HTTPError as e:
            yield _sse({"error": f"cannot reach Ollama at {base}: {e}"})
            return
        models_catalog.invalidate()
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── model recommendations (designed 2026-07-14) ──────────────────────────

@router.get("/api/v1/hardware")
async def hardware_endpoint():
    from app import hardware
    return await hardware.detect()


@router.get("/api/v1/models/recommendations")
async def model_recommendations_endpoint(mode: str = "hybrid"):
    """mode = hybrid (default) | local (self-hosted only) | cloud (prefer cloud,
    local fallback only where no configured provider serves a role)."""
    from app import model_recs
    return await model_recs.recommendations(mode=mode)


@router.get("/api/v1/models/budget")
async def model_budget_endpoint():
    """Concurrent-load math for the CURRENT assignments — what memory looks
    like if every assigned local model is loaded at once."""
    from app import model_recs
    return await model_recs.current_budget()


@router.post("/api/v1/models/test")
async def model_test_endpoint(body: dict):
    """Probe a model on this machine: TTFT/tok_s plus a mechanically verified
    tool call. Never pulls — an uninstalled model comes back as an error."""
    from app import model_recs
    model = str(body.get("model", "")).strip()
    if ":" not in model:
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    return await model_recs.probe(model)


@router.get("/api/v1/models/curated")
async def list_curated_endpoint():
    from app import curated_models
    return await curated_models.list_all()


@router.post("/api/v1/models/curated", status_code=201)
async def create_curated_endpoint(body: dict):
    from app import curated_models
    try:
        return await curated_models.create(
            model=str(body.get("model", "")),
            provider=str(body.get("provider", "")),
            **{k: body[k] for k in
               ("min_ram_gb", "min_vram_gb", "tool_tier", "speed", "roles",
                "use_cases", "notes")
               if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # duplicate model etc.
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/models/curated/{row_id}")
async def patch_curated_endpoint(row_id: str, body: dict):
    from app import curated_models
    try:
        result = await curated_models.update(row_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="curated model not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="seeded rows can be toggled but not rewritten")
    return {"status": "updated"}


@router.delete("/api/v1/models/curated/{row_id}")
async def delete_curated_endpoint(row_id: str):
    from app import curated_models
    result = await curated_models.delete(row_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="curated model not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="seeded rows can be disabled but not deleted")
    return {"status": "deleted"}


# ── LLM providers (Settings → Models → Providers) — bring-your-own key /
#    endpoint registry. Operator-only; agents never touch provider config.
#    API keys are stored server-side and NEVER returned (the list is redacted
#    to key_set + last-4). ─────────────────────────────────────────────────

@router.get("/api/v1/providers")
async def list_providers_endpoint():
    from app.llm import providers
    return providers.list_public()


@router.get("/api/v1/providers/presets")
async def provider_presets_endpoint():
    from app.llm import providers
    return providers.PRESETS


@router.post("/api/v1/providers", status_code=201)
async def create_provider_endpoint(body: dict):
    from app.llm import providers
    try:
        return await providers.create(
            slug=str(body.get("slug", "")),
            label=str(body.get("label", "")),
            base_url=str(body.get("base_url", "")),
            **{k: body[k] for k in
               ("kind", "api_key", "extra_headers", "catalog_path",
                "needs_key", "enabled") if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/providers/{provider_id}")
async def patch_provider_endpoint(provider_id: str, body: dict):
    from app.llm import providers
    try:
        result = await providers.update(provider_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="provider not found")
    if result == "no_fields":
        raise HTTPException(status_code=422, detail="no editable fields provided")
    return {"status": "updated"}


@router.delete("/api/v1/providers/{provider_id}")
async def delete_provider_endpoint(provider_id: str):
    from app.llm import providers
    result = await providers.delete(provider_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="provider not found")
    if result == "is_system":
        raise HTTPException(
            status_code=403,
            detail="the seeded OpenRouter provider can be edited or disabled "
                   "but not deleted")
    return {"status": "deleted"}


@router.post("/api/v1/providers/{provider_id}/test")
async def test_provider_endpoint(provider_id: str):
    from app.llm import providers
    return await providers.check(provider_id)  # reaches AND stamps the health dot


# ── MCP servers (docs/plans/mcp-client.md) — operator-only registry.
#    No agent-facing tool exists here on purpose: an agent that could
#    register a server could grant itself arbitrary capabilities. ───────

@router.get("/api/v1/mcp/servers")
async def list_mcp_servers_endpoint():
    from app import mcp_servers
    return await mcp_servers.list_all()


@router.get("/api/v1/mcp/servers/{server_id}/tools")
async def list_mcp_server_tools_endpoint(server_id: str):
    from app import mcp_servers
    return await mcp_servers.list_tools_for(server_id)


@router.post("/api/v1/mcp/servers", status_code=201)
async def create_mcp_server_endpoint(body: dict):
    from app import mcp_servers
    try:
        return await mcp_servers.create(
            name=str(body.get("name", "")),
            transport=str(body.get("transport", "")),
            **{k: body[k] for k in ("url", "command", "args", "headers") if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # duplicate name etc.
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/mcp/servers/{server_id}")
async def patch_mcp_server_endpoint(server_id: str, body: dict):
    from app import mcp_servers
    try:
        result = await mcp_servers.update(server_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="MCP server not found")
    # a field change or an enable flip needs a fresh connect to take effect
    connection_fields = {"url", "command", "args", "headers", "enabled"}
    if connection_fields & set(body) and body.get("enabled", True):
        return await mcp_servers.refresh(server_id)
    return await mcp_servers.get(server_id)


@router.delete("/api/v1/mcp/servers/{server_id}")
async def delete_mcp_server_endpoint(server_id: str):
    from app import mcp_servers
    result = await mcp_servers.delete(server_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"status": "deleted"}


@router.post("/api/v1/mcp/servers/{server_id}/approve")
async def approve_mcp_server_endpoint(server_id: str):
    from app import mcp_servers
    try:
        return await mcp_servers.approve(server_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── skills (operator surface; agents use write_memory type='skill') ──────

@router.get("/api/v1/skills")
async def list_skills_endpoint():
    return await memory.list_skills()


@router.post("/api/v1/skills", status_code=201)
async def create_skill_endpoint(body: dict):
    title = str(body.get("title", "")).strip()
    content = str(body.get("content", "")).strip()
    if not title or not content:
        raise HTTPException(status_code=422, detail="title and content are required")
    result = await memory.write(
        content, type="skill", title=title,
        description=str(body.get("description", "")).strip() or None,
        category=str(body.get("category", "")).strip() or None,
        source_type="operator")
    if result.get("status") != "written":
        raise HTTPException(status_code=422, detail=result.get("error", "write failed"))
    return result


@router.put("/api/v1/skills/{skill_id:path}")
async def update_skill_endpoint(skill_id: str, body: dict):
    if not skill_id.startswith("skills/"):
        raise HTTPException(status_code=404, detail="not a skill")
    existing = await memory.read_item(skill_id)
    if not existing:
        raise HTTPException(status_code=404, detail="skill not found")
    title = str(body.get("title", "")).strip() \
        or existing["frontmatter"].get("title", skill_id)
    content = str(body.get("content", "")).strip() or existing["content"]
    result = await memory.write(
        content, type="skill", title=title, item_id=skill_id,
        description=str(body.get("description", "")).strip()
        or existing["frontmatter"].get("description"),
        category=existing["frontmatter"].get("category"),
        source_type="operator")
    if result.get("status") != "written":
        raise HTTPException(status_code=422, detail=result.get("error", "write failed"))
    return result


@router.delete("/api/v1/skills/{skill_id:path}")
async def delete_skill_endpoint(skill_id: str):
    if not skill_id.startswith("skills/"):
        raise HTTPException(status_code=404, detail="not a skill")
    if not await memory.delete_item(skill_id):
        raise HTTPException(status_code=404, detail="skill not found")
    return {"status": "deleted"}


@router.post("/api/v1/models/uninstall")
async def uninstall_model_endpoint(body: dict):
    """Remove an installed Ollama model (native /api/delete). Refuses while
    any agent or setting still points at it — uninstalling a model in use
    would break those turns at request time."""
    import httpx
    from app import models_catalog

    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="model name is required")

    model_id = f"ollama:{name}"
    users = [a["name"] for a in await agent_registry.list_agents(enabled_only=False)
             if a["model"] == model_id]
    if settings_store.get("compaction.model") == model_id:
        users.append("compaction (setting)")
    if settings_store.get("inference.local_fallback_model") == name:
        users.append("local fallback (setting)")
    if users:
        raise HTTPException(
            status_code=409,
            detail=f"'{name}' is in use by: {', '.join(users)} — reassign first")

    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request("DELETE", f"{base}/api/delete",
                                        json={"name": name})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"cannot reach Ollama: {e}")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"'{name}' is not installed")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code,
                            detail=resp.text[:200] or "uninstall failed")
    models_catalog.invalidate()
    return {"status": "uninstalled", "name": name}


@router.get("/api/v1/auth/token")
async def auth_token_endpoint():
    """The admin token, for the phone-setup QR. Reachable only by callers
    the middleware already trusts: this machine (which can read .env
    anyway) or a device that presented the token to get here."""
    return {"token": settings.nova_auth_token or ""}


@router.get("/api/v1/storage")
async def storage_info_endpoint():
    """Where memory and model weights physically live. Both are bind mounts
    resolved at container-create time — the UI can show and verify memory, but
    changing either is a deployment action by nature (.env + `docker compose
    up -d`). Model weights live on other containers, so we can only report the
    configured path, not verify it from here."""
    import os
    models_dir = _effective_models_dir()
    return {
        "host_path": os.environ.get("NOVA_MEMORY_DIR_HOST", "./data/memory"),
        "container_path": settings.okf_memory_dir,
        "writable": os.access(settings.okf_memory_dir, os.W_OK),
        "counts": await memory.stats(),
        # empty NOVA_MODELS_DIR = default docker-managed volumes; a set path
        # means the operator relocated the bundled model store (ollama/kokoro/
        # whisper subdirs) onto that host path via docker-compose.models.yml.
        "models": {
            "host_path": models_dir or None,
            "relocated": bool(models_dir),
        },
    }


# ── brain graph: memory + platform entities (the full map of what Nova IS) ─

@router.get("/api/v1/brain/graph")
async def brain_graph_endpoint(platform: bool = True):
    """Knowledge/experience (the memory graph) merged — when platform=true —
    with capabilities and behaviors as first-class nodes: agents, granted
    tools, automations, rules. Real edges only (grants, executors, guard
    targets), never decoration."""
    g = await memory.graph()
    if not platform:
        return g
    nodes, edges = g["nodes"], g["edges"]
    mem_nodes = list(nodes)   # snapshot before platform nodes join the list

    nodes.append({"id": "nova", "label": "Nova", "type": "core", "mtime": _CAP_MTIME,
                  "description": "The coordinating mind — main is the front "
                                 "door; every specialist hangs off it."})

    # The operator is a first-class node: Nova exists in relation to a person.
    # Universe draws the pair as a binary star; older themes get a color entry.
    user_name = str(settings_store.get("nova.user_name") or "").strip()
    nodes.append({"id": "user", "label": user_name or "You", "type": "user",
                  "mtime": _CAP_MTIME,
                  "description": "The operator — the human this mind works "
                                 "with. Everything here exists in orbit "
                                 "around this relationship."})
    edges.append({"source": "nova", "target": "user", "kind": "bond"})

    agents = await agent_registry.list_agents(enabled_only=False)
    catalog = await tool_registry.list_all_tools()
    db_tool_names = [t["name"] for t in catalog["db_tools"]]
    builtin_names = [b["name"] for b in catalog["builtins"]]
    tool_desc = {t["name"]: t["description"] for t in catalog["db_tools"]}
    tool_desc.update({b["name"]: b["description"] for b in catalog["builtins"]})

    granted: dict[str, list[str]] = {}  # tool name -> agent names using it
    for a in agents:
        names: list[str] = []
        for t in (a["allowed_tools"] or builtin_names):  # null grant = all builtins
            if t == "db:*":
                names.extend(db_tool_names)
            elif t.startswith("db:"):
                names.append(t[3:])
            else:
                names.append(t)
        for t in names:
            granted.setdefault(t, []).append(a["name"])

    for a in agents:
        nodes.append({"id": f"agent:{a['name']}", "label": a["name"],
                      "type": "agent", "mtime": _CAP_MTIME, "enabled": a["enabled"],
                      "description": a["description"]})
        edges.append({"source": "nova", "target": f"agent:{a['name']}",
                      "kind": "platform"})

    for tool_name, users in granted.items():
        nodes.append({"id": f"tool:{tool_name}", "label": tool_name,
                      "type": "tool", "mtime": _CAP_MTIME,
                      "description": tool_desc.get(tool_name, "")})
        for user in users:
            edges.append({"source": f"agent:{user}",
                          "target": f"tool:{tool_name}", "kind": "grant"})

    for auto in await automations.list_automations():
        nodes.append({"id": f"automation:{auto['name']}", "label": auto["name"],
                      "type": "automation", "mtime": _CAP_MTIME,
                      "enabled": auto["enabled"],
                      "interval_minutes": auto.get("interval_minutes"),
                      "description": auto.get("description")
                      or (auto.get("instruction") or "")[:200]})
        edges.append({"source": f"automation:{auto['name']}",
                      "target": f"agent:{auto['agent_name']}", "kind": "platform"})

    node_ids = {n["id"] for n in nodes}
    for r in await rules.list_rules():
        nodes.append({"id": f"rule:{r['name']}", "label": r["name"],
                      "type": "rule", "mtime": _CAP_MTIME, "enabled": r["enabled"],
                      "description": r.get("description", "")})
        for t in (r.get("target_tools") or []):
            if f"tool:{t}" in node_ids:
                edges.append({"source": f"rule:{r['name']}",
                              "target": f"tool:{t}", "kind": "guard"})
        for aname in (r.get("target_agents") or []):
            if f"agent:{aname}" in node_ids:
                edges.append({"source": f"rule:{r['name']}",
                              "target": f"agent:{aname}", "kind": "guard"})

    # relationship edges from memory frontmatter markers (#28). Personal
    # facts arc to the operator's star; automations arc to the documents
    # they maintain. Only edges whose platform endpoint actually exists —
    # a stale maintained_by (deleted automation) must not dangle.
    for n in mem_nodes:
        if n.get("about") == "user":
            edges.append({"source": n["id"], "target": "user", "kind": "about"})
        maintainer = n.get("maintained_by")
        if maintainer and f"automation:{maintainer}" in node_ids:
            edges.append({"source": f"automation:{maintainer}",
                          "target": n["id"], "kind": "writes"})

    return {"nodes": nodes, "edges": edges}


@router.get("/api/v1/memory/stats")
async def memory_stats():
    return await memory.stats()


@router.get("/api/v1/memory/graph")
async def memory_graph():
    return await memory.graph()


@router.get("/api/v1/memory/subject-affinity")
async def memory_subject_affinity():
    """Do any two clusters bind by subject strongly enough to draw?

    Deliberately its own endpoint rather than a field on /memory/graph: it
    runs 400 shuffles, and the graph is polled every 20s. Reported rather
    than rendered — the universe view draws nothing off this until `draw`
    comes back true. See app/subjects.py for why the gate is a permutation
    null and not a threshold.
    """
    from app import subjects
    g = await memory.graph()
    return subjects.affinity_report(g["nodes"], g["edges"])


@router.get("/api/v1/memory/item/{item_id:path}")
async def memory_item(item_id: str):
    item = await memory.read_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="memory item not found")
    return item


@router.delete("/api/v1/memory/item/{item_id:path}")
async def delete_memory_item(item_id: str):
    if item_id == "soul.md":
        raise HTTPException(status_code=403, detail="the soul is not deletable")
    if not await memory.delete_item(item_id):
        raise HTTPException(status_code=404, detail="memory item not found")
    return {"status": "deleted"}


# ── bundled inference (docker control via the inference-control sidecar) ─

@router.get("/api/v1/inference/bundled")
async def bundled_inference_status():
    """Container state from the sidecar + a direct API probe. Fail-soft:
    without the sidecar the UI simply hides the toggle."""
    import httpx

    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(f"{settings.inference_control_url}/status")
            resp.raise_for_status()
            status = resp.json()
        except Exception as e:
            log.warning("inference-control unreachable: %s", e)
            return {"available": False}
        api_ok = False
        if status.get("running"):
            try:
                r = await client.get(f"{settings.bundled_ollama_url}/api/tags")
                api_ok = r.status_code == 200
            except httpx.HTTPError:
                pass
    return {"available": True, "api_ok": api_ok, **status}


@router.post("/api/v1/inference/bundled")
async def bundled_inference_action(body: dict):
    import httpx
    from app import models_catalog

    action = str(body.get("action", "")).strip()
    if action not in ("start", "stop"):
        raise HTTPException(status_code=422, detail="action must be 'start' or 'stop'")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}/{action}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    models_catalog.invalidate()  # the ollama model list is about to change
    return resp.json()


# ── model storage location (relocate the bundled store from the UI) ──────

STATE_MODELS_FILE = "/state/models_dir"


def _effective_models_dir() -> str:
    """Operator-chosen host path for the bundled model store, or '' for the
    default docker volume. The UI state file is authoritative when present
    (even empty = an explicit "use the default"); otherwise the deployment-time
    NOVA_MODELS_DIR applies. Mirrors the sidecar's own resolution."""
    import os
    try:
        with open(STATE_MODELS_FILE) as f:
            return f.read().strip()
    except OSError:
        return os.environ.get("NOVA_MODELS_DIR", "").strip()


@router.get("/api/v1/inference/models-dir")
async def get_models_dir():
    """Where the bundled model weights live. Read-only view; POST to change."""
    path = _effective_models_dir()
    return {"path": path or None, "relocated": bool(path)}


@router.post("/api/v1/inference/models-dir")
async def set_models_dir(body: dict):
    """Relocate the bundled model store. Writes the chosen absolute host path to
    the shared control file and asks the sidecar to migrate + recreate ollama
    there (non-destructive: the old copy is kept). Empty path resets to the
    default docker volume. Operator surface only — agents never reach settings,
    and the socket-holding sidecar reads this file read-only, so a path can only
    be set here."""
    import os
    import httpx

    path = str(body.get("path", "")).strip()
    if path and not (path.startswith("/") and os.path.isabs(path)):
        raise HTTPException(status_code=422,
                            detail="path must be an absolute host path (e.g. /mnt/ssd/nova-models)")
    if ".." in path.split("/"):
        raise HTTPException(status_code=422, detail="path must not contain '..'")
    try:
        os.makedirs(os.path.dirname(STATE_MODELS_FILE), exist_ok=True)
        with open(STATE_MODELS_FILE, "w") as f:
            f.write(path)
    except OSError as e:
        raise HTTPException(status_code=500,
                            detail=f"could not write control file: {e}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}/relocate")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return {"path": path or None, "relocated": bool(path), "status": "relocating"}


# ── tools (operator surface; agents use the manage_tools builtin) ────────

@router.get("/api/v1/tools")
async def list_tools_endpoint():
    return await tool_registry.list_all_tools()


@router.post("/api/v1/tools", status_code=201)
async def create_tool_endpoint(body: dict):
    try:
        return await tool_registry.create_http_tool(
            name=str(body.get("name", "")),
            description=str(body.get("description", "")),
            url_template=str(body.get("url_template", "")),
            method=str(body.get("method", "GET")),
            parameters_schema=body.get("parameters_schema"))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/tools/{tool_id}")
async def patch_tool_endpoint(tool_id: str, body: dict):
    # enable/disable is the only patchable field — always allowed
    if set(body) != {"enabled"} or not isinstance(body["enabled"], bool):
        raise HTTPException(status_code=422, detail="only {'enabled': bool} is editable")
    ok = await tool_registry.set_tool_enabled(tool_id, body["enabled"])
    if not ok:
        raise HTTPException(status_code=404, detail="tool not found")
    return {"status": "updated"}


@router.delete("/api/v1/tools/{tool_id}")
async def delete_tool_endpoint(tool_id: str):
    result = await tool_registry.delete_tool(tool_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="tool not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system tools can be disabled but not deleted")
    return {"status": "deleted"}


# ── settings (UI-configured runtime behavior) ────────────────────────────

@router.get("/api/v1/settings")
async def get_settings():
    return settings_store.all_settings()


@router.patch("/api/v1/settings")
async def patch_settings(changes: dict):
    applied = {}
    for key, value in changes.items():
        try:
            await settings_store.set_value(key, value)
            applied[key] = value
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=422, detail=str(e))
    # The fallback answers for EVERY agent when a provider is unreachable, so
    # its requirements are the union of all of theirs — which is how a 1.9GB
    # model came to stand in for the whole system without anyone choosing that.
    warnings: list[dict] = []
    if "inference.local_fallback_model" in applied:
        try:
            from app import model_fitness
            warnings = (await model_fitness.check_fallback())["findings"]
        except Exception:  # noqa: BLE001
            log.debug("fallback fitness check failed", exc_info=True)
    return {"applied": applied, "warnings": warnings}


@router.get("/api/v1/evals/suites")
async def evals_suites():
    """Available suites, with what each has actually cost before.

    The cost figures are the operator warning: a suite is minutes of wall
    clock and real tokens, so the button has to say so before it is pressed.
    Measured from previous runs — never estimated when there is no history.
    """
    from app import eval_runs
    from app.evals import suites as suite_mod
    out = []
    for name in suite_mod.list_suites():
        try:
            suite = suite_mod.load_suite(name)
        except Exception:  # noqa: BLE001 — one broken suite must not hide the rest
            log.warning("suite %s failed to load", name, exc_info=True)
            continue
        out.append({"suite": name, "agent": suite.agent,
                    "description": suite.description,
                    "tasks": len(suite.task_ids),
                    # so the UI can mark a verdict recorded against an older
                    # version as describing a different set of tasks
                    "version": suite.version,
                    "cost": await eval_runs.estimate(name)})
    return {"suites": out, "verdicts": await eval_runs.latest_verdicts()}


def _grades(contract: dict) -> list[str]:
    """What one task actually checks, in short phrases.

    DERIVED from the contract, and derived HERE rather than in the panel: a
    TypeScript restatement of a rule the harness enforces starts lying the day
    the contract grows a key, and nothing fails when it does — the same
    argument that moved the standby order out of AgentsTab.
    """
    out: list[str] = []
    tools = contract.get("tools") or {}
    must = [c["name"] if isinstance(c, dict) else c
            for c in (tools.get("must_call") or [])]
    if must:
        out.append("must call " + ", ".join(must))
    if tools.get("must_not_call"):
        out.append("must not call " + ", ".join(tools["must_not_call"][:3]))
    if (contract.get("memory") or {}).get("no_writes"):
        out.append("writes nothing")
    ft = contract.get("final_text") or {}
    if ft.get("must_match"):
        out.append(f"{len(ft['must_match'])} required phrase(s)")
    if ft.get("must_not_match"):
        out.append(f"{len(ft['must_not_match'])} forbidden phrase(s)")
    if not contract.get("narration_slip_allowed", False):
        out.append("no narration slip")
    if not contract.get("service_claim_allowed", False):
        out.append("no unchecked service claim")
    return out


@router.get("/api/v1/evals/suites/{suite}/tasks")
async def evals_suite_tasks(suite: str):
    """What a suite actually grades, case by case.

    The Run button shipped without this and the first thing asked of it was
    "there's no indication of what the tests are at all". A score with no
    visible rubric is a number the operator has to take on trust, which is the
    opposite of what an eval is for.

    `intent` is the prose on each task explaining the incident it came from.
    It was the most useful writing in the repo and was invisible to anyone not
    reading JSON on disk.
    """
    from app.evals import suites as suite_mod
    try:
        loaded = suite_mod.load_suite(suite)
        tasks = suite_mod.load_tasks(loaded)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"no suite named {suite!r}") from None
    except Exception as e:  # noqa: BLE001 — a broken task file is not a 500
        raise HTTPException(status_code=422, detail=str(e)) from None
    return {"suite": suite, "version": loaded.version, "tasks": [
        {"id": t.id, "title": t.title, "intent": t.intent, "prompt": t.prompt,
         "grades": _grades(t.contract)}
        for t in tasks]}


@router.post("/api/v1/evals/run")
async def evals_run(body: dict):
    """Run one suite against one model. Explicit, never automatic."""
    from app import eval_runs
    suite = str(body.get("suite") or "").strip()
    model = str(body.get("model") or "").strip()
    if not suite or not model:
        raise HTTPException(status_code=422, detail="suite and model are required")
    # repeat is the whole reason a stored score can be trusted: the CLI has had
    # --repeat all along and persists nothing, while this path persists and had
    # no repeat, so every recorded number was one draw.
    #
    # Parsed and bounded HERE so a bad parameter is 422, and start()'s own
    # ValueErrors keep their 409 — folding both into one except made "an eval
    # is already running" report as a malformed request. The bound itself
    # lives in eval_runs, so there is one number and two places that enforce it.
    try:
        raw = body.get("repeat")
        repeat = 1 if raw is None else int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422,
                            detail="repeat must be an integer") from None
    if not 1 <= repeat <= eval_runs.MAX_REPEAT:
        raise HTTPException(
            status_code=422,
            detail=f"repeat must be between 1 and {eval_runs.MAX_REPEAT}")
    try:
        return await eval_runs.start(suite, model, repeat)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"no suite named {suite!r}")


@router.get("/api/v1/evals/runs")
async def evals_runs(agent: str | None = None, limit: int = 20):
    from app import eval_runs
    return {"runs": await eval_runs.recent(agent, min(limit, 100))}


@router.get("/api/v1/evals/standings")
async def evals_standings():
    """If you had to keep one local model, which one — from recorded runs.

    Reads only; it starts nothing and invokes no model. The shape carries its
    own caveats (`basis`, `missing`, `min_repeat`) because the number on its
    own is the thing that gets over-read — see model_tournament.standings.
    """
    from app import model_tournament
    return await model_tournament.standings()


@router.get("/api/v1/models/fitness")
async def models_fitness(agent: str | None = None):
    """Whether the models in use can do the jobs they were given.

    Facts with a stated basis, never scores — see model_fitness. Cheap enough
    to call from a dropdown: no model is invoked.
    """
    from app import model_fitness
    from app.agents import registry as agent_registry
    out: dict = {"fallback": await model_fitness.check_fallback(),
                 "roles": await model_fitness.check_roles(),
                 "installed_local": await model_fitness.rank_local(),
                 "agents": []}
    for a in await agent_registry.list_agents(enabled_only=False):
        if agent and a.get("name") != agent:
            continue
        findings = await model_fitness.assess_for_agent(str(a["id"]))
        if findings or agent:
            out["agents"].append({"name": a.get("name"), "model": a.get("model"),
                                  "findings": findings})
    return out


@router.post("/api/v1/notify/test")
async def notify_test():
    """Send a real test notification through the configured provider, so the
    operator can confirm setup from Settings. Returns notify.send's honest
    result verbatim ({ok, id?, error?, provider?}) — server ACCEPTANCE, not
    proof it reached the device."""
    from app import notify
    return await notify.send(
        "Test notification from Nova — if this reached you, notifications are wired up.",
        title="Nova test", tags=["bell"])


@router.get("/api/v1/notify/reachability")
async def notify_reachability():
    """Read-only diagnostic of the notification delivery path (roadmap #21
    reachability, phase 1). Reports whether it's configured, whether the server
    is reachable from Nova, and the EXACT url + topic the operator's phone
    needs — honestly separating what Nova verifies from what only the operator
    can (the tailnet side). `ok: null` = Nova can't check this from here."""
    import re
    import httpx

    provider = settings_store.get("notify.provider")
    enabled = bool(settings_store.get("notify.enabled"))
    out: dict = {"provider": provider, "enabled": enabled, "checks": [], "phone": None}

    if provider == "webhook":
        url = (settings_store.get("notify.webhook.url") or "").strip()
        out["checks"] = [
            {"label": "Notifications enabled", "ok": enabled},
            {"label": "Webhook URL set", "ok": bool(url), "detail": url or "not set"},
        ]
        out["note"] = ("Webhook posts JSON to your URL — verify delivery on the "
                       "receiving end (Slack/Discord/Zapier/your endpoint).")
        return out

    # ── ntfy ──
    mode = settings_store.get("notify.ntfy.server_mode")
    topic = (settings_store.get("notify.ntfy.topic") or "").strip()
    if mode == "builtin":
        publish_url = settings.ntfy_builtin_url
        pub = (settings_store.get("ui.public_url") or "").strip().rstrip("/")
        host = re.sub(r":\d+$", "", pub) if pub else ""
        phone_url = f"{host}:8443" if host else ""
    elif mode == "custom":
        publish_url = (settings_store.get("notify.ntfy.custom_url") or "").strip()
        phone_url = publish_url
    else:
        publish_url = phone_url = "https://ntfy.sh"

    reachable, detail = False, "no server URL"
    if publish_url:
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{publish_url.rstrip('/')}/v1/health")
            reachable = r.status_code == 200
            detail = (f"reached {publish_url}" if reachable
                      else f"{publish_url} returned HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001 — report, never raise
            detail = f"could not reach {publish_url} ({type(e).__name__})"

    checks = [
        {"label": "Notifications enabled", "ok": enabled},
        {"label": "Topic set", "ok": bool(topic),
         "detail": topic or "no topic yet — use Randomize"},
        {"label": "ntfy server reachable from Nova", "ok": reachable, "detail": detail},
    ]
    if mode == "builtin":
        checks.append({"label": "Phone URL derived from your public URL",
                       "ok": bool(phone_url),
                       "detail": phone_url or "set your public URL (Phone setup) first"})
        # real tailnet-route status from the sidecar (live `tailscale serve`
        # read); neutral only when the control sidecar isn't present
        route_ok, route_detail = None, "control sidecar unavailable — can't check the route"
        try:
            async with httpx.AsyncClient(timeout=8.0) as c:
                r = await c.get(f"{settings.inference_control_url}/notify/status")
            if r.status_code == 200:
                route_ok = bool(r.json().get("tailnet_route"))
                route_detail = ("served on your tailnet at :8443" if route_ok
                                else "not served — Start the self-hosted server below "
                                     "(or bring up the tailscale profile)")
        except Exception:  # noqa: BLE001
            pass
        checks.append({"label": "Exposed on your tailnet (:8443)",
                       "ok": route_ok, "detail": route_detail})
    out["checks"] = checks
    out["phone"] = {"server_url": phone_url, "topic": topic}
    return out


STATE_NTFY_BASE_URL_FILE = "/state/ntfy_base_url"


def _ntfy_phone_url() -> str:
    """The URL a phone must subscribe to for the current ntfy server mode. For
    builtin it's DERIVED from Nova's own public URL (host + the ntfy tailnet
    port), so it can't drift out of sync with ntfy's base-url — the mismatch
    that silently breaks iOS background push. Empty when not derivable."""
    import re
    mode = settings_store.get("notify.ntfy.server_mode")
    if mode == "builtin":
        pub = (settings_store.get("ui.public_url") or "").strip().rstrip("/")
        host = re.sub(r":\d+$", "", pub) if pub else ""
        return f"{host}:8443" if host else ""
    if mode == "custom":
        return (settings_store.get("notify.ntfy.custom_url") or "").strip()
    return "https://ntfy.sh"


@router.get("/api/v1/notify/service")
async def notify_service_status():
    """State of the self-hosted notification services (ntfy + tailscale), via the
    socket-holding inference-control sidecar. {available:false} when the sidecar
    isn't present, so the UI can hide the controls."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.inference_control_url}/notify/status")
            resp.raise_for_status()
            status = resp.json()
    except Exception as e:  # noqa: BLE001
        log.warning("inference-control unreachable: %s", e)
        return {"available": False}
    return {"available": True, "phone_url": _ntfy_phone_url(), **status}


@router.post("/api/v1/notify/service")
async def notify_service_action(body: dict):
    """Start/stop the self-hosted ntfy service from the UI (roadmap #21
    reachability, phases 2-3). On 'up', Nova derives the correct base-url from
    its own public URL and writes it to the shared control file so the sidecar
    recreates ntfy with it — the phone-URL vs base-url mismatch that breaks iOS
    background push can no longer happen. Operator surface only; the socket
    -holding sidecar reads the control file read-only."""
    import os
    import httpx

    action = str(body.get("action", "")).strip()
    if action not in ("up", "down", "expose"):
        raise HTTPException(status_code=422,
                            detail="action must be 'up', 'down', or 'expose'")

    if action == "up":
        # only the self-hosted (builtin) server's base-url is ours to set; for
        # public/custom we don't run the server, so clear the control file
        base_url = (_ntfy_phone_url()
                    if settings_store.get("notify.ntfy.server_mode") == "builtin" else "")
        try:
            os.makedirs(os.path.dirname(STATE_NTFY_BASE_URL_FILE), exist_ok=True)
            with open(STATE_NTFY_BASE_URL_FILE, "w") as f:
                f.write(base_url)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"could not write control file: {e}")

    path = {"up": "/notify/up", "down": "/notify/down", "expose": "/notify/expose"}[action]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}{path}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


# ── landing her code (phase 4) ───────────────────────────────────────────
#
# The operator's own route for the effect `code_change.land` reproduces, which
# is what `actions.assert_routes_exist()` checks at boot. Same rule as Home
# Assistant below: an executor may only exist where he can already do this
# himself.

@router.get("/api/v1/code/repo")
async def code_repo_status():
    """Branch, HEAD and whether the working copy is dirty. Read-only.

    Exposed because a landing is REFUSED on a dirty worktree, so "why can't I
    press this" has to be answerable before the attempt.
    """
    from app import coder
    return await coder.repo_status()


@router.post("/api/v1/code/review")
async def review_code_change(body: dict):
    """Have a second model read a session's diff. The operator's own button."""
    from app import coder
    session_id = str(body.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id is required")
    out = await coder.review(session_id)
    if out.get("status") == "error":
        raise HTTPException(status_code=409, detail=str(out.get("detail")))
    return out


@router.post("/api/v1/code/sandbox")
async def sandbox_check_code(body: dict):
    """Run the boot gate on a coding session. The operator's own button.

    Minutes: it builds the branch, starts a stack of its own and runs the
    suite inside it. Landing refuses any session this has not passed.
    """
    from app import coder
    session_id = str(body.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id is required")
    out = await coder.sandbox_check(session_id)
    if out.get("status") == "error":
        raise HTTPException(status_code=409, detail=str(out.get("detail")))
    return out


@router.post("/api/v1/code/land")
async def land_code_change(body: dict):
    """Land a finished coding session's work on a `nova/<slug>` branch.

    Nothing here decides anything: the patch comes from the broker and every
    refusal that matters (not `main`, not a dirty tree, no push, abort on
    conflict) is enforced in the `git-landing` container, which is the only
    thing in this stack with write access to the repository.
    """
    from app import coder
    session_id = str(body.get("session_id") or "").strip()
    slug = str(body.get("branch") or "").strip()
    if not session_id or not slug:
        raise HTTPException(status_code=422,
                            detail="session_id and branch are both required")
    got = await coder.patch(session_id)
    if got.get("status") != "ok":
        raise HTTPException(status_code=409, detail=str(got.get("detail")))
    out = await coder.land(got["patch"], f"nova/{slug}")
    if out.get("status") != "ok":
        raise HTTPException(status_code=409, detail=str(out.get("detail")))
    from app import capability_events as ce
    ce.record(ce.WORKLOAD, f"nova/{slug}", "code_landed")
    return out


# ── Home Assistant (roadmap #35) ─────────────────────────────────────────
#
# THE OPERATOR ROUTE THAT MAKES THE EXECUTOR LEGAL. `actions.__init__`
# refuses to boot if an action type names a route that is not here, and the
# rule it enforces is "an executor may only exist where the operator can
# already do this from the UI". So this pair is not decoration around the
# `home_assistant.deploy` action — it is the thing that permits it to exist.
#
# Nothing here is parameterized past an up/down verb, matching the sidecar
# it calls. The service definition lives in docker-compose.yml, in git.

@router.get("/api/v1/home-assistant")
async def home_assistant_status():
    """Is Home Assistant running, and where. Read-only."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{settings.inference_control_url}/home/status")
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as e:
        # Not a 502: "the sidecar is down" is a legible state for a panel that
        # is mostly asking "is this thing on", and a red card beats a stack
        # trace. Same shape the notify panel uses.
        return {"running": False, "state": "unknown", "url": None,
                "error": f"inference-control sidecar unreachable: {e}"}


@router.post("/api/v1/home-assistant")
async def home_assistant_control(body: dict):
    """Bring Home Assistant up or stop it. The operator's own switch."""
    import httpx

    action = str(body.get("action", "")).strip()
    if action not in ("up", "down"):
        raise HTTPException(status_code=422,
                            detail="action must be 'up' or 'down'")
    if action == "up":
        # the SAME function the approved plan calls, so the operator's button
        # and her card cannot apply different clocks
        from app.actions import home_assistant as _ha
        _ha.write_timezone()
    path = {"up": "/home/up", "down": "/home/down"}[action]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}{path}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    # actor defaults to "operator", which is the truth on this path: the
    # executor records its own event with actor="agent" so the two routes to
    # the same effect stay distinguishable in the log.
    from app import capability_events as ce
    ce.record(ce.WORKLOAD, "home-assistant", action)
    return resp.json()


# ── automations ──────────────────────────────────────────────────────────

@router.get("/api/v1/automations")
async def list_automations_endpoint():
    return await automations.list_automations()


@router.get("/api/v1/automations/{automation_id}/runs")
async def list_automation_runs_endpoint(automation_id: str, limit: int = 20):
    try:
        return await automations.list_runs(automation_id, limit=limit)
    except ValueError:
        raise HTTPException(status_code=404, detail="automation not found")


@router.post("/api/v1/automations", status_code=201)
async def create_automation_endpoint(body: dict):
    try:
        return await automations.create(
            name=str(body.get("name", "")).strip(),
            instruction=str(body.get("instruction", "")).strip(),
            agent_name=str(body.get("agent_name", "")).strip(),
            interval_minutes=int(body.get("interval_minutes", 0)),
            description=str(body.get("description", "")),
            schedule=body.get("schedule") or None,
            notify=bool(body.get("notify")),
            timeout_seconds=(int(body["timeout_seconds"])
                             if body.get("timeout_seconds") else None))
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/automations/{automation_id}")
async def patch_automation_endpoint(automation_id: str, body: dict):
    # Filtered against the store's own set, never spread raw: `operator` and
    # `actor` are now parameters, and an incoming body key of either name
    # would bind to them — the attribution deciding who did this cannot come
    # from the request that is being attributed.
    allowed = {k: v for k, v in body.items() if k in automations.UPDATABLE}
    # operator=True: this route is the human at Settings, already past the
    # auth middleware.
    try:
        ok = await automations.update(automation_id, operator=True, **allowed)
    except ValueError as e:
        # 422 like the create route, not the 500 a bare DB CHECK gives.
        raise HTTPException(status_code=422, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="automation not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/automations/{automation_id}")
async def delete_automation_endpoint(automation_id: str):
    result = await automations.delete(automation_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="automation not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system automations can be disabled but not deleted")
    return {"status": "deleted"}


# ── guardrail rules ──────────────────────────────────────────────────────

@router.get("/api/v1/rules")
async def list_rules_endpoint():
    return await rules.list_rules()


@router.post("/api/v1/rules", status_code=201)
async def create_rule_endpoint(body: dict):
    try:
        return await rules.create(
            name=str(body.get("name", "")).strip(),
            pattern=str(body.get("pattern", "")),
            action=str(body.get("action", "block")),
            description=str(body.get("description", "")),
            target_tools=body.get("target_tools"),
            target_agents=body.get("target_agents"))
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/rules/{rule_id}")
async def patch_rule_endpoint(rule_id: str, body: dict):
    try:
        ok = await rules.update(rule_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="rule not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/rules/{rule_id}")
async def delete_rule_endpoint(rule_id: str):
    result = await rules.delete(rule_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="rule not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system protections can be disabled but not deleted")
    return {"status": "deleted"}


# ── operator consents (guarded destructive actions, roadmap #29) ─────────

@router.get("/api/v1/consents")
async def list_consents_endpoint(conversation_id: str | None = None):
    """Fresh pending consents — the chat UI renders these as decision cards.

    Each rule.* consent is enriched with the rule's AUTHORITATIVE facts from
    the database (2026-07-20 hardening): the card must show what approving
    actually touches, not the requesting agent's summary of it — an agent
    that read attacker-influenced content could word the question
    misleadingly, but it cannot forge this block."""
    rows = await consents.list_pending(conversation_id)
    for row in rows:
        if row["kind"].startswith("rule."):
            rule = await rules.get_by_name(row["subject"])
            row["rule"] = None if not rule else {
                k: rule[k] for k in ("description", "pattern", "action",
                                     "target_tools", "enabled", "is_system",
                                     "hit_count")}
    return rows


@router.post("/api/v1/consents/{consent_id}/decide")
async def decide_consent_endpoint(consent_id: str, body: dict):
    """The operator's authenticated click. This endpoint is the ONLY writer
    of approvals — agents can request consents but never decide them."""
    chosen = str(body.get("chosen", "")).lower()
    if chosen not in ("approve", "deny"):
        raise HTTPException(status_code=422, detail="chosen must be 'approve' or 'deny'")
    row = await consents.decide(consent_id, chosen)
    if not row:
        raise HTTPException(status_code=410,
                            detail="consent is no longer pending (expired or already decided)")
    return row


# ── ingestion queue: the durable background ingest lane (migration 041) ──────
#    follow_source / poll only ENQUEUE; ingest_worker drains this. These
#    endpoints are the operator's live, per-item view of that work — the
#    detailed trail the turn-ledger couldn't give (it died with a killed turn).

@router.get("/api/v1/ingest/summary")
async def ingest_summary_endpoint():
    """Counts by status + the most-recently-touched jobs — the Ingestion panel's
    one poll. queued/running = live work; done/failed/skipped = the trail."""
    from app import ingest_jobs
    return await ingest_jobs.summary()


@router.get("/api/v1/ingest/jobs")
async def ingest_jobs_endpoint(status: str | None = None, limit: int = 100,
                               dismissed: str = "exclude"):
    """Full job list, optionally filtered by status (queued|running|done|
    skipped|failed).

    `dismissed` is exclude (default, matches the panel) | only (the 'show
    dismissed' drawer) | include (everything, for debugging)."""
    limit = max(1, min(500, limit))
    if dismissed not in ("exclude", "only", "include"):
        raise HTTPException(status_code=400,
                            detail="dismissed must be exclude|only|include")
    where = {"exclude": "dismissed_at IS NULL",
             "only": "dismissed_at IS NOT NULL",
             "include": "TRUE"}[dismissed]
    order = "ORDER BY COALESCE(finished_at, started_at, enqueued_at) DESC"
    async with db.acquire() as conn:
        if status:
            rows = await conn.fetch(
                f"SELECT * FROM ingest_jobs WHERE {where} AND status = $1 "
                f"{order} LIMIT $2", status, limit)
        else:
            rows = await conn.fetch(
                f"SELECT * FROM ingest_jobs WHERE {where} {order} LIMIT $1",
                limit)
    return [dict(r) for r in rows]


@router.post("/api/v1/ingest/jobs/{job_id}/retry")
async def ingest_retry_endpoint(job_id: str):
    """Requeue a failed/skipped job so the worker tries it again — the 'continue'
    control for anything that didn't land."""
    from app import ingest_jobs
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="job not found")
    # The one place the agent retry budget is refilled AND the one place a
    # dismissal is lifted by a retry: a human clicked Retry on the Activity
    # page, behind the auth middleware. Nothing a model can reach passes
    # either flag.
    row = await ingest_jobs.retry(jid, refill_agent_budget=True,
                                  clear_dismissal=True)
    if not row:
        raise HTTPException(status_code=409,
                            detail="job is not in a retryable state (failed/skipped)")
    return dict(row)


# ── dismissal: the operator clears a finished row off the page ──────────────
#
# OPERATOR-ONLY, and that is a design constraint rather than an oversight.
# `dismissed_at` suppresses a row from failures.census, so a tool that wrote it
# would hand a model the ability to silence its own failures — the exact thing
# app/failures.py exists to make impossible. There is no dismiss tool, and
# `retry_by_agent` refuses a dismissed row in SQL.

@router.post("/api/v1/ingest/jobs/{job_id}/dismiss")
async def ingest_dismiss_endpoint(job_id: str):
    """Hide one finished row (done/failed/skipped). Queued and running jobs are
    refused — hiding live work is how a queue silently stops."""
    from app import ingest_jobs
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="job not found")
    row = await ingest_jobs.dismiss(jid)
    if not row:
        raise HTTPException(
            status_code=409,
            detail="only a finished job (done/failed/skipped) that is not "
                   "already dismissed can be cleared")
    return dict(row)


@router.post("/api/v1/ingest/jobs/dismiss-finished")
async def ingest_dismiss_finished_endpoint():
    """Clear the whole finished trail in one click. Live work is untouched."""
    from app import ingest_jobs
    return {"dismissed": await ingest_jobs.dismiss_finished()}


@router.post("/api/v1/ingest/jobs/{job_id}/restore")
async def ingest_restore_endpoint(job_id: str):
    """Put a dismissed row back on the page, in whatever state it was in.
    Not a retry: restoring a done job must not re-run a finished ingest."""
    from app import ingest_jobs
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="job not found")
    row = await ingest_jobs.restore(jid)
    if not row:
        raise HTTPException(status_code=409, detail="job is not dismissed")
    return dict(row)


# ── recommendations: Nova's proactive cards (docs/plans/recommendation-surface.md) ─

@router.get("/api/v1/recommendations")
async def list_recommendations_endpoint(status: str = "new"):
    """Proactive recommendations raised by Nova/automations. status=new is the
    live queue the chat banner shows; status=all is the inbox view (decided
    rows included, actionable first)."""
    return await recommendations.list_all("all" if status == "all" else "new")


# ── web push: per-device subscriptions (the webpush notify provider) ──────
# Operator-only like everything on this API; agents never see these. The
# delivery half lives in app/push.py.

@router.get("/api/v1/push/pubkey")
async def push_pubkey():
    """The VAPID applicationServerKey — PushManager.subscribe needs it.
    Generates the fleet keypair on first call."""
    from app import push
    pub, _ = await push.ensure_vapid()
    return {"key": pub}


@router.post("/api/v1/push/subscribe")
async def push_subscribe(body: dict):
    """Register (or refresh) this device's push subscription."""
    from app import push
    sub = body.get("subscription") or {}
    if not sub.get("endpoint") or not (sub.get("keys") or {}).get("p256dh"):
        raise HTTPException(status_code=422, detail="subscription with endpoint + keys required")
    return await push.subscribe(sub, str(body.get("label") or "")[:120])


@router.post("/api/v1/push/unsubscribe")
async def push_unsubscribe(body: dict):
    from app import push
    endpoint = str(body.get("endpoint") or "")
    if not endpoint:
        raise HTTPException(status_code=422, detail="endpoint required")
    return {"removed": await push.unsubscribe(endpoint)}


@router.get("/api/v1/push/subscriptions")
async def push_subscriptions():
    """Device list for Settings -> Notifications."""
    from app import push
    return {"devices": await push.list_subscriptions()}


# ── goals: the operator's own list ──────────────────────────────────────────
#    Goals have existed since 2026-07-29 with no UI at all — he approved a card
#    in chat and then could not see what was active, what it authorised, how
#    much budget was left, or when it expired. These are the routes that end
#    that. Everything that GRANTS is deliberately absent: `approved_verbs`,
#    `max_actions` and `expires_at` are the authorisation, and widening a
#    standing grant belongs on an approval card rather than in a text field.

@router.get("/api/v1/goals")
async def list_goals_endpoint(limit: int = 50):
    from app import goals
    return await goals.list_all(limit=limit)


@router.post("/api/v1/goals", status_code=201)
async def create_goal_endpoint(body: dict):
    from app import goals
    title = str(body.get("title", "")).strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    return await goals.create(
        title, description=str(body.get("description", "")),
        target=str(body.get("target", "")), created_by="operator")


@router.patch("/api/v1/goals/{goal_id}")
async def edit_goal_endpoint(goal_id: str, body: dict):
    from app import goals
    allowed = {k: v for k, v in body.items() if k in goals.EDITABLE}
    try:
        row = await goals.edit(goal_id, **allowed)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not row:
        raise HTTPException(status_code=404, detail="no such goal")
    return row


@router.delete("/api/v1/goals/{goal_id}")
async def delete_goal_endpoint(goal_id: str):
    from app import goals
    if not await goals.delete(goal_id):
        raise HTTPException(status_code=404, detail="no such goal")
    return {"status": "deleted"}


@router.post("/api/v1/recommendations/{rec_id}/decide")
async def decide_recommendation_endpoint(rec_id: str, body: dict):
    """The operator's authenticated decision. Agents RAISE recommendations
    (raise_recommendation tool) but only the operator decides — this endpoint
    is the only writer of the outcome, never reachable by an agent."""
    choice = str(body.get("choice", "")).lower()
    if choice not in ("approve", "later", "dismiss"):
        raise HTTPException(status_code=422,
                            detail="choice must be 'approve', 'later', or 'dismiss'")
    try:
        row = await recommendations.decide(
            rec_id, choice, body.get("action_digest"))
    except recommendations.PlanChanged as e:
        # 409, not 422: the request was well-formed, the world moved.
        raise HTTPException(status_code=409, detail=str(e))
    if not row:
        raise HTTPException(status_code=404, detail="recommendation not found")
    return row


@router.post("/api/v1/recommendations/{rec_id}/run")
async def rerun_recommendation_action_endpoint(rec_id: str):
    """Re-queue a failed action run. The card's `Run again` button.

    Only a `failed` run is re-queued, and the worker's claim JOIN still
    requires the recommendation to be approved by the operator — so this
    cannot resurrect work on a card that was since dismissed.
    """
    row = await recommendations.requeue(rec_id)
    if not row:
        raise HTTPException(status_code=404, detail="recommendation not found")
    return row


@router.post("/api/v1/recommendations/{rec_id}/preflight")
async def preflight_recommendation_endpoint(rec_id: str):
    """Re-check a card's plan against the network. The `Test` button.

    This is the ONLY path that probes with the plan's headers. The automatic
    preflight that runs when a card is raised sends none: a model choosing
    both a URL and the credentials sent to it is an exfiltration primitive,
    and it does not get one by accident. Here the operator asked, so the
    credential the operator stored is in scope.
    """
    from app import actions
    result = await actions.preflight(rec_id, operator=True)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="no such recommendation, or it carries no action plan")
    return {k: (str(v) if v is not None else None) for k, v in result.items()}


# ── secrets (docs/plans/secrets-management.md phase 1) — operator-only.
#    No agent-facing tool exists here, and that is the design rather than an
#    omission: a value path reachable by a model is a value that reaches a
#    model. Agents may learn NAMES (phase 2) so they can wire a reference;
#    the plaintext leaves only through /reveal, below the auth middleware. ──

@router.get("/api/v1/secrets")
async def list_secrets_endpoint():
    """Names and metadata. Never a value — `has_value` is the whole of it."""
    from app import secret_store
    return {"secrets": await secret_store.list_all()}


@router.put("/api/v1/secrets/{name}")
async def put_secret_endpoint(name: str, body: dict):
    from app import secret_store
    try:
        return await secret_store.put(
            name, str(body.get("value") or ""),
            description=str(body.get("description") or ""))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except secret_store.SecretError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/secrets/{name}/reveal")
async def reveal_secret_endpoint(name: str):
    """POST, not GET: a value must never land in a URL, a browser history or
    an access log. The auth middleware is the gate — this is the operator's
    own eye on his own credential."""
    from app import secret_store
    try:
        return {"name": name, "value": await secret_store.reveal(name)}
    except secret_store.SecretError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/api/v1/secrets/{name}/usage")
async def secret_usage_endpoint(name: str):
    from app import secret_store
    return {"name": name, "used_by": await secret_store.used_by(name)}


@router.delete("/api/v1/secrets/{name}")
async def delete_secret_endpoint(name: str):
    from app import secret_store
    used = await secret_store.used_by(name)
    if not await secret_store.delete(name):
        raise HTTPException(status_code=404, detail="secret not found")
    return {"deleted": True, "was_used_by": used}


@router.get("/api/v1/secrets/sources")
async def secret_sources_endpoint():
    """What the source picker offers, derived from the resolver table so a new
    manager appears without a second edit."""
    from app import secret_store
    return {"sources": secret_store.source_options()}


@router.put("/api/v1/secrets/{name}/external")
async def put_external_secret_endpoint(name: str, body: dict):
    """Point at a secret held elsewhere. No value is stored for this row —
    'reference, don't mirror'. The reference is FOLLOWED before saving, so a
    typo fails while the operator is still looking at it."""
    from app import secret_store
    try:
        return await secret_store.put_external(
            name, str(body.get("source") or ""), str(body.get("ref") or ""),
            description=str(body.get("description") or ""))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except secret_store.SecretError as e:
        raise HTTPException(status_code=422, detail=str(e))
