# S37a carries

These were found in the task reviews and the final whole-branch review, and were judged safe to ship (final-review rulings, 2026-10-06). None of them lets a credential leak, and none adds an approval. Each guard item below is a **miss** or a **true-but-confusing** appended sentence, never a false one.

## Guards (mcp_server_denial, mcp_server_claim, the MCP capability rows)

- **Compound nouns.** "I can't access GitHub issues" is a likely honest sentence under the actions-only preset, and so are "GitHub CLI" and "GitHub Enterprise". All of them read as a denial of the `github` server. The appended sentence is true, but it is confusing. Design a follower-noun cut, and pin these as known cases until it lands.
- **Conditional and non-reading claims.** "If the token expires, I can't reach GitHub" and "GitHub shows a red X when…" are judged as a denial and as a claim, respectively.
- **The honest-tail cut is wide.** False denials with a decorative tail go uncorrected: "right now", "over the internet", "using any tool", "that you mention", "through this chat". These are misses only, so pin them as known misses.
- **Names that look like titles but are not.**
  - Acronym titles ("MCP", "API") and "Search Tools" pass the title-shape check, and "Github" is dropped.
  - Connection names that are common words ("home", "docs", "files") match as prose. For example, "I can't access your home directory" gets "(home is connected…)".
- **Same-title servers** back or blame each other. This is rare.
- **Cost.** The claim guard is linear but scales with the number of servers: 1.27 s at 50 KB with 200 servers, 110 ms with 20. One combined alternation per reply removes this.
- **The family-wide miss.** "I can't … because I'm a language model" stands, because a present-state tail is read as honest in every capability row.

## The client and the store

- **Hostile SSE.** 4 MiB of blank or comment SSE lines costs 3.2 s of CPU, about 50 ms between socket awaits. Cap the lines or empty events per response.
- **Server text in the system prompt.** Server text sits in her prompt (spec §4): tool names (12 × 64) and `last_error` (160). Show only names in the MCP name grammar, else a count, and quote the error as the server's words.
- **Stored tool lists have no total bound** (up to 20 pages × 4 MiB). `list_servers` reads the whole `tools` jsonb twice per turn. Clip at storage, or select only names for the roster and refs.
- **The roster has no server-count bound.** Each server is about 1 KB; pair this with the item above.
- **Malformed server input still ends in "failed unexpectedly"**, with no fact and no stamp. Cases: a schema nested ~900 deep (RecursionError), a 400-digit `progress` (OverflowError), a string `error.code`.
- `FixtureMcpServer.fake_spec` does not pass `legacy_refusal`.

## Wording

- **Re-point notice.** It says "was X and is now X" when only the credentials or the path changed. It should say "same address, new credentials".
- **Disconnect.** `mcp_disconnect` says "Its token is deleted." even when there was none.
- **Stale comment.** `api.ts` has a stale `rejected_more` comment.

## Tests and hygiene

- There is no test for an unregistered tool name in `_origin_only`.
- "Up to N, else a count" is written twice, with clips of 64 and 120.
- There is no roster test for a server that failed and then recovered.
- `test_chat_mcp` leaves a row behind.
- Task 9 minors:
  - `REJECTED_LISTED_UP_TO` is duplicated;
  - a lookup/disconnect race gives a 422 with a not-found sentence;
  - there is no route test for refresh's ServerError;
  - the anonymous-access test covers GET only.
- `HA.example` fixture host (cosmetic).
- The plan carries `/home/jeremy/...` paths; docs should write `~/…`.

## Checked after deploy (Task 14 Step 8)

- **393 px.** The Connections tab's mono tool names have no `break-all`, and `key={tool.name}` can repeat.
