"""Observe-only context classification manifests (S4a, docs/DECISIONS.md).

For every in-backend model request, record what future cloud-egress
enforcement WOULD decide — while enforcing nothing. The router's
`stream_chat` is the mandatory seam: a call whose caller handed it a
Manifest (the runner builds one per turn and passes it explicitly — no
ambient state) records that manifest; any other call records an honest
missing-manifest observation (`purpose='unknown_nonrunner'`,
target='local_only', reason MISSING_MANIFEST) with the resolved
provider/model/locality. Enforcement, non-runner adapters, and all override
support are explicitly deferred (D-013/D-014 remain unimplemented).

OBSERVATION-OVERHEAD HONESTY (owner wording, S4a approval): "Observation is
bounded and best-effort. It must never alter model routing, fallback
selection, request content, prompt assembly, model output, tool behavior,
authorization, or error semantics. Observation failures are caught, produce
only bounded non-sensitive diagnostics/counters, and never fail the request.
The implementation may add bounded tracing/logging overhead; do not claim
zero latency impact. No synchronous network calls, unbounded database
queries, or expensive hashing may occur on the provider hot path."
Construction here is in-memory list appends and counters; span emission uses
the turn's existing in-memory span buffer; there is no hashing at all.

MANIFEST PRIVACY: entries are per-manifest ORDINALS carrying only
{source_kind, origin, data_class, class_source}. No raw content, prompts,
tool data, secret values, paths, titles, URLs, filenames, stable memory
IDs, conversation IDs, or persistent cross-trace hashes — and deliberately
no deterministic digests of item IDs. If cross-trace correlation is ever
needed, it will be a separately justified per-trace salted digest, not this.

TRUNCATION IS NOT INCOMPLETENESS: ITEM_LIST_TRUNCATED means the displayed
item list hit its bound but every input WAS classified — the aggregate
verdict is complete and a fully-classified public-only context stays
cloud-eligible. CLASSIFICATION_INCOMPLETE means an input was unclassified,
missing, or conflicted — and THAT forces target local_only, fail-closed.

V1 RULES ARE DELIBERATELY BLUNT: everything a runner turn assembles is the
operator's context (recall notes, history, skills → operator_private; the
soul slot → persona_core; guest turns → guest_demo), so in v1 essentially
no runner turn is target-cloud-eligible. That is the honest reading of the
interim cloud rule (D-014): the divergence between this verdict and the
observed route is the measurement this slice exists to take, not a bug.

`divergence_summary()` is TEST/ADMIN-ONLY (never scheduled, booted, or
exposed; scan-pinned) and hard-bounded: window <= 72h, rows <= 5000.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

log = logging.getLogger(__name__)

MANIFEST_VERSION = 2   # v2 (S4b-1, D-034): separate turn_source +
                       # operation_purpose fields; legacy `purpose` retained
                       # deprecated so v1 readers keep working; recorded v1
                       # spans are never reinterpreted.
                       # VERSIONING RULE (owner, S4b-2): bump the manifest
                       # version only when an existing field's semantic
                       # meaning, requiredness, encoding, or eligibility
                       # decision semantics changes. Additive optional
                       # metadata that decoders can ignore remains v2.
RULES_VERSION = 1

#: `vision_unclassified` (S4b-2) is a DELIBERATE v1 policy default — the
#: system knows the payload is an image and applies conservative local-only
#: policy until image-specific classification exists. It is distinct from
#: `unknown`, which means a genuine classification gap.
DATA_CLASSES = ("public_web", "engineering_unscanned", "operator_private",
                "household_member", "sensitive", "persona_core",
                "guest_demo", "vision_unclassified", "unknown")
#: Classes a cloud provider may receive (v1: public web only; engineering
#: requires a sanitization/scanning mechanism that does not exist yet).
CLOUD_ELIGIBLE = frozenset({"public_web"})

#: `policy_default` marks a deliberate conservative default (never counts
#: as CLASSIFICATION_INCOMPLETE — that is reserved for genuine gaps).
CLASS_SOURCES = ("derived_rule", "policy_default", "unknown", "conflict",
                 "missing")

ITEM_DISPLAY_MAX = 48
SUMMARY_WINDOW_MAX_H = 72
SUMMARY_ROW_LIMIT = 5000

#: In-process best-effort counters (bounded; reset with the process).
counters = {"observed": 0, "missing_manifest": 0, "no_turn_logged": 0,
            "emit_failures": 0, "divergent": 0}


class Manifest:
    __slots__ = ("purpose", "operation_purpose", "items", "histogram",
                 "items_total", "flags", "reasons",
                 "fallback_crossed_to_cloud",
                 # optional additive v2 metadata (S4b-2): bounded enums only
                 "modality", "size_bucket", "media_family")

    def __init__(self, purpose: str, *, operation_purpose: str | None = None):
        self.purpose = purpose                       # legacy v1 field, deprecated
        self.operation_purpose = operation_purpose   # v2; derived if None
        self.items: list[dict] = []          # bounded ordinal display list
        self.histogram: dict[str, int] = {}  # "class|source" -> count
        self.items_total = 0
        self.flags: set[str] = set()
        self.reasons: set[str] = set()
        self.fallback_crossed_to_cloud = False
        self.modality = None
        self.size_bucket = None
        self.media_family = None

    def note_fallback(self, crossed_to_cloud: bool) -> None:
        if crossed_to_cloud:
            self.fallback_crossed_to_cloud = True

    def add_items(self, source_kind: str, data_class: str,
                  class_source: str = "derived_rule", *, origin: str = "",
                  count: int = 1) -> None:
        """Constant-time per call: bounded list appends + a counter bump.
        Unknown classes/sources are recorded as such — fail closed, never
        raise on the hot path."""
        if data_class not in DATA_CLASSES:
            data_class, class_source = "unknown", "unknown"
        if class_source not in CLASS_SOURCES:
            class_source = "unknown"
        count = max(1, int(count))
        for _ in range(min(count, ITEM_DISPLAY_MAX - len(self.items))):
            self.items.append({"ordinal": len(self.items),
                               "source_kind": source_kind, "origin": origin,
                               "data_class": data_class,
                               "class_source": class_source})
        self.items_total += count
        key = f"{data_class}|{class_source}"
        self.histogram[key] = self.histogram.get(key, 0) + count
        if class_source in ("unknown", "conflict", "missing"):
            self.flags.add("CLASSIFICATION_INCOMPLETE")

    def finalize(self) -> tuple[str, list[str]]:
        """(target_eligibility, reason_codes) — fail closed."""
        reasons = set(self.reasons)
        if self.items_total > len(self.items):
            self.flags.add("ITEM_LIST_TRUNCATED")   # display-only; verdict complete
        if self.items_total == 0:
            self.flags.add("CLASSIFICATION_INCOMPLETE")
            reasons.add("NO_ITEMS")
        blocked = False
        for key, n in self.histogram.items():
            cls = key.split("|", 1)[0]
            if cls not in CLOUD_ELIGIBLE:
                blocked = True
                reasons.add(f"ITEM_{cls.upper()}")
        if "CLASSIFICATION_INCOMPLETE" in self.flags:
            blocked = True
            reasons.add("CLASSIFICATION_INCOMPLETE")
        return ("local_only" if blocked else "cloud_ok"), sorted(reasons)


async def observe(model: str, is_local: bool,
                  manifest: Optional[Manifest] = None) -> None:
    """The router seam: called after model resolution, BEFORE transport, so
    an attempted call is observable even when transport fails. The manifest
    is an EXPLICIT handoff from the caller (the runner passes the one it
    built for the turn) — no ambient state, so a finished turn can never
    contaminate a later unrelated call. Best-effort; every failure is
    caught into a counter — the request is never touched."""
    try:
        counters["observed"] += 1
        m = manifest
        if m is None:
            m = Manifest("unknown_nonrunner")
            m.flags.add("MISSING_MANIFEST")
            m.reasons.add("MISSING_MANIFEST")
            counters["missing_manifest"] += 1
        target, reasons = m.finalize()
        divergent = (not is_local) and target == "local_only"
        if divergent:
            counters["divergent"] += 1
        # v2 field split (D-034): turn_source is derived ONLY from the live
        # trace (authoritative, never declared or compounded);
        # operation_purpose is explicit or derived from the legacy value for
        # S4a callers. `purpose` stays as the deprecated v1 field.
        from app import trace
        turn = trace.current()
        op = m.operation_purpose or {
            "dispatch": "dispatch", "unknown_nonrunner": "unknown",
        }.get(m.purpose, "turn")
        payload = {
            "manifest_version": MANIFEST_VERSION,
            "rules_version": RULES_VERSION,
            "turn_source": turn.source if turn else None,
            "operation_purpose": op,
            "purpose": m.purpose,
            "override": "unavailable",
            "items_total": m.items_total,
            "items": m.items,
            "histogram": m.histogram,
            "flags": sorted(m.flags),
            "target_eligibility": target,
            "reason_codes": reasons,
            "observed_model": model,
            "observed_local": bool(is_local),
            "fallback_crossed_to_cloud": m.fallback_crossed_to_cloud,
            "divergent": divergent,
        }
        for opt in ("modality", "size_bucket", "media_family"):
            if getattr(m, opt, None):
                payload[opt] = getattr(m, opt)
        if turn is not None:
            try:
                async with trace.span("stage", "context_manifest") as sp:
                    sp.update(payload)
            except Exception:   # noqa: BLE001
                counters["emit_failures"] += 1
        else:
            # Restricted field set only — no item/context metadata.
            counters["no_turn_logged"] += 1
            log.info("context_manifest no-turn: purpose=%s op=%s local=%s "
                     "target=%s reasons=%s", m.purpose, op, bool(is_local),
                     target, ",".join(reasons))
    except Exception:   # noqa: BLE001 — observation never fails the request
        counters["emit_failures"] += 1


async def divergence_summary(hours: int = 24) -> dict:
    """TEST/ADMIN-ONLY (never scheduled, booted, or exposed — scan-pinned).
    Hard-bounded read over existing spans; window <= 72h, rows <= 5000."""
    hours = max(1, min(int(hours), SUMMARY_WINDOW_MAX_H))
    from app import db
    out = {"calls": 0, "manifested": 0, "missing": 0, "divergent": 0,
           "would_deny_fallbacks": 0, "by_purpose": {}, "gap_histogram": {}}
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT s.detail FROM turn_spans s JOIN turn_traces t "
            "ON t.id = s.trace_id WHERE s.name = 'context_manifest' "
            "AND t.started_at > now() - make_interval(hours => $1) "
            "ORDER BY t.started_at DESC LIMIT $2", hours, SUMMARY_ROW_LIMIT)
    for r in rows:
        try:
            d = json.loads(r["detail"]) if isinstance(r["detail"], str) \
                else (r["detail"] or {})
        except ValueError:
            continue
        out["calls"] += 1
        # v2 spans carry operation_purpose; v1 spans only the legacy field —
        # both decode, and recorded v1 rows keep their original meaning.
        purpose = d.get("operation_purpose") or d.get("purpose", "?")
        out["by_purpose"][purpose] = out["by_purpose"].get(purpose, 0) + 1
        if "MISSING_MANIFEST" in (d.get("flags") or []):
            out["missing"] += 1
        else:
            out["manifested"] += 1
        if d.get("divergent"):
            out["divergent"] += 1
        if d.get("fallback_crossed_to_cloud") and \
                d.get("target_eligibility") == "local_only":
            out["would_deny_fallbacks"] += 1
        for key, n in (d.get("histogram") or {}).items():
            if key.split("|", 1)[-1] in ("unknown", "conflict", "missing"):
                out["gap_histogram"][key] = out["gap_histogram"].get(key, 0) + n
    return out
