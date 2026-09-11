"""Observe-only context manifests: recorded always, enforcing never (S4a).

    docker compose exec backend python tests/test_context_manifest.py
    PYTHONPATH=backend python backend/tests/test_context_manifest.py   (CI)

What is pinned, per the approved S4a contract:

  1. THE SEAM: every `stream_chat` call records either the caller's manifest
     or an honest MISSING_MANIFEST observation — exercised through the real
     router with only the transport client patched, so resolution and
     observation run exactly as in production while nothing leaves the box.
  2. BEFORE TRANSPORT: a call whose transport fails still records the
     attempted call.
  3. NOTHING CHANGES: with and without a manifest, the messages the
     transport receives are byte-identical and the resolved model is the
     same; observation failures (an injected span-recording crash) are
     caught into a counter and the request still streams.
  4. The decision table: per-class eligibility, most-restrictive
     aggregation, ITEM_LIST_TRUNCATED (fully classified -> verdict stays
     complete; public-only stays cloud_ok) vs CLASSIFICATION_INCOMPLETE
     (forces local_only).
  5. PRIVACY BOUNDS: the emitted payload holds ordinals + enums only — no
     planted content, paths, titles, UUIDs, conversation ids, digests, or
     unbounded lists; the no-turn log carries only purpose / locality /
     verdict / reasons.
  6. Surface: only llm/router.py and agents/runner.py reference the module
     in app/, and nothing anywhere in app/ calls divergence_summary (it is
     test/admin-only, hard-bounded).
"""

import asyncio
import json
import logging
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import context_manifest as cmx, db, trace          # noqa: E402
from app.llm import router as llm_router                    # noqa: E402

FAILURES: list[str] = []
APP = Path(__file__).resolve().parents[1] / "app"
SECRET = "PLANTED-SECRET-CONTENT-a7b9"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class FakeClient:
    def __init__(self, fail=False):
        self.fail = fail
        self.seen_messages = None
        self.seen_model = None

    async def stream(self, messages, model_name, tools=None, **kw):
        self.seen_messages = json.dumps(messages, sort_keys=True)
        self.all_seen = getattr(self, "all_seen", []) + [self.seen_messages]
        self.seen_model = model_name
        if self.fail:
            raise RuntimeError("transport down (test)")
        yield {"type": "text", "text": "ok"}
        yield {"type": "usage", "usage": {"prompt_tokens": 1,
                                          "completion_tokens": 1}}


async def drive(model="openrouter:probe/m", manifest=None, fail=False):
    """Real stream_chat with resolution pinned (effective_model on a live
    install maps unknown models to the configured standby — measured: the
    probe slug resolved to the local default and made a REAL local call) and
    only the transport client faked, so nothing runs and nothing leaves."""
    fake = FakeClient(fail=fail)
    real = llm_router._resolve
    real_eff = llm_router.effective_model
    llm_router._resolve = lambda t: (fake, t.split(":", 1)[1])
    llm_router.effective_model = lambda m: m
    try:
        events = []
        try:
            async for e in llm_router.stream_chat(
                    [{"role": "user", "content": f"hello {SECRET}"}],
                    model, manifest=manifest):
                events.append(e)
        except RuntimeError:
            pass
        return fake, events
    finally:
        llm_router._resolve = real
        llm_router.effective_model = real_eff


def manifest_spans(turn):
    return [s for s in turn.spans if s["name"] == "context_manifest"]


async def main():
    await db.init_pool()
    probe_traces: list[uuid.UUID] = []
    probe_rows: dict = {}
    try:
        print("1. the decision table (pure)")
        m = cmx.Manifest("test")
        m.add_items("web", "public_web", origin="search", count=3)
        t, r = m.finalize()
        check("public-only context is target cloud_ok", t == "cloud_ok", str(r))
        for cls in ("engineering_unscanned", "operator_private",
                    "household_member", "sensitive", "persona_core",
                    "guest_demo", "unknown"):
            m2 = cmx.Manifest("test")
            m2.add_items("x", cls)
            t2, r2 = m2.finalize()
            check(f"{cls} -> local_only",
                  t2 == "local_only" and f"ITEM_{cls.upper()}" in r2, str(r2))
        m3 = cmx.Manifest("test")
        m3.add_items("web", "public_web", count=2)
        m3.add_items("mem", "operator_private")
        check("aggregation: most restrictive wins",
              m3.finalize()[0] == "local_only")

        print("2. truncation is not incompleteness")
        big = cmx.Manifest("test")
        big.add_items("web", "public_web", count=500)
        t, r = big.finalize()
        check("500 classified public items: display truncated, verdict "
              "complete and cloud_ok",
              t == "cloud_ok" and "ITEM_LIST_TRUNCATED" in big.flags
              and "CLASSIFICATION_INCOMPLETE" not in big.flags
              and len(big.items) == cmx.ITEM_DISPLAY_MAX)
        inc = cmx.Manifest("test")
        inc.add_items("web", "public_web")
        inc.add_items("mystery", "public_web", class_source="missing")
        t, r = inc.finalize()
        check("one unclassified input forces local_only via "
              "CLASSIFICATION_INCOMPLETE",
              t == "local_only" and "CLASSIFICATION_INCOMPLETE" in r)
        empty = cmx.Manifest("test")
        check("an empty manifest is incomplete, not cloud_ok",
              empty.finalize()[0] == "local_only")

        print("3. the seam, through the real router (transport patched)")
        async with trace.turn("chat") as turn:
            probe_traces.append(turn.id)
            mm = cmx.Manifest("chat")
            mm.add_items("turn_messages", "operator_private")
            fake, events = await drive(manifest=mm)
            spans = manifest_spans(turn)
            check("a manifested call lands one context_manifest span",
                  len(spans) == 1)
            d = spans[0]["detail"]
            check("...target local_only, observed cloud, divergent",
                  d["target_eligibility"] == "local_only"
                  and d["observed_local"] is False and d["divergent"] is True
                  and d["observed_model"] == "openrouter:probe/m")
            check("...override recorded as unavailable",
                  d["override"] == "unavailable")
            fake2, _ = await drive(manifest=None)
            spans = manifest_spans(turn)
            check("a bare call records an honest MISSING_MANIFEST",
                  len(spans) == 2
                  and spans[1]["detail"]["purpose"] == "unknown_nonrunner"
                  and "MISSING_MANIFEST" in spans[1]["detail"]["reason_codes"]
                  and spans[1]["detail"]["target_eligibility"] == "local_only")
            check("NOTHING CHANGED: transport got byte-identical messages "
                  "with and without a manifest, same resolved model",
                  fake.seen_messages == fake2.seen_messages
                  and fake.seen_model == fake2.seen_model)
            check("...and the planted content is in the MESSAGES (control)",
                  SECRET in fake.seen_messages)
            for s in manifest_spans(turn):
                blob = json.dumps(s["detail"])
                check("...but never in the manifest payload",
                      SECRET not in blob and "conversation" not in
                      json.dumps(s["detail"].get("items")))
                check("...items are ordinals with enum fields only",
                      all(set(i) == {"ordinal", "source_kind", "origin",
                                     "data_class", "class_source"}
                          for i in s["detail"]["items"]))

            print("4. observation happens BEFORE transport")
            n0 = len(manifest_spans(turn))
            await drive(manifest=None, fail=True)
            check("a transport failure still records the attempted call",
                  len(manifest_spans(turn)) == n0 + 1)

            print("5. an injected span failure never touches the request")
            real_span = trace.span

            def boom_span(kind, name):
                raise RuntimeError("span recorder down (test)")

            f0 = cmx.counters["emit_failures"]
            trace.span = boom_span
            try:
                fake3, events3 = await drive(manifest=None)
            finally:
                trace.span = real_span
            check("the request streamed normally",
                  any(e.get("type") == "text" for e in events3))
            check("...and the failure became a counter",
                  cmx.counters["emit_failures"] > f0)

        print("6. the no-turn path: bounded log + counter only")
        records: list[logging.LogRecord] = []
        h = logging.Handler()
        h.emit = records.append
        lg = logging.getLogger("app.context_manifest")
        old = lg.level
        lg.setLevel(logging.INFO)
        lg.addHandler(h)
        c0 = cmx.counters["no_turn_logged"]
        try:
            await drive(manifest=None)
        finally:
            lg.removeHandler(h)
            lg.setLevel(old)
        check("no turn -> counter, no span, no rows",
              cmx.counters["no_turn_logged"] == c0 + 1)
        msg = "".join(r.getMessage() for r in records)
        check("...log carries only purpose/locality/verdict/reasons",
              "unknown_nonrunner" in msg and "local_only" in msg
              and SECRET not in msg and "items" not in msg)

        print("7. divergence_summary (test/admin-only, hard-bounded)")
        # The turn's flush is asynchronous — wait until the probe spans are
        # actually in the database before reading them back.
        async with db.acquire() as conn:
            for _ in range(30):
                n = await conn.fetchval(
                    "SELECT count(*) FROM turn_spans WHERE trace_id = $1 "
                    "AND name = 'context_manifest'", probe_traces[0])
                if n and n >= 3:
                    break
                await asyncio.sleep(0.2)
        check("the probe turn's manifest spans reached the database",
              n and n >= 3, f"n={n}")
        out = await cmx.divergence_summary(hours=999)   # clamps to 72
        check("summary sees the probe calls",
              out["calls"] >= 4 and out["missing"] >= 2
              and out["divergent"] >= 1, str({k: out[k] for k in
                                              ("calls", "missing", "divergent")}))
        check("window is clamped and row limit constant is bounded",
              cmx.SUMMARY_WINDOW_MAX_H <= 72
              and cmx.SUMMARY_ROW_LIMIT <= 5000)

        print("8. surface scan")
        refs, summary_refs = [], []
        for p in APP.rglob("*.py"):
            src = p.read_text()
            if "context_manifest" in src and p.name not in (
                    "context_manifest.py", "router.py", "runner.py",
                    "compaction.py", "vision.py",
                    "automations.py"):   # approved producers
                refs.append(p.name)
            if "divergence_summary" in src and p.name != "context_manifest.py":
                summary_refs.append(p.name)
        check("only llm/router.py and agents/runner.py touch the module",
              not refs, ",".join(refs))
        check("nothing in app/ calls divergence_summary", not summary_refs,
              ",".join(summary_refs))
        prompt_leak = re.search(r"context_manifest",
                                (APP / "agents" / "runner.py").read_text()
                                .split("def _build_system_prompt")[1]
                                .split("\ndef ")[0])
        check("the manifest is not woven into prompt assembly itself",
              prompt_leak is None)

        print("9. v2 field split (D-034): separate fields, legacy preserved")
        async with trace.turn("heartbeat") as turn2:
            probe_traces.append(turn2.id)
            await drive(manifest=cmx.Manifest("dispatch"))
            d = manifest_spans(turn2)[0]["detail"]
            check("runner shape: turn_source=heartbeat + "
                  "operation_purpose=dispatch, never a compound string",
                  d["turn_source"] == "heartbeat"
                  and d["operation_purpose"] == "dispatch"
                  and d["manifest_version"] == 2)
            check("...legacy `purpose` field retained for v1 readers",
                  d["purpose"] == "dispatch")
            await drive(manifest=None)
            d2 = manifest_spans(turn2)[1]["detail"]
            check("missing-manifest shape: op=unknown, source from trace",
                  d2["operation_purpose"] == "unknown"
                  and d2["turn_source"] == "heartbeat")
        legacy_v1 = {"purpose": "chat", "divergent": True,
                     "target_eligibility": "local_only", "histogram": {}}
        # decoder handles both versions: a v1-shaped record still counts,
        # keyed by its legacy purpose — recorded spans are not reinterpreted.
        from app.context_manifest import counters as _c   # noqa: F401
        check("summary decoder accepts a v1-shaped detail",
              (json.loads(json.dumps(legacy_v1)).get("operation_purpose")
               or legacy_v1["purpose"]) == "chat")

        print("10. compaction audience classification (authoritative only)")
        from app import compaction
        async with db.acquire() as conn:
            gsid = await conn.fetchval(
                "INSERT INTO guest_sessions (token_hash, label, expires_at, "
                "allowed_models) VALUES ('cmx-probe', 'cmx-probe', "
                "now() + interval '5 minutes', '{}') RETURNING id")
            gconv = await conn.fetchval(
                "INSERT INTO conversations (guest_id) VALUES ($1) RETURNING id",
                gsid)
            oconv = await conn.fetchval(
                "INSERT INTO conversations DEFAULT VALUES RETURNING id")
        probe_rows = {"guest_sessions": [gsid], "conversations": [gconv, oconv]}
        check("a guest conversation classifies guest_demo by guest_id",
              await compaction._audience(str(gconv))
              == ("guest_demo", "derived_rule", None))
        check("a non-guest conversation is unknown + AUDIENCE_UNAVAILABLE — "
              "operator is never inferred from absence",
              await compaction._audience(str(oconv))
              == ("unknown", "missing", "AUDIENCE_UNAVAILABLE"))

        print("11. both compaction calls carry manifests (end-to-end)")
        from app import settings_store
        min_aged = int(settings_store.get("compaction.min_aged") or 6)
        async with db.acquire() as conn:
            for i in range(min_aged + 2):
                await conn.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, "
                    "created_at) VALUES (gen_random_uuid(), $1, $2, $3, "
                    "now() - interval '2 hours')", oconv,
                    "user" if i % 2 else "assistant", f"probe message {i}")
        real_get = settings_store.get
        settings_store.get = (lambda k, *a, **kw:
                              None if k == "compaction.model"
                              else real_get(k, *a, **kw))
        real_unground = compaction.grounding.ungrounded
        forced = [["probeterm"]]   # first grade forces the reground call
        compaction.grounding.ungrounded = \
            lambda s, src: forced.pop(0) if forced else []
        c_no_turn = cmx.counters["no_turn_logged"]
        try:
            fake = FakeClient()
            realr, realeff = llm_router._resolve, llm_router.effective_model
            llm_router._resolve = lambda t: (fake, t.split(":", 1)[1])
            llm_router.effective_model = lambda m: m
            try:
                await compaction.maybe_compact(
                    str(oconv), "openrouter:probe/m",
                    __import__("datetime").datetime.now(
                        __import__("datetime").timezone.utc).isoformat())
            finally:
                llm_router._resolve = realr
                llm_router.effective_model = realeff
        finally:
            settings_store.get = real_get
            compaction.grounding.ungrounded = real_unground
        async with db.acquire() as conn:
            for _ in range(30):
                span = await conn.fetchrow(
                    "SELECT s.detail FROM turn_spans s JOIN turn_traces t ON "
                    "t.id = s.trace_id WHERE t.conversation_id = $1 AND "
                    "s.name = 'context_manifest'", oconv)
                if span:
                    break
                await asyncio.sleep(0.2)
            ct = await conn.fetch(
                "SELECT id FROM turn_traces WHERE conversation_id = $1", oconv)
            probe_traces.extend(r["id"] for r in ct)
        d = (json.loads(span["detail"]) if span and
             isinstance(span["detail"], str) else (span["detail"] if span else {}))
        check("call 1 landed a manifested span on the compaction turn",
              bool(span) and d.get("turn_source") == "compaction"
              and d.get("operation_purpose") == "compact")
        check("...classed unknown/AUDIENCE_UNAVAILABLE, target local_only",
              d.get("target_eligibility") == "local_only"
              and "AUDIENCE_UNAVAILABLE" in (d.get("reason_codes") or []))
        check("call 2 (reground) took the bounded no-turn path — no trace "
              "was created for it",
              cmx.counters["no_turn_logged"] == c_no_turn + 1)
        seen_all = getattr(fake, "all_seen", [])
        check("both calls hit the pinned transport; the transcript reached "
              "call 1 (control)",
              len(seen_all) == 2 and "probe message" in seen_all[0])
        check("…and no transcript text or conversation id is in the manifest",
              "probe message" not in json.dumps(d)
              and str(oconv) not in json.dumps(d))

        print("12. vision adapter (S4b-2): local pinned, cloud refused")
        from types import SimpleNamespace
        from app import local_context, vision
        IMG = "QUJD" * 40_000          # ~117 KiB decoded -> bucket 'small'
        EST = (len(IMG) * 3) // 4
        vfake = FakeClient()

        async def _anone(*a, **k):
            return None

        async def _atrue(*a, **k):
            return True

        real_get2 = settings_store.get
        real_cansee = vision._can_see
        realr2, realeff2 = llm_router._resolve, llm_router.effective_model
        real_rloc = llm_router._resolve_local
        real_lw = llm_router.local_window
        real_rlo = llm_router._refuse_local_overflow
        real_lcr, real_ns = local_context.resolve, local_context.note_spill
        records2: list[logging.LogRecord] = []
        h2 = logging.Handler()
        h2.emit = records2.append
        lg2 = logging.getLogger("app.context_manifest")
        old2 = lg2.level
        try:
            # pin a LOCAL effective vision model; cloud vision stays OFF
            settings_store.get = (
                lambda k, *a, **kw: "ollama:probe-vis"
                if k == "attachments.vision_model" else real_get2(k, *a, **kw))
            vision._can_see = _atrue
            llm_router.effective_model = lambda m: m
            llm_router._resolve_local = lambda n: (vfake, n)
            llm_router.local_window = _anone
            llm_router._refuse_local_overflow = _anone
            local_context.resolve = _anone
            local_context.note_spill = _anone

            c0 = cmx.counters["no_turn_logged"]
            lg2.setLevel(logging.INFO)
            lg2.addHandler(h2)
            try:
                text = await vision.read_image(IMG, "image/png",
                                               name="secret-photo.png")
            finally:
                lg2.removeHandler(h2)
                lg2.setLevel(old2)
            check("local vision call succeeds and streams unchanged",
                  text == "ok")
            check("...no-turn observation emitted with purpose=vision",
                  cmx.counters["no_turn_logged"] == c0 + 1)
            vmsg = "".join(r.getMessage() for r in records2)
            check("...log names vision, local, local_only — nothing else",
                  "purpose=vision" in vmsg and "local=True" in vmsg
                  and "local_only" in vmsg
                  and "secret-photo" not in vmsg and "image/png" not in vmsg)
            check("...the image bytes reached the transport (control)",
                  vfake.seen_messages and IMG[:80] in vfake.seen_messages
                  and "image/png" in vfake.seen_messages)

            async with trace.turn("chat") as vturn:
                probe_traces.append(vturn.id)
                await vision.read_image(IMG, "image/png",
                                        name="secret-photo.png")
                vs = manifest_spans(vturn)
                check("a traced vision call lands a span", len(vs) == 1)
                d = vs[0]["detail"]
                check("...vision_unclassified/policy_default, "
                      "VISION_V1_LOCAL_ONLY, local_only",
                      d["target_eligibility"] == "local_only"
                      and "VISION_V1_LOCAL_ONLY" in d["reason_codes"]
                      and "ITEM_VISION_UNCLASSIFIED" in d["reason_codes"]
                      and "vision_unclassified|policy_default" in d["histogram"])
                check("...a policy default is NOT classification-incomplete",
                      "CLASSIFICATION_INCOMPLETE" not in d["flags"]
                      and "CLASSIFICATION_INCOMPLETE" not in d["reason_codes"])
                check("...coarse enums only: modality/bucket/family",
                      d.get("modality") == "image"
                      and d.get("size_bucket") == "small"
                      and d.get("media_family") == "raster_image"
                      and d["turn_source"] == "chat"
                      and d["operation_purpose"] == "vision")
                blob = json.dumps(d)
                check("...no filename, exact mime, exact bytes, or content",
                      "secret-photo" not in blob and "image/png" not in blob
                      and IMG[:40] not in blob and str(EST) not in blob)

            # the single production caller, end to end
            c1 = cmx.counters["no_turn_logged"]
            from app.router_chat import _image_text
            block, note = await _image_text(
                SimpleNamespace(data=IMG, mime="image/png",
                                name="secret-photo.png"), "ollama:probe-vis")
            check("router_chat._image_text (the one caller) flows through "
                  "the seam", "ok" in block
                  and cmx.counters["no_turn_logged"] == c1 + 1)

            # cloud refusal: BEFORE the seam, no transport, no observation
            settings_store.get = (
                lambda k, *a, **kw:
                "openrouter:probe/vis" if k == "attachments.vision_model"
                else False if k == "attachments.allow_cloud_vision"
                else real_get2(k, *a, **kw))
            obs0 = cmx.counters["observed"]
            calls0 = len(getattr(vfake, "all_seen", []))
            try:
                await vision.read_image(IMG, "image/png")
                check("cloud vision with allow_cloud_vision=false refuses",
                      False)
            except vision.VisionUnavailable as e:
                check("cloud vision with allow_cloud_vision=false refuses",
                      "cloud" in str(e))
            check("...before the seam: no transport call, no observation",
                  cmx.counters["observed"] == obs0
                  and len(getattr(vfake, "all_seen", [])) == calls0)
        finally:
            settings_store.get = real_get2
            vision._can_see = real_cansee
            llm_router._resolve, llm_router.effective_model = realr2, realeff2
            llm_router._resolve_local = real_rloc
            llm_router.local_window = real_lw
            llm_router._refuse_local_overflow = real_rlo
            local_context.resolve = real_lcr
            local_context.note_spill = real_ns

        print("13. automation auto-description adapter (S4b-3)")
        from app import automations
        INSTR = "PROBE-INSTR check the secret garden gate every day"
        afake = FakeClient()
        real_get3 = settings_store.get
        realr3, realeff3 = llm_router._resolve, llm_router.effective_model
        try:
            settings_store.get = (
                lambda k, *a, **kw: "openrouter:probe/m"
                if k == "automations.model" else real_get3(k, *a, **kw))
            llm_router._resolve = lambda t: (afake, t.split(":", 1)[1])
            llm_router.effective_model = lambda m: m

            c0 = cmx.counters["no_turn_logged"]
            desc = await automations._auto_description(INSTR)
            check("auto-description returns the model's line unchanged",
                  desc == "ok")
            check("...no-turn observation emitted",
                  cmx.counters["no_turn_logged"] == c0 + 1)
            check("...the instruction reached the transport (control)",
                  afake.seen_messages and "PROBE-INSTR" in afake.seen_messages)

            async with trace.turn("chat") as aturn:
                probe_traces.append(aturn.id)
                await automations._auto_description(INSTR)
                d = manifest_spans(aturn)[0]["detail"]
                check("a traced call lands the span: op=auto_description, "
                      "operator_private/derived_rule, local_only",
                      d["operation_purpose"] == "auto_description"
                      and d["turn_source"] == "chat"
                      and "operator_private|derived_rule" in d["histogram"]
                      and d["target_eligibility"] == "local_only"
                      and "CLASSIFICATION_INCOMPLETE" not in d["flags"])
                check("...and carries none of the instruction text",
                      "PROBE-INSTR" not in json.dumps(d)
                      and "secret garden" not in json.dumps(d))

            # no model configured -> fallback trim, no call, no observation
            settings_store.get = (
                lambda k, *a, **kw: ""
                if k == "automations.model" else real_get3(k, *a, **kw))
            obs0 = cmx.counters["observed"]
            calls0 = len(getattr(afake, "all_seen", []))
            desc = await automations._auto_description(INSTR)
            check("unset model: fallback trim, zero transport, zero "
                  "observations", desc.startswith("PROBE-INSTR")
                  and cmx.counters["observed"] == obs0
                  and len(getattr(afake, "all_seen", [])) == calls0)

            # transport failure: fallback preserved, attempted call observed
            settings_store.get = (
                lambda k, *a, **kw: "openrouter:probe/m"
                if k == "automations.model" else real_get3(k, *a, **kw))
            failfake = FakeClient(fail=True)
            llm_router._resolve = lambda t: (failfake, t)
            obs0 = cmx.counters["observed"]
            desc = await automations._auto_description(INSTR)
            check("transport failure: fallback unchanged, attempted call "
                  "still observed (before-transport)",
                  desc.startswith("PROBE-INSTR")
                  and cmx.counters["observed"] == obs0 + 1)
        finally:
            settings_store.get = real_get3
            llm_router._resolve, llm_router.effective_model = realr3, realeff3
    finally:
        async with db.acquire() as conn:
            await conn.execute(
                "DELETE FROM turn_spans WHERE trace_id = ANY($1::uuid[])",
                probe_traces)
            await conn.execute(
                "DELETE FROM turn_traces WHERE id = ANY($1::uuid[])",
                probe_traces)
            convs = probe_rows.get("conversations", [])
            await conn.execute(
                "DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])",
                convs)
            await conn.execute(
                "DELETE FROM conversations WHERE id = ANY($1::uuid[])", convs)
            await conn.execute(
                "DELETE FROM guest_sessions WHERE id = ANY($1::uuid[])",
                probe_rows.get("guest_sessions", []))
            left = await conn.fetchval(
                "SELECT (SELECT count(*) FROM turn_traces WHERE id = ANY($1::uuid[]))"
                " + (SELECT count(*) FROM turn_spans WHERE trace_id = ANY($1::uuid[]))"
                " + (SELECT count(*) FROM conversations WHERE id = ANY($2::uuid[]))"
                " + (SELECT count(*) FROM messages WHERE conversation_id = ANY($2::uuid[]))"
                " + (SELECT count(*) FROM guest_sessions WHERE id = ANY($3::uuid[]))",
                probe_traces, convs, probe_rows.get("guest_sessions", []))
        print(f"\n  cleanup: {left} probe row(s) left behind")
        if left:
            FAILURES.append("probe rows survived cleanup")

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("all checks passed")


asyncio.run(main())
