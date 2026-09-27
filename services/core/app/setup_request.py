"""Does the owner's message plainly ask for one of the four setups? (S47 follow-up)

Owner decision, 2026-09-26 (docs/plans/rebuild/s47/auto-card.md): "Core sends
the card. When your message plainly asks for one of the four setups, core runs
show_setup_qr itself, like nova_address's auto-run; she writes around the
result. The card never depends on the model. Cost: a phrase match decides, so a
false match shows an unasked card (for a machine, a 10-minute code)."

This module is that phrase match. It exists because of turn 798ccf87: asked
"How do I put you on my phone?", dell:qwen3:8b was advertised show_setup_qr,
made zero tool calls, and answered with an invented plan. Her calling the tool
was a request; the card going out is now a line of code (chat._run_turn).

PRECISION FIRST, because the two errors do not cost the same. A match that
should not have happened sends a card nobody asked for and, for a machine,
mints a live pairing code. A None costs nothing: the turn runs exactly as it
did before this module existed, and her own show_setup_qr call still works.
So every rule below narrows, and "when in doubt" is None:

  * The request is read at the START of a clause, after at most a few filler
    words ("please", "hey", "Nova,"), in one of a handful of request frames:
    the imperative, "can/could you", "how do I", "I want to", "help me", "is
    there a way to" — and for the app, "where do I" and "is there / do you
    have". A statement ("I put you on my phone yesterday", "I already did")
    starts no clause with a frame, so it asks for nothing; neither does a
    negation ("don't put you on my phone"), which is not a frame.
  * A clause runs to the end of its SENTENCE. A comma or an and/or/then/but
    ends it only where what follows is itself a request ("put you on my
    phone and add my laptop so you can control it" is two). Anywhere else
    what follows is part of it: "Can I pair my laptop and my phone?" names
    two things to pair, and "Put you on my phone, but not today" is not a
    request for now (review fix round 1).
  * The object is Nova herself (you, yourself, Nova) for the phone setup, her
    app for the app setup, and a device of his for the two machine setups —
    each device named by a word from a fixed list, never "any noun": "put my
    calendar on my phone" puts his calendar somewhere, not Nova.
  * The device ends the request. "my phone contacts", "my laptop's files",
    "my laptop to the shopping list" and "my laptop and my phone" are about
    something else. A phone is named with at most a listed modifier ("my new
    phone"), so "the speaker phone" is not one.
  * A machine request is held to more, because a false match mints a code.
    "add", "connect" and "link" must say it is to her or for her ("add my
    laptop so you can control it"): "add my laptop" alone is as likely a
    packing list, and "connect my laptop" could be to anything. Only "pair"
    and "enroll" mean pairing on their own. The machine is a computer word
    with at most a listed modifier ("my old linux server"), never any noun
    that ends in "machine" or "server" (a coffee machine, a Discord server).
    And nothing may follow it but a courtesy or a purpose about her, which
    is controlling, using or reaching it — "pair my laptop for the
    presentation" is someone else's pairing, and "so you can remind me to
    charge it" is a reminder.
  * Using a machine to RUN models is routing, not setting up a model server:
    only "use it to SERVE models" is that setup. "Set up an AI server" is a
    general question unless it says it is for her.
  * A word that could mean either setup is left alone: a phone is never a
    machine to pair (novad does not run on one), and "put you on my laptop"
    could be the web app or a machine she controls.
  * A message that takes it back ("never mind", "scratch that", or a bare
    "No." at the end) asks for nothing.
  * Two different setups in one message answer None: nothing is sent, and she
    can call for either herself.

It reads the MESSAGE and nothing else — never recalled memory, never an
earlier turn. He asked in so many words, or core does nothing.

Pure: no I/O, no clock, no app import. It runs on every turn that has a chat
to show a card in, synchronously inside core's event loop, so every pattern is
anchored at a clause start with only bounded repetition, and whitespace is
collapsed before any pattern sees it (tests/test_setup_request.py times 1,500
characters of padding, commas and conjunctions included, against the guard
family's 50 ms budget).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# The four setups show_setup_qr takes (tools/setup.py SETUPS), written out so
# this module imports nothing; tests/test_setup_request.py pins the two equal.
SetupKind = Literal["install_pwa", "get_app", "add_machine", "add_model_server"]

# Where a sentence ends. A clause never runs past one.
_SENTENCE_BREAK = re.compile(r"[.!?;:\n\r]+")
# Where a SECOND request may begin inside a sentence — a comma ("Nova, put
# yourself ...") or a conjunction ("... and pair my laptop"). A clause is cut
# here only where what follows is itself a request (_clauses); anywhere else
# it is part of the clause before it, and that clause's end has to take it.
_SOFT_BREAK = re.compile(r",| (?:and|but|then|or|also) ")
# A sentence that is only this, at the end, takes the request back: "Pair my
# laptop? No."
_TRAILING_NO = frozenset({"no", "nope", "nah", "no thanks", "no thank you"})
# Everything that is not a word character is a space by the time a pattern
# reads a clause, so a pattern never has to split a run of whitespace.
_NOT_WORDISH = re.compile(r"[^a-z0-9' ]+")
_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'", "´": "'"})
# A leading @mention addresses an agent (agents.mentioned); the request after
# it is read like any other.
_MENTION = re.compile(r"^\s*@[\w.-]+[\s,:]*")
# A message that takes the request back asks for nothing.
_CANCEL = re.compile(
    r"\b(?:never ?mind|nvm|scratch that|forget (?:it|that)|cancel (?:it|that)"
    r"|don't bother|no wait|wait no|not now)\b"
)

# -- the pieces --------------------------------------------------------------

# Words before the request that change nothing about it — a few at most, so a
# run of them is never walked to its end.
_FILLER = (
    r"(?:(?:please|pls|ok|okay|so|hey|hi|hello|nova|now|then|also|just|and|but|alright"
    r"|right|well|um|oh|quick question|real quick) ){0,4}"
)
# How a request is posed. The empty alternative last is the imperative.
_FRAME = (
    r"(?:(?:(?:can|could|would) you (?:please )?)?(?:tell|show) me how to "
    r"|(?:(?:can|could|would) you (?:please )?)?help me (?:to )?"
    r"|(?:can|could|would|will) you (?:please )?"
    r"|how (?:do|can|could|should|would|might) (?:i|we|you|one) "
    r"|how to "
    r"|(?:i|we)(?: want| wanna| need| would like|'d like| would love|'d love) (?:you )?to "
    r"|(?:can|could) (?:i|we) "
    r"|is there (?:a|any) way (?:for me |for us )?to "
    r"|(?:what's|what is) the (?:best |easiest |right )?way to "
    r"|let's "
    r"|)"
)
# Words after the request that change nothing about it.
_COURTESY = (
    r"(?: (?:please|pls|now|too|again|also|as well|real quick|for me|for you|for nova"
    r"|right now|today|tonight|thanks|thank you))*"
)
# How a phone request ends: nothing, a courtesy, or any purpose. A false match
# here costs a card and mints nothing.
_END = rf"{_COURTESY}(?: (?:so|because|since|for|if|when|once)\b.*)?$"
# A purpose that is about HER having the machine: controlling it, using it or
# reaching it. "so you can remind me to charge it" is a reminder, not a
# pairing (review fix round 1).
_NOVA_PURPOSE = (
    r" (?:so (?:that )?(?:you|nova) (?:can|could|will)|for (?:you|nova) to)"
    r" (?:control|use|reach)\b.*"
)
# How a machine request ends, which is stricter, because a false match mints
# a code: nothing, a courtesy, or a purpose about her. "Pair my laptop for the
# presentation" is someone else's pairing.
_MACHINE_END = rf"{_COURTESY}(?:{_NOVA_PURPOSE})?$"

_DET = r"(?:my|our|the|this|that|a|an|another|his|her|their)"
# Up to two words between the determiner and the device: "my new phone", "my
# wife's phone", "my old work laptop". Bounded, so it cannot backtrack.
_ADJ = r"(?:[a-z0-9][a-z0-9']* ){0,2}"

_PHONE = r"(?:phone|iphone|ipad|tablet|android|smartphone|cellphone|cell|mobile)"
# What may stand between the determiner and the phone. A LIST, like the
# machine's below: "the speaker phone" is not a phone to put her on (review
# fix round 1).
_PHONE_ADJ = (
    r"(?:(?:new|old|other|second|spare|work|personal|main|backup|android|apple|samsung"
    r"|google|pixel|[a-z]+'s) ){0,2}"
)
_HOME_SCREEN = r"(?:(?:my|the|your) )?(?:(?:phone|iphone|ipad|tablet)'s )?home ?screen"
# "on my phone", "on my new phone", "on Android".
_ON_A_PHONE = rf"(?:{_HOME_SCREEN}|(?:{_DET} {_PHONE_ADJ})?{_PHONE})"
_NOVA = r"(?:you|yourself|nova|(?:the |your )?(?:nova )?(?:web app|pwa))"

# A machine she can be paired with. No phone-class word: novad does not run on
# a phone, so "pair my phone" is not this setup.
_MACHINE = (
    r"(?:mac mini|macbook(?: pro| air)?|imac|mac|laptop|computer|desktop|pc|machine|server"
    r"|dell)"
)
# What may stand between the determiner and the machine. A LIST, not any word,
# because "machine" and "server" end a lot of nouns that are not computers — a
# coffee machine, a Discord server — and a false match here mints a code.
_MACHINE_ADJ = (
    r"(?:(?:new|old|other|second|spare|work|personal|home|main|gaming|office|backup|mini"
    r"|linux|windows|ubuntu|debian|dell|hp|lenovo|asus|acer|thinkpad|[a-z]+'s) ){0,2}"
)
_MACHINE_OBJ = rf"{_DET} {_MACHINE_ADJ}{_MACHINE}"
# "... to you", "... with Nova" — and nothing else after the device, so
# "connect my laptop to the TV" is not a pairing.
_WITH_NOVA = r" (?:to|with) (?:you|yourself|nova)"
_TO_NOVA = rf"(?:{_WITH_NOVA})?"

_PLATFORM = r"(?:iphone|ios|android|apple|mobile|phone|ipad|native|official|smartphone)"
# Her app, by name or by "your": "is there an app?" alone could be anyone's.
_APP_MINE = (
    rf"(?:(?:your|nova's) (?:{_PLATFORM} ){{0,2}}apps?"
    rf"|(?:(?:the|a|an) )?nova (?:{_PLATFORM} ){{0,2}}apps?)"
)
_APP_FOR = rf"(?: (?:for|on) (?:(?:my|the|a|an|this|your) )?(?:{_PLATFORM}|{_PHONE}))?"
# How an app request ends. No "for ..." past the platform one above: "an app
# for budgeting" is some other app.
_APP_END = rf"{_COURTESY}(?: (?:so|because|since|if|when|once)\b.*)?$"
_APP_VERB = r"(?:get|download|install|grab|find|send)"

# What a model server does. "use the Dell to RUN models" is routing — he wants
# his turns served from it — so "use" takes only "serve" (review fix round 1);
# the setup verbs ("set up the Dell to run models") keep all three.
_SERVE = r"(?:serve|serving|run|running|host|hosting)"
_SERVE_ONLY = r"(?:serve|serving)"
_MODELS = r"(?:(?:the|my|your|our|some|local|ai|big|large|language) ){0,2}(?:models|llms)"
_SERVER_KIND = r"(?:model|models|llm|ai|inference)"
# The model-server kinds specific enough to need no "for you": an "AI server"
# or an "inference server" is as likely anyone's.
_OWN_SERVER_KIND = r"(?:model|models|llm)"


def _as_model_server(serve: str) -> str:
    return (
        rf"(?: (?:to|for|and) {serve} {_MODELS}"
        rf"| as (?:a|an|my|the|your|our) {_SERVER_KIND} server"
        rf"| into (?:a|an) {_SERVER_KIND} server"
        rf"| (?:a|an) {_SERVER_KIND} server)"
    )


@dataclass(frozen=True)
class _Body:
    """One way to ask for a setup: the whole request, and how it OPENS.

    The opening is kept beside the pattern it was compiled into, so the
    opening test in _clauses (_OPENS) is built from the very same text and can
    never disagree with a request it would have to find."""

    whole: re.Pattern[str]
    opening: str
    framed: bool


def _framed(opening: str, rest: str) -> _Body:
    """A request posed in any request frame, at the start of a clause."""
    return _Body(re.compile(rf"{_FILLER}{_FRAME}{opening}{rest}"), opening, True)


def _bare(opening: str, rest: str) -> _Body:
    """A request that carries its own frame ("where do I ...", "is there ...")."""
    return _Body(re.compile(rf"{_FILLER}{opening}{rest}"), opening, False)


_PATTERNS: dict[str, tuple[_Body, ...]] = {
    "install_pwa": (
        # "How do I put you on my phone?", "Add you to my home screen". Not
        # "get you working/running on my phone": that is a question about one
        # that is already there (review fix round 1).
        _framed(
            r"(?:put|get|install|add|download|load|set up|setup)",
            rf" {_NOVA}(?: (?:set up|installed))? (?:on|onto|on to|to) {_ON_A_PHONE}{_END}",
        ),
        # "I want you on my phone"
        _bare(
            r"(?:i|we)(?: want| need|'d like| would like|'d love| would love) (?:you|nova)",
            rf"(?: (?:installed|set up))? (?:on|onto) {_ON_A_PHONE}{_END}",
        ),
    ),
    "get_app": (
        # "Get me the Nova app", "How do I download your Android app?"
        _framed(_APP_VERB, rf"(?: me)? {_APP_MINE}{_APP_FOR}{_APP_END}"),
        # "Where do I download your iPhone app?"
        _bare(
            rf"where (?:do|can|could|should|would) (?:i|we) {_APP_VERB}",
            rf" {_APP_MINE}{_APP_FOR}{_APP_END}",
        ),
        _bare(r"where(?:'s| is)", rf" {_APP_MINE}{_APP_FOR}{_APP_END}"),
        # "Is there a Nova app for Android?"
        _bare(
            r"(?:is|are) there",
            rf" (?:a|an|any) (?:nova|nova's) (?:{_PLATFORM} ){{0,2}}apps?{_APP_FOR}{_APP_END}",
        ),
        # "Is there an iPhone app for you?" — one app, hers. "Are there any
        # apps for you?" asks what exists, so it is not this (review fix
        # round 1).
        _bare(
            r"is there",
            rf" (?:a|an) (?:{_PLATFORM} ){{0,2}}app (?:for|of) (?:you|nova){_APP_FOR}{_APP_END}",
        ),
        # "Do you have an iPhone app?" — asked of her, so the app is hers.
        # "Do you have any apps?" is the same what-exists question.
        _bare(
            r"(?:do|does) (?:you|nova) have",
            rf" (?:a|an) (?:{_PLATFORM} ){{0,2}}app{_APP_FOR}{_APP_END}",
        ),
    ),
    "add_machine": (
        # "Pair my desktop with Nova" — the two verbs that mean pairing on
        # their own.
        _framed(r"(?:pair|enroll)", rf" {_MACHINE_OBJ}{_TO_NOVA}{_MACHINE_END}"),
        # "Add my laptop so you can control it.", "Connect my laptop to you" —
        # "add my laptop" alone is as likely a packing list as a pairing, and
        # "connect my laptop" could be to anything, so these verbs have to say
        # it is to her, or for her.
        _framed(
            r"(?:add|connect|link|hook up)",
            rf" {_MACHINE_OBJ}(?:{_WITH_NOVA}{_MACHINE_END}|{_COURTESY}{_NOVA_PURPOSE}$)",
        ),
        # "Set up my laptop so you can control it" — the same, for "set up".
        _framed(r"(?:set up|setup)", rf" {_MACHINE_OBJ}{_TO_NOVA}{_COURTESY}{_NOVA_PURPOSE}$"),
    ),
    "add_model_server": (
        # "Set up the Dell to serve models.", "set up the Dell as a model server"
        _framed(
            r"(?:set up|setup|add|pair|connect|make|turn|configure|enroll)",
            rf" {_MACHINE_OBJ}{_as_model_server(_SERVE)}{_MACHINE_END}",
        ),
        # "Use my desktop to serve models" — serve only (see _SERVE_ONLY).
        _framed("use", rf" {_MACHINE_OBJ}{_as_model_server(_SERVE_ONLY)}{_MACHINE_END}"),
        # "Add a model server"
        _framed(
            r"(?:add|pair|connect|enroll)",
            rf" (?:(?:a|an|another|the|my|one more) )?(?:new )?{_OWN_SERVER_KIND} server"
            rf"{_MACHINE_END}",
        ),
        # "How do I set up an AI server?" is a general question; "set up an
        # AI server for Nova" is this setup (review fix round 1).
        _framed(
            r"(?:add|pair|connect|set up|setup|enroll)",
            rf" (?:(?:a|an|another|the|my|one more) )?(?:new )?{_SERVER_KIND} server "
            rf"(?:for|to) (?:you|nova){_MACHINE_END}",
        ),
    ),
}
_BODIES: tuple[_Body, ...] = tuple(body for bodies in _PATTERNS.values() for body in bodies)
# How every request above OPENS, in one pattern: the framed openings after a
# frame, the bare ones after nothing. Built from _BODIES, never written out.
_OPENS = re.compile(
    rf"{_FILLER}(?:{_FRAME}(?:{'|'.join(b.opening for b in _BODIES if b.framed)})"
    rf"|(?:{'|'.join(b.opening for b in _BODIES if not b.framed)}))\b"
)
# How far into a break's tail a request's opening can reach: a few filler
# words, the longest frame and a verb, with room for stray punctuation.
_START_WINDOW = 160

_MORE_SPECIFIC = (("add_model_server", "add_machine"), ("get_app", "install_pwa"))


def _words(text: str) -> str:
    return " ".join(_NOT_WORDISH.sub(" ", text).split())


def _asked_in(clause: str) -> set[str]:
    found = {
        setup
        for setup, bodies in _PATTERNS.items()
        if any(body.whole.match(clause) for body in bodies)
    }
    for specific, general in _MORE_SPECIFIC:
        if specific in found:
            found.discard(general)
    return found


def _clauses(sentence: str) -> list[str]:
    """A sentence's clauses, as words: cut at a comma or a conjunction ONLY
    where what follows is itself a request (review fix round 1).

    Read right to left, so the text after a break is already a whole clause
    when it is tested: "A, B and C" cuts before C first, then asks whether B
    alone is a request. Where it is not, the break stays inside the clause and
    that clause's own end has to take what follows — so "pair my laptop and
    my phone" is one clause, and a machine's end takes nothing but a courtesy
    or a purpose about her. The cut exists to see a SECOND request, never to
    shorten the first.

    Every break's tail is first read only as far as a request's START can
    reach (_START_WINDOW): a tail that does not open like a request cannot be
    one, and reading the whole of every tail would make a message of commas
    quadratic."""
    clauses: list[str] = []
    end = len(sentence)
    for brk in reversed(list(_SOFT_BREAK.finditer(sentence))):
        opening = _words(sentence[brk.end() : min(end, brk.end() + _START_WINDOW)])
        if not _OPENS.match(opening):
            continue
        tail = _words(sentence[brk.end() : end])
        if tail and _asked_in(tail):
            clauses.append(tail)
            end = brk.start()
    head = _words(sentence[:end])
    if head:
        clauses.append(head)
    return clauses


def setup_request(message: str) -> SetupKind | None:
    """The one setup the owner's message plainly asks for, or None.

    None whenever it is not plain: no request frame, an object that is not
    Nova or a device of his, something else coordinated with it, a request
    taken back, or two different setups in one message. See the module
    docstring for why every doubt is None."""
    if not isinstance(message, str) or not message.strip():
        return None
    text = _MENTION.sub("", message.lower().translate(_APOSTROPHES))
    if _CANCEL.search(_words(text)):
        return None
    sentences = [raw for raw in _SENTENCE_BREAK.split(text) if _words(raw)]
    if sentences and _words(sentences[-1]) in _TRAILING_NO:
        return None
    asked: set[str] = set()
    for sentence in sentences:
        for clause in _clauses(sentence):
            asked |= _asked_in(clause)
    if len(asked) != 1:
        return None
    (only,) = asked
    return only  # type: ignore[return-value]
