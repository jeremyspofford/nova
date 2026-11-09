**2026-11-09 · Architecture · Provider plurality ADR (A1), proposed for the owner's second-model review**
- What changed: docs/plans/provider-plurality-adr-2026-11-09.md proposes how OpenRouter (an OpenAI-compatible provider), local Ollama, Claude and Codex sit behind the existing provider registry, with the Agent SDK evaluated as one provider among them and never the only way. It is docs only. Every claim about today's code cites a file and line.
- What you can now do: review the decision, its 11 small test-first PRs and its 12 open questions before anything is built.
- Still unfinished: nothing is implemented. Two facts are unverified because no real calls were made: whether OpenRouter's streamed usage includes a dollar cost, and which variable each CLI reads for an API key.
- Checked: docs only; ledger-files and check-changelog pass.
