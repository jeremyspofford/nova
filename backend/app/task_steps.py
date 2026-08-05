"""A run that can stop, ask one question in chat, and carry on where it was.

Phase 3. Jeremy, 2026-08-05:

    "She needs to be able to go and do things on her own, figure it out,
     without me needing to do it for her while she explains to me like she's
     google what to do step by step."

...and, on where a question belongs: "Questions, if any, that need
clarification from me for nova, should be asked via chat."

Until now an approved card ran ONE executor call to completion. Everything
real is longer than that — start the thing, wait for it, check he can
actually reach it, say so — and a question in the middle ended the turn and
lost the position, so he re-explained from the top.

THE CONTRACT

An executor may declare `steps`: an ordered list of `(name, fn)`. Each `fn`
is `async (doc, rec, ctx) -> Optional[str]`, where the return value is the
receipt line the operator reads. The worker runs them in order and persists
`step_index` after each, so a backend restart resumes at the next step rather
than replaying the ones already done. That is the whole reason this is a
cursor and not a "re-run from the top and skip what looks finished"
convention: the steps here START SERVICES, and replaying them is not free.

To ask, a step raises `NeedAnswer(key, text)`. The run goes `blocked`, the
question is written to the row, and it is posted into the conversation the
card came from. When the operator replies, the answer lands on the row and
the SAME claim query picks the run back up — no second worker, no polling
loop of its own. The step that asked runs again with `ctx.answer` set.

WHY THE STEP RE-RUNS RATHER THAN CONTINUING AFTER THE RAISE: a Python
exception cannot be resumed, and pretending otherwise would need generators
or threads for no benefit. Ask FIRST in a step, before doing anything, and
the re-run is free. `NeedAnswer` is documented as belonging at the top of a
step for that reason, and `home_assistant`'s steps are written that way.

WHAT A STEP MAY NOT DO

Steps run with no operator present and no model in the loop — the package
docstring's "Approve never runs a model" still holds, and
`tests/test_recommendation_actions.py` walks the AST to keep an LLM client
out of this package. A step is Python reading a parsed document, exactly like
the single-shot executors it generalises.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger(__name__)


class NeedAnswer(Exception):
    """Raised by a step that cannot proceed without one thing from the operator.

    `key` names the answer so a step can tell "he has not answered yet" from
    "he answered, and this is it" on the re-run. `text` is what he reads in
    chat, and it is written to a person: name the choice, say what you would
    pick, and say what happens either way. A question that reads like a form
    field costs him the same turn a menu did.
    """

    def __init__(self, key: str, text: str):
        super().__init__(text)
        self.key = key
        self.text = text


@dataclass
class StepContext:
    """What a step is handed.

    `answer` is the operator's words verbatim for THIS run, or None. Not
    parsed here and never parsed in SQL: the step that asked is the only code
    that knows what the answer means.

    `record` appends a receipt line the card shows live, for progress inside a
    step that takes minutes. The step's return value is its final line and is
    recorded by the worker, so a step that returns a string does not need to
    call this at all.
    """

    answer: Optional[str] = None
    record: Callable[[str, str, str], Awaitable[None]] = None  # type: ignore[assignment]
    run_id: Any = None
    conversation_id: Optional[str] = None
    scratch: dict = field(default_factory=dict)

    def answered(self, key: str) -> Optional[str]:
        """The operator's answer if it was given for `key`, else None.

        Keyed so a two-question run cannot mistake the first answer for the
        second. The worker clears `answer` when a step completes, so a stale
        one never satisfies a later question.
        """
        if self.answer is None:
            return None
        return self.answer if self.scratch.get("answer_key") == key else None


Step = tuple[str, Callable[[Any, dict, StepContext], Awaitable[Optional[str]]]]


def question_for(key: str, text: str) -> dict:
    """The stored shape of a pending question. One place, so the row, the
    chat message and the answer lookup cannot disagree about the field names."""
    return {"key": key, "text": text}
