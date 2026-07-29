"""Do clusters bind to each other — and can the answer refuse?

The universe view has a deferred tier: clusters that are RELATED drift into a
shared structure, a milky way. This module answers whether there is anything
to draw, and is built so that "no" is a reachable answer.

That matters because the obvious statistic cannot say no. Any fixed threshold
over an affinity score ("draw an arm above 2x the mean") passes on randomly
shuffled data — measured 2026-07-27, a group formed in 200/200 shuffles. A
control that cannot refuse is decoration.

So the gate is a PERMUTATION NULL, not a threshold. Hold the cluster sizes
fixed, shuffle which documents belong to which, recompute, and ask whether
the real arrangement beats what chance produces at the same shapes. Only a
pair that clears its OWN null has earned a line between two clusters.

The current answer is no, and the reason is the interesting part. Subject
tags are real now — the summariser emits `claude-code`, `ai-agents`,
`openrouter`, `loop-engineering` — but they concentrate INSIDE clusters
rather than across them, because a followed channel covers a coherent topic
area. Measured over 400 shuffles, every channel pair scores BELOW its null
(e.g. how-i-ai <-> cloud-codes: observed 6, null median 22, null max 32).
Cross-cluster subject sharing is rarer than chance. There are no related
clusters here to draw; there are four clusters that each know what they are
about.
"""

from __future__ import annotations

import itertools
import random
from collections import Counter, defaultdict
from typing import Optional

#: Shuffles per report. Enough to place an observation against a max.
TRIALS = 400

#: Fixed so the same corpus reports the same numbers — a gate whose verdict
#: moved between refreshes would be untrustworthy for the opposite reason.
SEED = 11

#: Clusters smaller than this are noise for an affinity question.
MIN_CLUSTER = 4


def _components(nodes: list[dict], edges: list[dict],
                membership_kinds: frozenset[str]) -> dict[str, str]:
    """Union-find over MEMBERSHIP edges only — the same split memory.graph
    makes, and the whole point: subject edges must not merge clusters."""
    ids = {n["id"] for n in nodes}
    parent = {i: i for i in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in edges:
        if e.get("kind") not in membership_kinds:
            continue
        a, b = e.get("source"), e.get("target")
        if a in ids and b in ids:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    return {i: find(i) for i in ids}


def _pair_weights(assign: dict[str, int],
                  tag_docs: dict[str, list[str]]) -> Counter:
    """How many subjects each pair of clusters shares."""
    w: Counter = Counter()
    for docs in tag_docs.values():
        seen = {assign[d] for d in docs if d in assign}
        for a, b in itertools.combinations(sorted(seen), 2):
            w[(a, b)] += 1
    return w


def affinity_report(nodes: list[dict], edges: list[dict],
                    membership_kinds: frozenset[str] = frozenset({"link", "tag"}),
                    trials: int = TRIALS) -> dict:
    """Cross-cluster subject affinity, each pair against its own null.

    Returns the observed weights, the null distribution per pair, and a
    verdict. `draw` is true only if some pair beat its null's MAXIMUM — the
    strictest reading, chosen because the cost of a false positive here is a
    picture that asserts a relationship the data does not contain.
    """
    body = [n for n in nodes if n.get("type") in ("topic", "source")]
    comp = _components(body, edges, membership_kinds)
    groups: dict[str, list[str]] = defaultdict(list)
    for doc_id, root in comp.items():
        groups[root].append(doc_id)
    clusters = sorted((v for v in groups.values() if len(v) >= MIN_CLUSTER),
                      key=len, reverse=True)
    if len(clusters) < 2:
        return {"clusters": len(clusters), "draw": False,
                "reason": "fewer than two clusters to relate", "pairs": []}

    by_id = {n["id"]: n for n in body}
    entity = {t for n in body if n.get("type") == "source"
              for t in (n.get("tags") or [])}
    index = {d: k for k, v in enumerate(clusters) for d in v}

    tag_docs: dict[str, list[str]] = defaultdict(list)
    for doc_id in sorted(index):
        for t in (by_id[doc_id].get("tags") or []):
            if t not in entity:
                tag_docs[t].append(doc_id)
    tag_docs = {t: d for t, d in tag_docs.items() if len(d) >= 2}

    observed = _pair_weights(index, tag_docs)

    rng = random.Random(SEED)
    sizes = [len(c) for c in clusters]
    pool = [d for c in clusters for d in c]
    null: dict[tuple[int, int], list[int]] = defaultdict(list)
    for _ in range(trials):
        rng.shuffle(pool)
        shuffled, at = {}, 0
        for si, n in enumerate(sizes):
            for d in pool[at:at + n]:
                shuffled[d] = si
            at += n
        w = _pair_weights(shuffled, tag_docs)
        for p in itertools.combinations(range(len(clusters)), 2):
            null[p].append(w.get(p, 0))

    def name(k: int) -> str:
        c = Counter(t for i in clusters[k] for t in (by_id[i].get("tags") or [])
                    if t in entity)
        return c.most_common(1)[0][0] if c else by_id[clusters[k][0]].get("label", "?")

    pairs = []
    for p in itertools.combinations(range(len(clusters)), 2):
        dist = sorted(null[p])
        obs = observed.get(p, 0)
        pairs.append({
            "a": name(p[0]), "b": name(p[1]),
            "observed": obs,
            "null_median": dist[len(dist) // 2],
            "null_max": dist[-1],
            "clears": obs > dist[-1],
        })
    pairs.sort(key=lambda r: -r["observed"])
    drawable = [r for r in pairs if r["clears"]]
    return {
        "clusters": len(clusters),
        "subjects": len(tag_docs),
        "trials": trials,
        "pairs": pairs,
        "draw": bool(drawable),
        "reason": ("pairs cleared their null" if drawable else
                   "no pair beats its own permutation null — subjects "
                   "concentrate inside clusters, not across them"),
    }
