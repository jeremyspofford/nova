---
type: topic
title: http_call execution spec
priority: 1
source_type: tool
enabled: true
description: The shape of a declarative http_call execution_spec and why headers must not carry a secret
category: knowledge
tags: [http-call-tools, execution-spec]
timestamp: 2026-07-20T14:06:33.129044+00:00
---

create writes a `tools` row: execution_type http_call, execution_spec
{method, url_template, headers?, body_template?}. Every {placeholder} in
url_template must be a property in parameters_schema, or the call fails at
substitution time.

headers are STATIC strings in the row. There is no environment-variable
interpolation, so "Bearer ${SOME_TOKEN}" is sent to the API literally, and a
real key pasted here sits in Postgres in the clear.

A created tool is live for every agent at once, no restart.
