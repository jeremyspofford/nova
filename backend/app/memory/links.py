"""Wiki-links: one resolver, one writer.

A `[[link]]` resolves by TITLE, never by filename. That is why renaming a
note's file is safe and editing its `title:` is not: the file rename moves an
address nothing points at, while the title change orphans every inbound link
at once. On the live corpus one source note carries 60 of them.

Everything here is computed. Extracting a link is a regex, resolving one is a
dict lookup, and deciding whether a title changed is comparing the old bytes
to the new — there is no judgement anywhere in this module, and it makes no
model calls. The one link job that WOULD need a model is proposing links that
ought to exist but were never written; that is a different feature, it lives
behind `_link_pass`, and it is deliberately not on the save path (its output
is what made a no-op save rewrite 203 of 214 topics).

Three properties this module exists to hold, each measured against the real
corpus rather than assumed:

  - Match the whole `[[...]]` token, never the bare title text. 65 title pairs
    have one title as a substring of another (`X — full transcript` inside
    `X — full transcript — summary`); the closing brackets are what make
    `[[A]]` structurally unable to sit inside `[[A B]]`.
  - Replace through a CALLBACK, never a template. 50 of 97 link targets
    contain regex metacharacters, including a title beginning `$5 VPS…`, and
    `re.sub` expands backreferences in a template string but not in a
    callable's return value.
  - Do NOT parse `[[target|alias]]` or `[[target#heading]]`. Two live titles
    contain a literal `|`, so teaching the regex about aliases would break
    links that work today.
"""

import hashlib
import logging
import os
from typing import Optional

from app.memory.store import _WIKILINK_RE, OkfStore, write_text_atomic

log = logging.getLogger(__name__)


def key(s: str) -> str:
    """The one normalisation. Link resolution has always been
    case-insensitive and whitespace-trimmed; saying so once means the graph
    and the rewriter cannot drift apart on what counts as the same title."""
    return (s or "").lower().strip()


def title_map(store: OkfStore) -> dict[str, list[str]]:
    """Every title in the corpus -> the doc_ids claiming it.

    A LIST, not a single doc_id, because a duplicate title is a fact worth
    seeing rather than a last-writer-wins race: the graph builds this as a
    plain dict assignment over sorted files, so today a collision would hand
    every inbound link to the alphabetically-last note and make the other
    unreachable, silently.

    A note with no frontmatter title contributes NO key. The graph falls back
    to the doc_id for a display label, which would otherwise put the literal
    string 'journals/2026-07-13.md' into the namespace a retarget searches —
    and that journal is exactly the untitled note in the live corpus.
    """
    out: dict[str, list[str]] = {}
    for doc_id, _ in store.iter_files():
        parsed = store.read_file(doc_id)
        if not parsed:
            continue
        title = parsed[0].get("title")
        if not title or not key(title):
            continue
        out.setdefault(key(title), []).append(doc_id)
    return out


def scan(store: OkfStore) -> tuple[dict[str, list[str]], dict[str, list[tuple[str, float, int]]]]:
    """One pass of the corpus, returning both maps it can build from it.

    Opening a note used to cost two full walks — `title_map` then
    `find_references` — 484 file reads and ~37 ms at 242 notes. That is
    invisible now and about 760 ms at 5,000, which the ingest worker is
    steadily heading towards on its own. One pass, both answers.
    """
    titles: dict[str, list[str]] = {}
    inbound: dict[str, list[tuple[str, float, int]]] = {}
    for doc_id, _ in store.iter_files():
        path = store.base_dir / doc_id
        try:
            text = path.read_text()
            mtime = path.stat().st_mtime
        except OSError:
            continue
        parsed = store.parse_frontmatter(text)
        title = parsed[0].get("title") if parsed else None
        if title and key(title):
            titles.setdefault(key(title), []).append(doc_id)
        counts: dict[str, int] = {}
        for m in _WIKILINK_RE.finditer(text):
            k = key(m.group(1))
            if k:
                counts[k] = counts.get(k, 0) + 1
        for k, n in counts.items():
            inbound.setdefault(k, []).append((doc_id, mtime, n))
    for v in inbound.values():
        v.sort()
    return titles, inbound


def find_references(store: OkfStore, title: str) -> list[tuple[str, float, int]]:
    """(doc_id, mtime, occurrences) for every note linking to `title`.

    The same scan `apply` performs, counting instead of writing — so the
    number quoted in a refusal is produced by the code that will do the work,
    not by a second implementation that could disagree with it.
    """
    target = key(title)
    if not target:
        return []
    out: list[tuple[str, float, int]] = []
    for doc_id, _ in store.iter_files():
        path = store.base_dir / doc_id
        try:
            text = path.read_text()
        except OSError:
            continue
        n = sum(1 for m in _WIKILINK_RE.finditer(text) if key(m.group(1)) == target)
        if n:
            out.append((doc_id, path.stat().st_mtime, n))
    return sorted(out)


def plan_hash(old: str, new: Optional[str], refs: list[tuple[str, float, int]]) -> str:
    """A fingerprint of exactly what the operator was shown.

    Not a `retarget=true` boolean: the repo already wrote down why, in
    backup_apply — "a boolean is one careless default away from being true".
    A flag also cannot hold the property the confirmation claims. The operator
    approves "60 links in 60 notes" and the server then applies whatever the
    corpus says a moment later, and that window is real: the summariser and
    the ingest worker emit links unattended. Recomputing this under the lock
    and comparing turns "the dialog named what changed" into a refusal.
    """
    body = "\x1f".join(f"{d}:{m!r}:{n}" for d, m, n in sorted(refs))
    return hashlib.sha256(f"{key(old)}\x1e{key(new or '')}\x1e{body}".encode()).hexdigest()[:32]


def apply(store: OkfStore, old: str, new: Optional[str]) -> list[tuple[str, float, int, bool]]:
    """Retarget `[[old]]` to `[[new]]`, or unlink it when `new` is None.

    Returns (doc_id, pre-write mtime, occurrences, ok) per file whose bytes
    changed — `ok=False` for a file that matched but could not be written,
    because a partial run is NOT self-healing: the next save sees old == new
    and does nothing, so a receipt that omitted the failures would be the only
    record and it would be a lie.

    mtime is preserved for the reason the unlink path already states: a
    mechanical repair is not new knowledge and must not trip recency cues
    (graph flares, planet sizing).
    """
    target = key(old)
    if not target:
        return []
    replacement = f"[[{new}]]" if new is not None else None
    changed: list[tuple[str, float, int, bool]] = []

    for doc_id, _ in store.iter_files():
        path = store.base_dir / doc_id
        try:
            text = path.read_text()
        except OSError:
            continue

        hits = 0

        def _sub(m):
            nonlocal hits
            if key(m.group(1)) != target:
                return m.group(0)
            hits += 1
            # m.group(1) — the bare title — is the unlink case: the link
            # becomes the plain text it displayed, never an empty hole.
            return replacement if replacement is not None else m.group(1)

        rewritten = _WIKILINK_RE.sub(_sub, text)
        if not hits or rewritten == text:
            continue

        stat = path.stat()
        try:
            # Atomic and O_NOFOLLOW, like the editor's own save. This walks
            # every file in the corpus, so it is the last place that should
            # follow a link into somewhere it was never pointed at.
            write_text_atomic(path, rewritten)
            os.utime(path, (stat.st_atime, stat.st_mtime))
            ok = True
        except OSError:
            log.exception("Memory link rewrite failed for %s", doc_id)
            ok = False
        changed.append((doc_id, stat.st_mtime, hits, ok))
        if ok:
            log.info("Memory links: [[%s]] -> %s in %s (%d)",
                     old, f"[[{new}]]" if new else "plain text", doc_id, hits)
    return changed


def dangling_in(store: OkfStore, body: str, titles: dict[str, list[str]]) -> list[str]:
    """Links in one body that resolve to nothing.

    Reported, never repaired. In this corpus a dangling link is always
    residue rather than a deliberate forward reference — every link is
    emitted by machinery that reads the target's title off disk immediately
    before writing it — but the operator can type one by hand, and silently
    deleting what someone just typed is not a repair.
    """
    seen, out = set(), []
    for m in _WIKILINK_RE.finditer(body or ""):
        k = key(m.group(1))
        if k and k not in titles and k not in seen:
            seen.add(k)
            out.append(m.group(1))
    return out
