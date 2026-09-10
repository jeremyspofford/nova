"""The fixture corpus behind test_recall_quality.py, and the cases it scores.

Why a fixture and not the live volume. The measurement that produced
`recall_baseline_2026-09-09.json` was run against Jeremy's real notes on the
running service. That is not reproducible on a clean checkout and it is not
runnable in CI, so the suite that has to survive the next twelve slices builds
its own store from files that carry the same SHAPE as his — and the shape is
the whole diagnosis, so it is copied deliberately, measured feature by
measured feature:

  * seven day-journals and one short topic note, eight documents in total,
    which is what makes "the right file is in the top 5" nearly meaningless
    at k=5;
  * per-file sizes and per-exchange lengths taken from the real corpus
    (1.2 KB to 21 KB, the newest day the largest by a factor of three, one
    day carrying a single 9.8 KB pasted message);
  * a day is one document of `## HH:MM` exchanges, appended through the same
    `store.append_journal` the running service uses, so the file on disk here
    is structured exactly like the file on disk there;
  * the same subjects recur across days (the agents, the device runs, the
    machine, the news digests), because that overlap is what lets one big
    recent file win every query;
  * conversational filler at conversational density — the terms that supply
    ~60% of the winning score today are the ordinary words of every question.

What is NOT copied is his text. The prose is written for the fixture; only the
FACTS the twenty questions ask about are kept, because the questions are fixed
by the committed baseline and an answer has to be the answer to the question
that was asked.

Dates are rebased to the run date (day 0 = today, day 9 = nine days ago) rather
than frozen at 2026-09-09, so the recency multiplier sees the same ages this
year and next; a frozen corpus would slowly stop being recent and quietly stop
measuring the thing it was written to measure.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from app.store import MemoryStore, split_entries

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "recall_corpus"
# The distilled notes, produced by services/core's real distiller over the
# transcript above and committed. See distilled_files().
DISTILLED_DIR = FIXTURE_DIR / "distilled"
BASELINE_PATH = Path(__file__).resolve().parent / "recall_baseline_2026-09-09.json"

# The day the baseline was measured. Baseline paths name real dates; the
# fixture names day offsets. This is the only thing that translates between
# them, and it is what lets the suite check mechanically that it is still
# asking the same twenty questions of the same eight documents.
BASELINE_TODAY = date(2026, 9, 9)

# One person's partition, as production shapes it (a uuid string).
PERSON_ID = "0f9b751c-b010-4a6b-8260-6a6255593a70"

TOPIC_SLUG = "hardware-spec-local-llm-box"
TOPIC_TITLE = "Hardware spec, local LLM box"
TOPIC_KEY = "topic"

_SECTION_RE = re.compile(r"^## (\d\d:\d\d)$", re.M)


@dataclass(frozen=True)
class Case:
    """One question, the documents that hold its answer, and the answer.

    `answer` is the regex the returned snippet has to contain for the fact to
    have reached the model — the measurement, not a proxy for it. `targets`
    are fixture keys ("day-09", "topic"), resolved to rel paths once the
    corpus is built.
    """

    id: str
    question: str
    targets: tuple[str, ...]
    answer: str
    answer_says: str


@dataclass(frozen=True)
class AbsentCase:
    """A question whose answer is genuinely nowhere in the corpus.

    `forbidden` is asserted NOT to appear anywhere in the fixture, so "the
    answer is absent" is a checked property of the corpus rather than a claim
    in a docstring. Overlapping ordinary words are fine and wanted — a person
    asking about a cat still says "did I ever mention" — because the question
    being answerable by chance is exactly the failure being measured.
    """

    id: str
    question: str
    forbidden: tuple[str, ...]


# The twenty. Question text and target documents come from the committed
# baseline (checked in test_recall_quality.py, not trusted here); the answer
# regexes are what the fixture puts in those documents.
CASES: tuple[Case, ...] = (
    Case(
        "Q01",
        "how much graphics memory does my machine have?",
        (TOPIC_KEY, "day-09"),
        r"24\s?GB",
        "24GB of VRAM on the card",
    ),
    Case(
        "Q02",
        "what kind of computer are you running on?",
        ("day-08",),
        r"WSL2",
        "Ubuntu under WSL2 on a Windows host",
    ),
    Case(
        "Q03",
        "what have I been working on lately?",
        ("day-00",),
        r"KV cache offload",
        "KV cache offloading",
    ),
    Case(
        "Q04",
        "did I ask you to nudge me about anything on a repeating basis?",
        ("day-02",),
        r"\bblink\b|\bstretch\b",
        "a five-minute blink reminder",
    ),
    Case(
        "Q05",
        "what did we decide about keeping my credentials safe?",
        ("day-00",),
        r"op\.env|1Password",
        "one op.env per machine, the rest in the vault",
    ),
    Case(
        "Q06",
        "which little helper did I set up to take notes for me?",
        ("day-01",),
        r"\bscribe\b",
        "the agent called scribe",
    ),
    Case(
        "Q07",
        "what happened to the assistant that was writing files for me?",
        ("day-01", "day-00"),
        r"coder[^.]{0,80}delet|delet[^.]{0,80}coder",
        "the coder agent was deleted",
    ),
    Case(
        "Q08",
        "read me back that short poem about the cold season",
        ("day-01",),
        r"Snow whispers",
        "Snow whispers softly, …",
    ),
    Case(
        "Q09",
        "how should I be installing command line programs from now on?",
        ("day-00",),
        r"\bmise\b",
        "with mise",
    ),
    Case(
        "Q10",
        "is that vault app set up on my desktop yet?",
        ("day-00",),
        r"1Password is not installed|which op",
        "1Password is not installed on this machine",
    ),
    Case(
        "Q11",
        "did you ever write up that document I asked you for?",
        ("day-00",),
        r"proposal_from_nova\.md",
        "proposal_from_nova.md",
    ),
    Case(
        "Q12",
        "when does caching ahead of time stop being worth it?",
        ("day-00",),
        r"90%|prefetch hit rate",
        "below a 90% prefetch hit rate",
    ),
    Case(
        "Q13",
        "which brain is answering me right now?",
        ("day-00", "day-01"),
        r"qwen3",
        "qwen3:27b, locally",
    ),
    Case(
        "Q14",
        "how much money have I burned through so far?",
        ("day-01",),
        r"\$0\.0005|spent today",
        "$0.0005 spent today",
    ),
    Case(
        "Q15",
        "what's my desktop called?",
        ("day-08", "day-07", "day-06"),
        r"DELL-XPS-8950",
        "DELL-XPS-8950",
    ),
    Case(
        "Q16",
        "where do I keep all my projects?",
        ("day-07", "day-06"),
        r"/home/jeremy/workspace|alertventure",
        "under /home/jeremy/workspace",
    ),
    Case(
        "Q17",
        "is there a program on my box for showing folder layouts?",
        ("day-06",),
        r"\btree\b",
        "the tree program is installed",
    ),
    Case(
        "Q18",
        "how many goes does my note taker get on a job?",
        ("day-01",),
        r"six tool round",
        "six tool rounds per job",
    ),
    Case(
        "Q19",
        "how much am I letting that note taker spend each month?",
        ("day-01",),
        r"two dollar|\$2\b",
        "a two dollar monthly ceiling",
    ),
    Case(
        "Q20",
        "how much regular memory does this box have besides the card?",
        (TOPIC_KEY, "day-09"),
        r"64\s?GB",
        "64GB of system RAM",
    ),
)

# The absent-answer set. Decision 1 of the slice — "recall may return nothing,
# and says so" — is only real if something measures how often it returns
# something for a question it has no answer to.
ABSENT_CASES: tuple[AbsentCase, ...] = (
    AbsentCase("A01", "did I ever mention my cat?", (r"\bcats?\b", r"\bkitten")),
    AbsentCase("A02", "when is my dentist appointment?", (r"\bdentist", r"\bdental\b")),
    AbsentCase("A03", "what's my sister's phone number?", (r"\bsister", r"\bsibling")),
    AbsentCase(
        "A04", "what did I decide about refinancing the mortgage?", (r"\bmortgage", r"\brefinanc")
    ),
    AbsentCase(
        "A05",
        "which allergy medication did I say I take?",
        (r"\ballerg", r"\bmedication", r"\bprescription"),
    ),
    AbsentCase("A06", "what's my neighbour called?", (r"\bneighbou?r",)),
)


def _parse_day(text: str) -> list[tuple[str, str, str]]:
    """A fixture day file → [(HH:MM, user text, assistant text)].

    The file is written in the on-disk journal's own shape, so this parser is
    the inverse of what store.append_journal writes, and a fixture that does
    not parse fails here rather than being half-ingested.
    """
    parts = _SECTION_RE.split(text)[1:]
    if not parts or len(parts) % 2:
        raise ValueError("fixture day has no '## HH:MM' sections")
    exchanges = []
    for i in range(0, len(parts), 2):
        at, body = parts[i], parts[i + 1]
        if "User:" not in body or "\n\nAssistant:" not in body:
            raise ValueError(f"fixture exchange at {at} is not a User/Assistant pair")
        user = body.split("User:", 1)[1].split("\n\nAssistant:")[0].strip()
        assistant = body.split("\n\nAssistant:", 1)[1].strip()
        exchanges.append((at, user, assistant))
    return exchanges


def fixture_files() -> dict[str, Path]:
    """Fixture key -> source file. "day-NN" for journals, "topic" for the note."""
    files = {p.stem: p for p in sorted(FIXTURE_DIR.glob("day-*.md"))}
    files[TOPIC_KEY] = FIXTURE_DIR / f"topic-{TOPIC_SLUG}.md"
    return files


def distilled_files() -> list[Path]:
    """The distilled notes, oldest day first.

    NOT hand-written. They are what app/distil.py produced from the very
    transcript in this directory, generated by services/core/tests/
    recall_distilled.py and committed — the same discipline as the recorded
    vectors next door, and for a sharper reason: a note written by someone who
    has read the twenty questions measures that person, not distillation, and
    would move the floor on a number that flatters the slice.

    Oldest first because superseding is last-write-wins by subject: writing
    them newest-first would leave the OLDEST statement of every restated fact
    as the live note. The day offset is in the filename, and it counts
    BACKWARDS, so sorting descending on it is chronological order.
    """
    return sorted(
        (DISTILLED_DIR.glob("*.md") if DISTILLED_DIR.is_dir() else []),
        key=lambda path: (-_note_offset(path), path.name),
    )


def _note_offset(path: Path) -> int:
    """The day offset a distilled note came from, off its own filename
    ("day-07-00-something.md" -> 7)."""
    return int(path.stem.split("-")[1])


def fixture_text() -> str:
    """Every fixture document's raw text, concatenated. Used to check the
    corpus really does hold the answers it claims and really does not hold the
    absent ones.

    The distilled notes are IN here, and they have to be: the absent-answer
    questions are only meaningful while their answers are genuinely nowhere,
    and a note is a document recall can return like any other. A distilled
    note that happened to contain one would silently turn six honest
    unanswerables into something less.
    """
    texts = [p.read_text(encoding="utf-8") for p in fixture_files().values()]
    texts += [p.read_text(encoding="utf-8") for p in distilled_files()]
    return "\n".join(texts)


def day_offset(key: str) -> int:
    return int(key.split("-")[1])


def build(root: Path, *, today: date | None = None) -> dict[str, str]:
    """Write the fixture corpus under `root` and return key -> rel_path.

    Journals go in through store.append_journal, one call per exchange with the
    entry text /ingest composes, so the bytes on disk — frontmatter, headings,
    ordering — are what the running service would have written. The topic note
    goes in through write_topic, dated with the oldest day so it is both the
    smallest and the least recent document, as the real one is.
    """
    today = today or datetime.now(UTC).date()
    store = MemoryStore(root)
    rel_paths: dict[str, str] = {}
    for key, path in fixture_files().items():
        text = path.read_text(encoding="utf-8")
        if key == TOPIC_KEY:
            body = text.split("\n", 2)[2].strip()
            abs_path = store.write_topic(
                PERSON_ID,
                TOPIC_SLUG,
                TOPIC_TITLE,
                body,
                created=today - timedelta(days=9),
            )
            rel_paths[key] = store.rel_path(abs_path)
            continue
        day = today - timedelta(days=day_offset(key))
        for at, user, assistant in _parse_day(text):
            hour, minute = (int(x) for x in at.split(":"))
            when = datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC)
            abs_path, _ = store.append_journal(
                PERSON_ID, f"User: {user}\n\nAssistant: {assistant}", when=when
            )
        rel_paths[key] = store.rel_path(abs_path)

    # The distilled notes, last and oldest-day-first. Last because they are the
    # newest documents in the corpus; oldest-first among themselves because
    # superseding is last-write-wins by subject, so any subject two notes share
    # must end up live on the NEWER statement of it.
    for path in distilled_files():
        meta, body = _note_parts(path)
        created = today - timedelta(days=_note_offset(path))
        abs_path = store.write_topic(
            PERSON_ID,
            path.stem,
            meta["title"],
            body,
            created=created,
            subject=meta.get("subject"),
            said_at=created,
            source=meta.get("source"),
            live_source=meta.get("live_source"),
        )
        rel_paths[path.stem] = store.rel_path(abs_path)
    return rel_paths


def _note_parts(path: Path) -> tuple[dict, str]:
    """A distilled note's frontmatter and body.

    A narrow reader of the shape recall_distilled.py writes, not a YAML parser:
    scalars, plus the two nested blocks (`source`, `live_source`) that carry
    the citation and the live call. It raises on anything it does not
    recognise, because a fixture that half-loads is worse than one that fails —
    a note silently missing its `subject` would silently stop superseding, and
    the measurement would move for a reason nobody could see.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{path.name}: no frontmatter")
    meta: dict = {}
    nested: str | None = None
    index = 1
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            break
        if not line.strip():
            continue
        depth = len(line) - len(line.lstrip())
        key, sep, value = line.strip().partition(":")
        if not sep:
            raise ValueError(f"{path.name}: cannot read frontmatter line {line!r}")
        value = value.strip()
        if depth == 0:
            nested = key if not value else None
            meta[key] = {} if nested else value
        elif nested and depth == 2:
            if value:
                meta[nested][key] = value
            else:
                meta[nested][key] = {}
                nested = f"{nested}.{key}"
        elif nested and depth == 4:
            parent, _, child = nested.partition(".")
            meta[parent][child][key] = value
        else:
            raise ValueError(f"{path.name}: unexpected indent in {line!r}")
    return meta, "\n".join(lines[index + 1 :]).strip()


def units_by_key(root: Path, rel_paths: dict[str, str]) -> dict[str, int]:
    """How many UNITS each fixture document is indexed as.

    S13 chunks a journal at its "## HH:MM" headings, index-side, so the store is
    still eight documents but recall ranks and returns dozens of exchanges. Any
    measurement phrased in "the whole store" or "by chance" has to count what
    recall actually ranks, or it silently starts measuring something else — this
    reads it from the files on disk, through the same splitter the index uses.
    """
    store = MemoryStore(root)
    keys = {rel: key for key, rel in rel_paths.items()}
    counts: dict[str, int] = {}
    for stored in store.iter_all():
        key = keys.get(stored.rel_path)
        if key is None:
            raise AssertionError(f"the fixture built a file nothing names: {stored.rel_path}")
        counts[key] = len(split_entries(stored.body)) or 1
    return counts


def baseline_rows() -> list[dict]:
    """The committed measurement, as measured against the real corpus."""
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def baseline_target_keys(row: dict) -> set[str]:
    """A baseline row's target paths, translated into fixture keys.

    "journals/2026-08-31.md" was nine days before the measurement, so it is
    "day-09" here; the one topic note is "topic".
    """
    keys = set()
    for target in row["targets"]:
        if target.startswith("topics/"):
            keys.add(TOPIC_KEY)
            continue
        when = date.fromisoformat(Path(target).stem)
        keys.add(f"day-{(BASELINE_TODAY - when).days:02d}")
    return keys
