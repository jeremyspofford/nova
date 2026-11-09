**2026-11-09 · Honesty · Three wording fixes found while drawing compositions**
- What changed: a local or OpenAI-compatible model server that answers but lacks the configured model now reads "Model missing." instead of "Unreachable." (the health state is unchanged). The cloud budget messages no longer point at Settings › Models, which has no price field, or show an API path; they say plainly that no screen takes a price yet. The supervisor rollback route's summary now says it is tier 3, like the deploy route's.
- What you can now do: trust that these three messages describe what Nova really does.
- Still unfinished: a 404 from a model server still reads "Unreachable.", because it can't tell a missing model from a wrong address. No screen takes a model price yet.
- Checked: tests/core/providers.test.ts 11/11 with an updated assertion and a new unreachable-address check, tests/core/models-guards.test.ts, evals 12/12, the resilience and releases tests, typecheck, lint:tokens.
