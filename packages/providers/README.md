# @nova/providers

The provider adapter contract (`docs/07` §2): normalized `ChatRequest` and `StreamEvent` types,
`collect()` to fold a stream (keeping partial output on cancel, FR-018), and `MockProvider`, a
deterministic provider with scripted transcripts, timing control and error injection used by tests
and E2E journeys (`docs/16` §4).
