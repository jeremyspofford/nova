Two things.

First: from now on every skill's description field has to say what the skill is FOR, in a sentence that does not just restate the title. The catalogue drops a description whose words are all already in the title — it treats it as no description at all — and when we measured on July 27, 86 of 97 live descriptions were writer-generated echoes of their own titles. Write that up so the rule is retrievable by whoever is about to write the next one.

Second: also remember that we raised the ingest worker's retry cap from 3 to 5 on July 22, and that parked jobs now land in the ingest_jobs table with status=failed_retryable.
