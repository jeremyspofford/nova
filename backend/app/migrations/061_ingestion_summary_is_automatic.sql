-- Migration 061: tell the ingestion agent that a summary is written for it.
--
-- The summariser (app/summariser.py) runs in the ingest queue after the
-- transcript is safe on disk, distils it, checks every claim against the
-- source, and writes a linked summary topic. The agent's prompt still
-- described a world where that did not exist.
--
-- This is NOT a control — the summary is written mechanically whether the
-- agent knows or not, which is the point. It is the other half of the rule:
-- state what is true, then check it anyway. A prompt that describes a system
-- the agent is no longer in produces two specific failures. It writes a
-- summarising note of its own, duplicating a document that already exists;
-- and asked what it did, it reports only chunks, which understates the
-- system to the operator — the mirror of the capability-claim problem, and
-- just as misleading.
--
-- Step 5's chunking rule is deliberately left alone. Chunks preserve the
-- speaker's exact wording for citeable, timestamped retrieval; the summary
-- compresses. They are different jobs and both are wanted.

UPDATE agents SET
  system_prompt = system_prompt || E'\n\nA SUMMARY IS WRITTEN FOR YOU. After an ingest completes, Nova mechanically distils the full transcript into a separate linked summary note, with every name and number in it checked against the transcript and any it cannot find removed. You do not write it, you do not need to ask for it, and you must not write a summarising note of your own — that would duplicate a document that already exists. Your chunks are for citeable, timestamped retrieval of the actual wording; the summary is for knowing what the thing said. When you report what you ingested, you may say a summary follows automatically.',
  updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt NOT LIKE '%A SUMMARY IS WRITTEN FOR YOU%';
