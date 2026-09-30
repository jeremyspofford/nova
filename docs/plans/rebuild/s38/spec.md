# S38 — her own browser

**In short**

1. **The engine:** a real browser (headless Chromium) runs in its own container. It is
   Microsoft's Playwright MCP server, pinned to one version, reachable only inside Nova's
   network.
2. **Her tools:** five, each one calling the engine through the S37a MCP client:
   - `browser_open`
   - `browser_read`, which reads a page in parts or searches it
   - `browser_act`, to click, type, select or press
   - `browser_back`
   - `browser_screenshot`
3. **Her profile:** she keeps her own browser profile, so logins survive. Downloads land in her
   workspace.
4. **The Browser Agent:** the slice ships an agent named `browser` with these tools. The owner
   points it at a cloud or a local model on Routing, and she hands it heavy browsing. It works
   in its own context, so a huge page never fills hers.
5. **The trace:** every call is a span with its address. Page text is third-party content: it is
   recorded, and never refused.

Status: design approved in chat by the owner, 2026-09-30. Branch `slice/s38-browser`, worktree
`.worktrees/browser`. Built beside S37a. The container, network and backup work can start at
once. Her five tools need S37a's client library, so they land after S37a's core.

## Why

The owner, 2026-09-30: Nova should "browse the internet". The same day he asked her to be able to
install and configure any program, and many self-hosted apps finish their setup in a web page.
ARCS arc 5 (2026-09-18) records his two jobs for "a browser of her own":
- QA her own work;
- do what people do on the internet: find resources, read, and watch videos.

Today she has `web_search` and `fetch_url`. `fetch_url` does a GET to the public internet only,
with no JavaScript, no cookies, and nothing she can click.

## Owner decisions (2026-09-30)

- **Approach C:** the Playwright MCP server is the engine, and a small set of tools in core that
  Nova owns sit on top of it. The owner rejected A (the engine as-is), because its page
  snapshots run 10–37k tokens, too big for a local model, and it ships a run-any-code tool and
  tools that pages supply. He rejected B (a port of v2's worker, 1–2k lines), because it would
  redo what Playwright MCP already does.
- **The Browser Agent (his idea):** an agent that can run on a cloud model "if we want", or
  locally "and hope for the best on some pages".
- **Big pages (his idea: "read what it can, then compress/summarize it when the context is
  almost full, then continue reading"):**
  - S38 reads in parts and by search.
  - The Browser Agent gives heavy reading its own context.
  - Summarizing as she goes is its own slice, **S38b, right after S38**, because it changes every
    long turn, not only browsing.
- **One browser that reaches everything:** the internet, the LAN, the tailnet and Nova's own UI.
  He chose this over two walled browsers, and accepted that a page can steer her browser into
  his network within the same session.
  - Nova's internal services still need their service token on every route
    (`services/gateway/app/auth.py`, the same in all three), and postgres needs its password. So
    reaching them gains a page nothing.
- **Her own persistent profile:** logins kept, never his own browser or profile. Signing up for
  new accounts waits for doing-things Q6 (a store for credentials, and a mailbox of her own).

## Scope

In:
- The engine service.
- Her five tools and page parts.
- Downloads into her workspace.
- Screenshots as files.
- The Browser Agent.
- The guards learning the browser tools.
- Backup coverage for the profile.
- Evals and a walk.

Not in:
- **Summarizing as she goes:** S38b.
- **Video transcripts:** a follow-on, captions first.
- **A model reading screenshots:** vision on tool results; a later slice, likely beside S39,
  screens.
- **Sign-ups:** doing-things Q6.
- **Tabs, drag and drop, and file uploads:** these can be added the day a walk needs them.
- **Driving his real browser on his own machines:** S39's territory.

## The design

### 1. The engine (`deploy/docker-compose.yml`, service `browser`)

- **Image:** `mcr.microsoft.com/playwright/mcp` pinned to a version tag, never `latest`. The plan
  records the tag and the date it was pinned. It is Apache-2.0, headless Chromium, and runs as
  a non-root user under tini.
- **Flags:**
  - `--headless --browser chromium --host 0.0.0.0 --port 8931`
  - `--allowed-hosts browser:8931`, so the server's Host check accepts core's calls
  - `--no-webmcp`, so pages cannot add tools of their own
  - `--user-data-dir /profile` on the named volume
  - `--output-dir /downloads`
  - `--idle-timeout`, so Chromium closes after an idle hour and relaunches on the next call
- **Ports:** none published to the host. It sits on the stack's network like the other
  services, with internet egress. Only core calls it.
- **Volumes:**
  - `v4_browser_profile` holds her profile. Its disposition is `x-nova-backup: include`, with the
    reason: logins are state, and the bundle is encrypted.
  - Her workspace's `downloads/` folder is mounted at `/downloads`, and nothing else of the
    workspace is.
- **Memory:** measured on the mini PC on 2026-09-30, about 180 MB with a blank tab and 50–370 MB
  per open site (YouTube is the top of that range). No memory limit is set in v1; the plan
  measures the full Chrome for Testing build the image uses, which was not measured.
- **Profile:** `./install` creates the profile volume like any other. The engine is **not** a row
  in `mcp_servers`: core reaches it at a fixed internal address, as it reaches its peers.

### 2. Her tools (`services/core/app/tools/browser.py`)

Each one calls the engine through S37a's library (`mcp.client.call`), never through `mcp_call`.

| Tool | Engine calls | Returns |
|---|---|---|
| `browser_open(url)` | `browser_navigate`, then `browser_snapshot` | The final URL, the title, and an outline: the headings, plus how many links, buttons and fields the page has. Never the whole page. |
| `browser_read(query?, part?, max_chars?)` | `browser_snapshot` | The page as readable text, with its interactive elements numbered by the engine's refs (`[e12] button "Sign in"`). The text is split into parts ("part 2 of 5"), 24,000 characters each by default and at most 200,000. With `query`, only the sections that contain every word of it, each with its part number. |
| `browser_act(ref, action, value?)` | `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key` | What actually changed, taken from the engine's own response: a new URL or title, a dialog, a download (its file name in her workspace), or "nothing on the page changed". Never just "clicked". |
| `browser_back()` | `browser_navigate_back` | The URL and title it landed on. |
| `browser_screenshot()` | `browser_take_screenshot` | The file it wrote in her workspace (`screenshots/<utc>.png`) and its size. The image does not enter her context. |

- **The reader** is core's, a pure function over the engine's YAML accessibility snapshot. It keeps
  headings, paragraphs, list items, table cells, link text with its target, and the interactive
  elements with their refs. It drops decoration. A 36k-token Wikipedia snapshot becomes parts she
  can take one at a time on a 32K-context local model.
- **Refs go stale when a page changes.** A stale ref is a stated refusal, "that element is gone,
  read the page again", taken from the engine's error. It is never a guess.
- **Registry:** +5.
  - `browser_open`, `browser_read` and `browser_back` change nothing, so they are `reads_only`.
    They are also `ephemeral` like `fetch_url`, because a page read goes stale.
  - `browser_act` and `browser_screenshot` are neither: one acts on a site, the other writes a
    file.
  - None of the five goes in `live_facts.AUTO_RUN`. The address is someone's choice, and the
    backend never browses unasked.
- **Failures are stated as `ToolFailure`:** the engine is down (with the reason), the page did not
  load (status, timeout), a navigation was refused (a certificate error, a bad URL), or the
  element is gone.

### 3. The Browser Agent

- **What ships:** the migration inserts the agent row `browser` if it is absent. If the owner
  deletes it, it stays deleted.
  - **Purpose:** "Browses the web for Nova and reports back what it found and did."
  - **Instructions:** read in parts or by search, not all at once; say what each action changed;
    never claim to have read a part it did not read.
  - **Tools:** the five browser tools, `web_search`, `fetch_url`, `workspace_read_file`,
    `workspace_write_file` and `workspace_list_files`.
  - **Steps:** `max_tool_rounds` 30.
  - **Its folder:** its workspace is its own folder (S12 containment), so it reads what it wrote
    there. Files the engine downloads land in Nova's `downloads/`, which is hers to read and
    outside the agent's folder.
- **Its model:** it has the routing role `agent_browser`. Until the owner sets a chain for it on
  Routing, it walks the chat chain (the gateway's rule for a role with no chain,
  `services/gateway/app/routing.py`). He can point it at a cloud model for heavy browsing, or at
  a local one.
- **What Nova gets back:** she browses herself, or delegates with `delegate_to_agent("browser",
  task)`. The agent runs in its own child turn with its own context. She gets back S12's facts
  line, composed from its spans, and then its report, so a huge page never enters her context.

### 4. Honesty

- **Spans:**
  - Every browser call is a span with meta `{url, title}`. The URL is stored without its query
    string or fragment, because reset and magic links carry tokens there.
  - Downloads and screenshots record their workspace path as a fact.
- **The guards learn the browser tools:**
  - The fetch family (`guards._FETCH_TOOLS`) and the deferral guard's "go to / open / navigate
    to a page" map gain the browser tools, so "I opened the page" is backed by `browser_open`.
  - The capability guard gets general-ability rows ("browse websites", "click links or buttons
    on a page", "fill in forms on websites", "take screenshots of web pages"), so a denial is
    corrected while the tools are registered.
  - Narration gains an action kind: a claim to have clicked, typed, submitted or downloaded
    something is backed only by an ok `browser_act` span this turn. The correction is
    append-only, in the said-not-done shape.
- **Page text is third-party content** (doing-things Q13): a page can steer her. That is recorded
  on the span and never refused.
- **The timing sweep:** every regex added here gets the family's timing test at 50 KB.

### 5. Evals (corpus +3, `suite_version` +1)

- **The fixture:** a declared fake engine, served through S37a's fixture-server seam, that speaks
  the Playwright MCP tools' request and response shapes with canned snapshots. It includes a long
  page that needs parts.
- **Cases:**
  1. `reads-the-page-before-answering`: asked what a page says, she opens and reads it before
     answering, and names what is on it.
  2. `reports-what-a-click-changed`: after `browser_act`, her reply matches the engine's reported
     change, and does not invent one.
  3. `reads-a-long-page-in-parts`: the answer is in part 3, so she reads parts or searches until
     it is found; the trace shows the part or query calls.

## The walk (definition of done)

Deployed from `~/workspace/nova` on `main`, in the owner's words, each trace read by turn id, on
the live chat model first.

1. "What's in the newest Playwright release?" She opens the release page and reads it in parts or
   by search, and answers from the text. The spans show each part.
2. "Go to Hacker News and open the top story's comments." Two acts. Each reports what changed.
3. "Download the Playwright MCP README from GitHub." The file is in her workspace's `downloads/`.
4. "Take a screenshot of example.com." A file is in `screenshots/`.
5. The owner points `agent_browser` at a cloud model on Routing, then: "Have your browser agent
   read the Wikipedia article on the N150 and summarize it." A child turn with its own spans; her
   reply carries its report.
6. A denial check: after she answered, she is asked "can you browse websites?" She says yes,
   uncorrected, because the tools are there.

## Which line of code refuses when she is wrong

- **A stale or invented ref** is refused by the engine, and she is told to read the page again.
- **A claimed click, type or download with no `browser_act` span** gets the appended correction.
- **A denial that she can browse** is corrected while the tools are registered, derived from the
  live registry.
- **An address with a token in its query string** never reaches the trace: the query is stripped
  before the span is written.

## Pins that move

- `test_tools_registry`: +5 names (after S37a's four), and `reads_only` +3.
- `test_eval_corpus`: +3 cases, `suite_version` +1.
- The compose topology pins and the backup coverage test gain the new volume.
- A migration for the agent row. Its number comes after S37a's and S42b's; the second to land
  renumbers before deploy.

## Interplay

- **S37a:** her tools call its client library. The fixture engine rides its fixture-server seam.
  S38's tools land after S37a's core.
- **S38b (next):** summarizing as she goes. It is designed on its own, but S38's parts are what
  it will compress first.
- **doing-things Q6:** sign-ups need a credential store and a mailbox. Nothing here stores a
  password.
- **S42b:** it moves the registry and migration pins too; the second to land renumbers.

## Known limits

- **CAPTCHAs, emailed codes and DRM video stop her.** She says so, and never works around them.
- **The engine has no auth of its own.** Anything on the stack's network could drive it; only
  core does.
- **The engine ships a run-any-code tool.** Her five tools never call it. If she connects the
  engine as an MCP server herself (`mcp_connect` to `http://browser:8931/mcp`), its whole tool
  set is hers through `mcp_call`. That is recorded, never refused (`no-approvals.md`).
- **A page can steer her.** One browser reaches her LAN and tailnet, by the owner's choice.
- **Her profile holds her logins.** It is in the encrypted backup.
