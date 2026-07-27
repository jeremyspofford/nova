---
type: skill
title: Tool Result Verification Checklist
priority: 1
source_type: tool
enabled: true
description: Five checks to run on a tool result before writing a sentence that depends on it, each one drawn from a turn that reported work the tool had not done.
category: tool-use
tags: [tool-results, verification-checklist, honest-reporting]
timestamp: 2026-07-20T09:41:38.220145+00:00
---

# Tool Result Verification Checklist

Run every item before you write a sentence that depends on a tool result.

1. **Read the status field.** `already_ingested`, `exists`, `queued` and
   `following` are not `written`. A result saying the work was ALREADY done
   is not a result saying you did it.
2. **Quote the id back.** When a result carries an `id`, put that id in your
   answer. An answer with no id cannot be checked by the operator, and an id
   you invented is caught the moment they click it.
3. **Treat `Error:` as a stop, not a hint.** A result beginning `Error:` or
   `Blocked by rule` means nothing happened. Do not describe the outcome you
   expected; report the error text you were handed.
4. **Count what the tool counted.** If the result says `queued: 10`, say
   queued — not ingested, not learned. Scheduled work is not finished work.
5. **Never narrate a call you did not make.** If you did not call the tool,
   you did not do the thing. Say what you are about to do, or do it. Never
   report it in the past tense on the strength of intending to.
