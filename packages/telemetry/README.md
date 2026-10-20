# @nova/telemetry

Structured JSON logging (`docs/16` §1) with redaction applied inside the logger, per-module
levels, bound correlation fields, and a size-rotated file sink (10 MB × 5 by default).

- `RingSink` keeps the last 5,000 records in memory for the Diagnostics log viewer and the log
  export (FR-118): `query({ level, module, since, limit })` returns the newest first (`level` is a
  minimum, `module` matches sub-modules, `since` is inclusive) and `exportLines()` yields JSON
  lines oldest first. Both redact again on the way out, so a secret registered after a record
  was written is still masked.
- A logger and its children share one sink set: `addSink`, `removeSink` and `findSink(Class)`
  on any of them affect the whole family; the array passed to the constructor is copied.

## Spans, metrics and OTLP export (M8, FR-223)

- `Tracer` makes spans in the OpenTelemetry shape (`startSpan(name, {kind, attributes, parent})`,
  `setAttribute`, `addEvent`, `setStatus`, `end`). A finished span goes to the processors added
  with `addProcessor`; with none (`recording` is false) nothing is kept.
- `Meter` keeps content-free counters, histograms (default boundaries are OpenTelemetry's HTTP
  duration advice, in seconds) and observed gauges as cumulative values; `collect()` reads them.
  At most 1,000 attribute sets per instrument; further points are dropped and counted
  (`overflow`).
- `OtlpExporter` sends traces, metrics and logs over OTLP/HTTP with JSON encoding (no protobuf
  dependency) to `<endpoint>/v1/traces|metrics|logs`. It is off until `configure({endpoint,
  headers, signals, includeContent, resource})`; `configure(null)` stops it and drops the queue.
  The endpoint must be https, or http to a loopback collector; redirects are refused.
  - Every name, body, attribute and nested value passes the redactor at the export boundary,
    whatever the producer did.
  - Content attributes are removed unless `includeContent` is on: keys under `content.` or
    `nova.content.`, the GenAI message attributes (`gen_ai.prompt`, `gen_ai.completion`,
    `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
    `gen_ai.tool.call.arguments|result`), and keys whose last segment is one of `prompt`,
    `prompts`, `completion`, `content`, `text`, `body`, `args`, `arguments`, `result`, `results`,
    `input`, `output`, `query`, `messages`, `transcript`, `snippet`, `preview` or `message`
    (`isContentAttribute`; `message` makes an error object go out with its name only). Producers
    that attach user content should use the `content.` prefix; a log record's own message and
    plain string fields are exported redacted either way.
  - `close()` stops the timers, collects and flushes once, and is bounded to 5 s in all (requests
    still running are cancelled).
  - Each signal has a bounded queue (default 2,048 items; the oldest is dropped and counted).
    Batches go every 5 s (`flushIntervalMs`), metrics are collected every 60 s from the
    `metrics` source. A failed send (network error, timeout, 429, 502, 503, 504) keeps the batch
    and backs off exponentially from 1 s to 5 min with jitter, or as `Retry-After` says; any
    other refusal drops the batch; partial successes count their rejections as dropped. Nothing
    ever throws into the caller. `stats()` reports queued, dropped, sent, failures, the last
    error and the next attempt.
  - `sendTest(config)` sends one log record at once (the settings page's test button).
- `OtlpLogSink` feeds a logger family's records to the exporter, skipping the ones its
  predicate names (the export's own records).

The Hub's OTLP area (`apps/hub/src/otlp.ts`) drives the exporter from the `telemetry.otlp.*`
settings, keeps header values in the vault and adds HTTP request spans and metrics.
