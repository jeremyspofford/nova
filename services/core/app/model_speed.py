"""How fast a model is generating, and how fast it usually is here.

No new probe, no configuration, no benchmark run. Every `llm_call` span
already carries the gateway's own `completion_tokens` and the round's own
timings, so throughput is arithmetic over rows this system already writes.

## Why throughput and not free memory
Free VRAM alone would have missed the failure this module exists for. On
2026-09-12 a video game held ~7 GB of the card, which mattered, and it also
held the shader cores at 347 W, which no memory reading sees at all. The
honest measure of "is this card available to me" is how fast tokens come
out: the 27B measured 0.25 tok/s during it, and 67.5 tok/s with the game
closed. A 270-fold collapse, on a card that still had memory free.

## Generation only
`tok_per_s` divides completion tokens by the time from the model's FIRST
EMITTED TOKEN to the end of the stream — not by the whole round. The time
before that is prompt processing, and folding it in would make a turn with
a very large prompt look like a degraded card. That time is not discarded:
it is its own field, `prefill_ms`.

"First emitted token" means content, reasoning, OR a tool-call fragment,
and getting that wrong broke this module twice on 2026-09-15:

  * It was the first CONTENT delta. A thinking model emits reasoning first,
    for as long as it likes, and the gateway counts those tokens in
    `completion_tokens` — so the numerator included the thinking and the
    denominator excluded the time spent on it. Rounds were recorded at
    1 777, 1 918 and 1 927 tok/s on a single 24 GB card. `degraded` reads
    this field; it was reading a fiction that could only ever point upward,
    which is the direction that never raises a finding.
  * A round that only CALLS TOOLS emits no content at all, so it recorded
    no rate — and `_RATES_SQL` below skips a span without one. Tool rounds
    are most of a working turn, so most of the evidence was being dropped
    before it reached the median. That is why, on an evening of 100-400 s
    turns with the card pinned at 99%, this reported "nothing to measure".

Both are one fix: prefill ends at the first thing the model emits.

## A card can be too contended to measure at all
Walked on the live stack 2026-09-14, and this is the limit that walk found.
When the owner asked "what's the GPU doing", his turn waited the gateway's
full 300 s and received ZERO data lines — the card was so contended that
not one token came out. A round that produces nothing produces no rate
either, so `tok_per_s` is absent and the medians below have nothing to
read: the worst possible state of the machine is invisible to the very
measurement built to notice it.

`stalls()` is the other half. A round that timed out in its READ phase
having written nothing is a hard fact about the machine, filed on the same
span, and needs no token to exist. Between them: a card that is slow is
caught by the rate, and a card that is stopped is caught by the stalls.

## A baseline is history, never a constant
"Normal" for a model is what THIS machine has actually done with it, read
from the same spans. A model that has always been slow here has a slow
baseline and is never reported as degraded; a fast one that collapses is
caught on the first beat. Nobody maintains a table of expected speeds, so
nobody has to remember to update one when the hardware changes.

The median, not the mean: one 300 s timeout among twenty healthy rounds
would drag a mean below any threshold, and the point is to notice a card
that is genuinely contended, not a single bad round.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

import asyncpg

# A round has to produce enough tokens for its rate to mean anything. Two
# tokens over a tenth of a second is noise about scheduling, not a
# measurement of throughput.
MIN_TOKENS_FOR_A_RATE = 16

# How many recent rounds a model needs before "recent" is a measurement
# rather than an anecdote. One sample is not a measurement — the corpus
# runs taught that the hard way (memory: one-sample-is-not-a-measurement).
MIN_ROUNDS_RECENT = 3
# And how many the baseline needs before it is worth comparing against.
MIN_ROUNDS_BASELINE = 10

# The windows, in hours. "Recent" is what is happening now; the baseline is
# long enough to average over a machine's ordinary days, and deliberately
# OVERLAPS recent rather than excluding it — a genuinely long outage should
# eventually move the baseline too, so the system stops shouting about a
# state that has become this machine's normal.
RECENT_HOURS = 2
BASELINE_HOURS = 24 * 30


def tok_per_s(completion_tokens: int | None, generation_ms: int | None) -> float | None:
    """Tokens per second for one round, or None when it is not a
    measurement.

    None — never zero, never a guess — when the gateway stated no token
    count, when the round produced too few tokens to say anything, or when
    the elapsed time is not positive. A null is not a measurement, and a
    zero here would read as "the card is dead".
    """
    if not completion_tokens or completion_tokens < MIN_TOKENS_FOR_A_RATE:
        return None
    if not generation_ms or generation_ms <= 0:
        return None
    return round(completion_tokens / (generation_ms / 1000), 2)


@dataclass(frozen=True)
class Speed:
    """One model's throughput picture. Every field is a fact or a None."""

    model: str
    recent: float | None
    recent_rounds: int
    baseline: float | None
    baseline_rounds: int

    @property
    def ratio(self) -> float | None:
        """How many times slower than usual, or None when either half is
        unknown. Greater than 1 means slower than this machine's normal."""
        if self.recent is None or not self.baseline:
            return None
        if self.recent <= 0:
            return None
        return round(self.baseline / self.recent, 1)

    def as_dict(self) -> dict:
        return {
            "model": self.model,
            "recent_tok_per_s": self.recent,
            "recent_rounds": self.recent_rounds,
            "baseline_tok_per_s": self.baseline,
            "baseline_rounds": self.baseline_rounds,
            "ratio": self.ratio,
        }


_RATES_SQL = """
    SELECT (meta->>'model') AS model, (meta->>'tok_per_s')::float8 AS rate
      FROM turn_spans
     WHERE kind = 'llm_call'
       AND meta ? 'tok_per_s'
       AND started_at >= now() - ($1 || ' hours')::interval
       AND ($2::text IS NULL OR meta->>'model' = $2)
"""


async def _rates(pool: asyncpg.Pool, hours: int, model: str | None) -> dict[str, list[float]]:
    rows = await pool.fetch(_RATES_SQL, str(hours), model)
    out: dict[str, list[float]] = {}
    for row in rows:
        if row["model"] and row["rate"]:
            out.setdefault(row["model"], []).append(row["rate"])
    return out


async def speed_of(pool: asyncpg.Pool, model: str) -> Speed:
    """One model's recent and baseline medians."""
    return (await speeds(pool, model=model)).get(model) or Speed(model, None, 0, None, 0)


async def speeds(pool: asyncpg.Pool, model: str | None = None) -> dict[str, Speed]:
    """Every model with rounds in the baseline window, keyed by model.

    Two queries, not one per model: a beat check runs over whatever has
    been serving lately and must not turn into a query per name.
    """
    recent = await _rates(pool, RECENT_HOURS, model)
    baseline = await _rates(pool, BASELINE_HOURS, model)
    out: dict[str, Speed] = {}
    for name in set(recent) | set(baseline):
        recent_rates = recent.get(name, [])
        baseline_rates = baseline.get(name, [])
        out[name] = Speed(
            model=name,
            recent=(
                round(statistics.median(recent_rates), 2)
                if len(recent_rates) >= MIN_ROUNDS_RECENT
                else None
            ),
            recent_rounds=len(recent_rates),
            baseline=(
                round(statistics.median(baseline_rates), 2)
                if len(baseline_rates) >= MIN_ROUNDS_BASELINE
                else None
            ),
            baseline_rounds=len(baseline_rates),
        )
    return out


# How many rounds must have produced NOTHING before that is the machine
# rather than an event. One read timeout is an event — a model being pulled
# underneath a turn, a restart landing mid-stream. Two in the recent window
# is a pattern, and the window is short enough that two arrive quickly.
MIN_STALLED_ROUNDS = 2


@dataclass(frozen=True)
class Stalls:
    """How many of a model's recent rounds produced nothing at all."""

    model: str
    walled: int
    rounds: int

    def as_dict(self) -> dict:
        return {"model": self.model, "walled_rounds": self.walled, "rounds": self.rounds}


_STALLS_SQL = """
    SELECT (meta->>'model') AS model,
           count(*) AS rounds,
           count(*) FILTER (
               WHERE meta->>'timeout_phase' = 'read'
                 AND coalesce((meta->>'completion_chars')::int, 0) = 0
           ) AS walled
      FROM turn_spans
     WHERE kind = 'llm_call'
       AND started_at >= now() - ($1 || ' hours')::interval
       AND meta ? 'model'
  GROUP BY 1
"""


async def stalls(pool: asyncpg.Pool, hours: int = RECENT_HOURS) -> dict[str, Stalls]:
    """Per model, how many recent rounds waited out the gateway's read
    timeout having written nothing.

    This is the signal that survives a card nobody can get a token out of.
    `tok_per_s` needs a token; this needs only the absence of one, and the
    span already records both halves of that absence — `timeout_phase` and
    `completion_chars`.
    """
    rows = await pool.fetch(_STALLS_SQL, str(hours))
    return {
        row["model"]: Stalls(model=row["model"], walled=row["walled"], rounds=row["rounds"])
        for row in rows
        if row["model"]
    }
