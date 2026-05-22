"""The probe registry. Adding a tool = appending a row.

Every prompt forces tool use via an unfalsifiable side effect:
- fs.write/fs.read: file content the model can't fabricate
- memory.write/memory.search: a UUID embedded in content
- shell.exec/code.execute: a command output containing a known token
- nova.secrets.*: a token returned only by secrets/resolve
- web.fetch/web.search: a token from a known page or query
- browser_navigate: attempt-only (ships SKIPPED if MCP not registered)

All written entities carry the nova-audit-{run_id}- prefix for filterable cleanup.
"""
from __future__ import annotations

from audit_tool_use.cleanups import DeleteFile, DeleteMemory, DeleteSecret, NoCleanup
from audit_tool_use.setups import SeedFile, SeedMemory, SeedSecret
from audit_tool_use.types import Probe
from audit_tool_use.verifiers import DbContains, FileExists, ResponseContains, Skip

PROBES: list[Probe] = [
    Probe(
        id="fs-write-roundtrip",
        tool="fs.write",
        prompt_template=(
            "Write a file at /workspace/nova-audit-{run_id}.txt containing exactly "
            "the string '{token}' (no other content). Then confirm the file is written."
        ),
        expected_args_subset={"path": "/workspace/nova-audit-{run_id}.txt"},
        verifier=FileExists(
            path="/workspace/nova-audit-{run_id}.txt",
            expect_content_contains="{token}",
        ),
        cleanup=DeleteFile(path="/workspace/nova-audit-{run_id}.txt"),
        tier="MUTATE",
    ),
    Probe(
        id="fs-read-echo",
        tool="fs.read",
        prompt_template=(
            "Read the file /workspace/nova-audit-fixture-{run_id}.txt and tell me "
            "the EXACT content it contains, verbatim, between triple backticks."
        ),
        expected_args_subset={"path": "/workspace/nova-audit-fixture-{run_id}.txt"},
        verifier=ResponseContains(token="{token}"),
        setup=SeedFile(
            path="/workspace/nova-audit-fixture-{run_id}.txt",
            content="{token}",
        ),
        cleanup=DeleteFile(path="/workspace/nova-audit-fixture-{run_id}.txt"),
        tier="READ",
    ),
    Probe(
        id="shell-exec-echo-token",
        tool="shell.exec",
        prompt_template=(
            "Run the shell command: echo {token}. Then tell me the exact stdout "
            "you observed, verbatim between triple backticks."
        ),
        expected_args_subset={"command": "echo {token}"},
        verifier=ResponseContains(token="{token}"),
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
    Probe(
        id="code-execute-echo-token",
        tool="code.execute",
        prompt_template=(
            "Execute this Python: print('{token}'). Then tell me the exact stdout "
            "you observed, verbatim between triple backticks."
        ),
        expected_args_subset={"language": "python"},
        verifier=ResponseContains(token="{token}"),
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
    Probe(
        id="memory-write-then-search",
        tool="memory.write",
        prompt_template=(
            "Save a memory with the content 'nova-audit-{run_id} record contains "
            "the token {token}'. Then confirm it's saved."
        ),
        expected_args_subset=None,
        verifier=DbContains(
            endpoint="http://localhost:8002/memories/search",
            query={"query": "{token}", "limit": 5},
            expect_field="0.id",
        ),
        cleanup=DeleteMemory(memory_url="http://localhost:8002", content_match="nova-audit-{run_id}"),
        tier="MUTATE",
    ),
    Probe(
        id="memory-search-verbatim-echo",
        tool="memory.search",
        prompt_template=(
            "Search your memory for the token 'nova-audit-fixture-{run_id}'. "
            "Then quote the EXACT, VERBATIM content of the most relevant matching "
            "memory between triple backticks — do not paraphrase or summarize."
        ),
        expected_args_subset=None,
        verifier=ResponseContains(token="{token}"),
        setup=SeedMemory(
            memory_url="http://localhost:8002",
            content="nova-audit-fixture-{run_id} record contains the token {token}",
        ),
        cleanup=DeleteMemory(memory_url="http://localhost:8002", content_match="nova-audit-fixture-{run_id}"),
        tier="READ",
    ),
    Probe(
        id="nova-secrets-write",
        tool="nova.secrets.write",
        prompt_template=(
            "Store a secret named 'nova_audit_{run_id}_secret' with the value "
            "'{token}'. Then confirm it was stored."
        ),
        expected_args_subset={"name": "nova_audit_{run_id}_secret"},
        verifier=DbContains(
            endpoint="http://localhost:8000/api/v1/secrets/resolve",
            query={"name": "nova_audit_{run_id}_secret"},
            expect_field="value",
        ),
        cleanup=DeleteSecret(base_url="http://localhost:8000", name="nova_audit_{run_id}_secret"),
        tier="MUTATE",
    ),
    Probe(
        id="nova-secrets-read",
        tool="nova.secrets.read",
        prompt_template=(
            "Read the secret named 'nova_audit_fixture_{run_id}_secret'. Then "
            "quote its EXACT, VERBATIM value between triple backticks — "
            "do not paraphrase."
        ),
        expected_args_subset={"name": "nova_audit_fixture_{run_id}_secret"},
        verifier=ResponseContains(token="{token}"),
        setup=SeedSecret(
            base_url="http://localhost:8000",
            name="nova_audit_fixture_{run_id}_secret",
            value="{token}",
        ),
        cleanup=DeleteSecret(base_url="http://localhost:8000", name="nova_audit_fixture_{run_id}_secret"),
        tier="READ",
    ),
    Probe(
        id="web-fetch-token-page",
        tool="web.fetch",
        prompt_template=(
            "Fetch the URL https://example.com/ (run_id={run_id}) and tell me "
            "the EXACT text of the page title between triple backticks."
        ),
        expected_args_subset={"url": "https://example.com/"},
        verifier=ResponseContains(token="Example Domain"),
        cleanup=NoCleanup,
        tier="READ",
    ),
    Probe(
        id="web-search-attempt",
        tool="web.search",
        prompt_template=(
            "Search the web for the exact phrase: 'nova audit canary token "
            "{token}'. Tell me how many results you got."
        ),
        expected_args_subset=None,
        verifier=Skip,
        cleanup=NoCleanup,
        tier="READ",
    ),
    Probe(
        id="browser-navigate-attempt",
        tool="browser_navigate",
        prompt_template=(
            "Navigate the browser to https://example.com/ (run_id={run_id}) "
            "and tell me what you see."
        ),
        expected_args_subset={"url": "https://example.com/"},
        verifier=Skip,
        cleanup=NoCleanup,
        tier="MUTATE",
    ),
]
