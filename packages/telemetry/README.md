# @nova/telemetry

Structured JSON logging (`docs/16` §1) with redaction applied inside the logger, per-module
levels, bound correlation fields, and a size-rotated file sink (10 MB × 5 by default). Opt-in
metrics and OTLP export (FR-223) arrive in M8.
