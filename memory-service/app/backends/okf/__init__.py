"""OKF markdown memory backend — memory as a bundle of markdown files.

Implements Google's Open Knowledge Format v0.1: a directory of markdown
files with YAML frontmatter (required field: `type`), reserved index.md /
log.md files, and untyped links as graph edges.

Layout (under settings.okf_memory_dir, default /workspace/memory):

    memory/
    ├── index.md          # root index — always injected into context
    ├── log.md            # change log, newest first
    ├── topics/<slug>.md  # curated concepts
    ├── people/ projects/ preferences/   # created on demand from `type`
    ├── journal/YYYY-MM-DD.md            # high-volume inbox
    ├── sources/          # fetched references
    └── .nova/            # index.json (BM25), retrievals.jsonl (feedback)
"""
