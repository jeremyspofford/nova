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

Opt-in metrics and OTLP export (FR-223) arrive in M8.
