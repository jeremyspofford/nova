# Ledger

Decisions, dependencies and deviations, newest first within each section.

## Dependencies

Runtime: **none**. The server, runner, markdown renderer and tests use Node 22
built-ins only.

| Dependency | Kind | Why |
| --- | --- | --- |
| `jsqr` 1.4.0 | dev | Test-only: decodes the QR codes Nova draws (`tests/qr.test.js`, the M4 UI tests), so the encoder is checked by an independent decoder. Never loaded by Nova itself. |
| `playwright-core` 1.56.1 | dev | Drives Chromium for `npm run shots` (golden screens, keyboard path, budgets); no bundled browser download. Never used by Nova at run time: the browser worker speaks CDP itself (M5c). |
| `claude` CLI | external | The default `agent_cmd`. Swappable by config; nothing in Nova depends on it. |
| `openssl` CLI | external (tests only) | M10a hardening: the egress tests make a throwaway self-signed certificate for their TLS stand-in hosts, in the test's temp dir, deleted at once. A test skips with the reason where it isn't installed. Never used by Nova. |
| `node:26-trixie@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617` | external (Docker image) | M10a: Nova Computer's one workspace image, Docker's official node image pinned by its index digest (Node 26.13.0, git 2.47.3, a shell, Debian 13; 445 MB). The slim and Alpine images have no git, and installing it on top would be a second download. Pulled once, never built on. The `docker` CLI and a local daemon are needed only for the computer: without them it says so and stays off. |

## Decisions

**2026-10-31 (M10b: the adversarial review of PR #238).** Same branch and PR. All seven items
answered, test-first, on loopback stand-ins with fake per-test credentials; evidence in
`docs/evidence/m10b-gate.md`, "The adversarial review of PR #238", with what failed when each fix
was removed.
1. **A pause didn't stop a pending selector action** (reproduced in a real browser). One check,
   `#mustWait()`, now guards `act`, `actOn` and `clickAt`.
2. **The pay guard was a word list.** **Choice:** a structural send guard in the session. While
   Nova drives, a request that isn't a GET leaves only while a declared step acts and only to where
   it accounts for (a new `sends` on fill, select, click and login, validated and never a pay
   address); outside a checkout flow a click's own submit form also counts, and a sign-in's always;
   on a checkout flow only `sends`; after the itemised-total stop, nothing. GETs to pay addresses
   are refused; a stopped browser fails every request. The lists are a signal on top. **Trade-off:**
   a site that sends by script on a click needs `sends` in the plan; a GET that pays at an address
   no list names isn't stopped.
3. **Declared hosts** are canonicalised with the WHATWG URL parser before every check, and kept so.
4. **Screenshots after a sign-in**: the regions that could show a value are measured before and
   after the capture and painted over in the PNG in Nova's own process (`png.ts`, node:zlib, no
   dependency). **Choice:** cover over re-render: a picture taken before any re-render would still
   miss what the page painted while Nova typed. Limits written down: unnamed regions, and the
   person's live view.
5. **Sign-ins over plain http** only to loopback; link-local hosts refused outright.
6. **Live tests** for the reviewer's read-only findings. Two failed and were fixed: Forget left
   local storage and IndexedDB (it now also clears from inside the origin, opened locally with
   CDP answering, nothing reaching the site), and a field that swapped itself on focus got the
   value (checked before and after focus now). **Choice:** Nova's page runs with focus emulation, as
   a real window does, so pages' focus handlers fire in front of Nova's checks.
7. Docs: this entry, the evidence and the known limits.

**2026-10-31 (M10b: Nova Browser).** Branch `m10b/browser`. The plan is `docs/plans/M10b.md`, the
evidence `docs/evidence/m10b-gate.md`. Nova Browser is the M5c browser worker grown, not forked:
one worker, one CDP client, the same plans, declared hosts, walls, takeover and evidence.
- **The profile (the owner's open question 3, unanswered):** the ADR's proposed default is what is
  built, and is written down here: one persistent Chromium profile owned by Nova at
  `<home>/workers/browser-profile`, never the person's own; sign-ins kept per site between tasks;
  each site deletable from Settings › Connections › Site sign-ins (tier 3, confirmed every time).
  Tasks use it by default; `inputs.profile: "fresh"` keeps M5c's throwaway profile. If the owner
  prefers "every task starts logged out", that is one default to change.
  - **Found by the gate, fixed:** made adversarial (its account page names who is signed in, in a
    cacheable response and its title), the stand-in put the fake username into Chromium's HTTP cache
    inside the profile. **Choice:** the profile keeps only cookies and site storage. Its cache is a
    throwaway folder per launch; history saving is off; history, top sites, favicons and the
    session-restore files go when it closes; password manager and autofill are off. With those
    preferences removed, the gate found Chromium had saved the fake password in the profile's
    `Login Data`: they are load-bearing, and tested.
  - Chromium is given up to 8 s to exit by itself when Nova's profile closes: killed sooner, it
    didn't write its cookies out (found by the gate's "kept per site" check).
- **Logins** are saved by host in the vault (`browser/login/<host>/…`), never in chat. A `login`
  step names fields, never values. **Choice:** the worker sets the values through
  `Runtime.callFunctionOn` *arguments* in Nova's isolated world, only when the page's own
  `location.host` is the host they were saved for, only into that document's own fields, rather
  than `Input.insertText` into whatever has focus (a page could move focus to another frame between
  the focus and the typing). Fields are masked on the page (`-webkit-text-security`), so frames and
  screenshots show discs; before a screenshot or a final read any echo of a value is masked; and a
  redactor holding the session's values covers every file, event, report and co-pilot input.
- **Driving:** selectors (DOM) or `{role, name}` targets (the accessibility tree). **Choice:** the
  selector path keeps M5c's one `Runtime.evaluate` expression per action (so the M5c race test still
  tests what it did); targets and sign-in values go through element handles. Vision is a hook only
  (`BrowserOptions.locate`), marked `via: vision, fallback: true`; no vision model ships.
- **The co-pilot:** `browser-step` v1, six Noul questions, asked of the local sorting model only, with
  screened extracts only, before and after each acting step. **Ground truth** (DOM, URL, parsed
  totals) decides whenever it exists; a model sure of the opposite (p ≥ 0.8 against a no, ≤ 0.2
  against a yes) stops the step. Where only the model speaks and is sure of a problem, the person is
  asked. **Choices:** a login form is a wall only when the plan doesn't fill it in itself; a dialog
  is an injection when its screen blocks it *or* flags instruction-shaped text or Nova's own tags
  (so it is blocked even with no model, when the screen alone would only quarantine it); a
  pre-ticked extra is flagged and the person asked to untick or keep it (Nova never decides it), and
  one unticked and ticked again on a later page is asked about again.
- **Site templates** go through the existing template path. **Choice:** the template's dry runs *are*
  the flow (each step as JSON, with the path and the next step's selector seen after it), plus
  negative controls, so the flow is replicated with the template and re-checked by Nova at
  activation; its rule is one prefix rule (`RulesProvider.addPrefix`, new). A flow plan names its
  version (`flow: {name, site, version}`), so the plan the person approves is the plan that runs.
- **Checkout:** a plan with a `checkout` step is tier 3 and ends there (only a read or wait after).
  **Deviation from my own first plan:** no automatic tier-3 "pay" hand-off task. The ADR says Nova
  "shows the itemised total and stops"; a hand-off that opens the checkout for the person would be
  a second, unasked browser task. The report and `checkout.json` show the lines and total. The pay
  control is refused by the validator (whatever a template says), at the click (by the element's
  name, id, class, its form's action or card fields), and in the browser (a non-GET to a pay form's
  action, or a pay path, unless the person holds the browser).
- **Pause, resume and stop** are new beside takeover; the takeover sheet keeps one standout.
- **The UI-gate hang (PR #236, attempt 1, 90 minutes):** `m5-browser-hub`'s profile test failed an
  assertion before `site.close()`; the open server kept its test file's process alive and nothing
  timed out. Fixed: cleanup in `finally`; `test:ui` and `scripts/ui-test.sh` run with
  `--test-force-exit` and `--test-timeout=900000` (15 minutes: the M9 contrast test takes about 5 on CI; a first try at 5 minutes cancelled it); both CI jobs have `timeout-minutes`; a throwaway
  profile's removal retries. Reproduced first: a test file that fails before closing a server hangs
  `node --test` (killed at 20 s) and exits 1 with `--test-force-exit`.
- **Known limits:** no vision model; the co-pilot is tested with a stand-in model only; intent ground
  truth is a word match; learnt flows replay recorded values; cookies are forgotten per host name,
  not per port; no real site, login, CAPTCHA or purchase was tried (Hard limits).

**2026-10-31 (M10a hardening, round two: the second review of PR #236).** Same branch and PR. The
review ran probes against Docker and found three things to fix before merge, plus five follow-ups;
all are fixed, each with a test seen failing on `bf488fe4` (10 of 10 failed there). Evidence:
`docs/evidence/m10a-gate.md`, "Second review".
- **The disk-cap poll could be switched off.** A tree 25 deep with 200-character names (made inside
  with relative `mkdir`/`chdir`) is past PATH_MAX at the host's longer path; the size walk threw
  ENAMETOOLONG, `.catch(() => {})` swallowed it, and the machine-disk check behind it never ran: 24
  MiB past a 2 MiB cap. **Fix:** a check that fails stops the command; the folder and machine checks
  are separate; every walk stops at PATH_LIMIT with a plain reason; such a folder can't be
  checkpointed (writes refused), and a reset asks first (tier 2) and removes it at any depth.
  **Choice:** a length limit, not a file-descriptor walk: portable, and a project rarely needs a
  path that long.
- **Command text in summaries.** `docker diff` paths reached the summary (a read touched
  `/tmp/SYSTEM NOTE: …`). **Fix:** counts only; paths in the run file, screened, withheld by the API
  with the output. Audited the rest: walk errors no longer name entries, docker CLI errors are one
  line without paths, the folder check no longer names where a path leads.
- **Host-run files only at the top level.** **Fix:** found at any depth (metadata only), reported by
  kind. **Choice:** every `.git` (nested repositories, submodule and worktree `.git` files) is
  read-only inside like the top one, up to 64; past that, the machine isn't made.
- **Follow-ups:**
  - IPv6 is parsed, so `::ffff:0:7f00:1`, `64:ff9b:0:0:0:0:7f00:1` and `0064:ff9b::7f00:1` are judged
    by the IPv4 inside. **Deviation:** the review suggested blocking these prefixes whole; the
    embedded address is judged instead, so NAT64 still reaches the public IPv4 web. No spelling
    changes the answer.
  - `docker top` failing restarts the machine, and if it still fails nothing runs.
  - Migration 0015 marks rows without an identity broken, saying why.
  - The digest tells FIFOs, sockets and devices apart.
  - ECH is refused (the old claim, "ECH is refused", was wrong: the parser stopped at the SNI).
- The suite: 1024 tests, 1015 pass, 9 skipped (the existing opt-in ones).

**2026-10-30 (M10a hardening: the PR #236 review).** Same branch, `m10a/computer` (PR #236). The
evidence is in `docs/evidence/m10a-gate.md`, "Hardening"; the plan `docs/plans/M10a.md` says what is
built now. All fifteen items were answered, each with a test against real Docker in throwaway
`mkdtemp` folders with canaries, every container labelled for its test and removed at the end. 27 of
the 31 new tests failed on the unfixed code (3 passed and stay as guards; 1 tested a parser that
didn't exist yet); all pass now. One more, for a gap found reviewing the fixes (a checkpoint copy
that stopped part way stayed on disk), was seen failing with its fix removed. Another, for inode reuse (below). The suite: 1017
tests, 1008 pass, 9 skipped (the existing opt-in ones).
- **Folder identity (1, 2).** No two workspaces' folders overlap (nor one and Nova's home). A folder
  of the person's is resolved when asked: the task stores its real path, device, inode and birth time, the
  approval shows them, and only that folder is used. Before every mount, start, copy, digest and
  reset the folder must still be it (not a link, its real path its path, the same device, inode and birth time).
  Migration 0015 adds the columns.
  - **Found on CI:** GitHub's ext4 gave a folder made in another's place the old one's inode number
    again, so the device and inode alone passed it (two tests failed there, not here). The folder's
    birth time (statx) is part of its identity now; where a filesystem records no births, only the
    device and inode tell.
  - **Found:** on the unfixed code, an outer workspace turning an inner one's folder into a link
    made the inner one's reset delete a canary folder's file and copy into it.
  - A workspace made on this branch before the migration has no identity on record, and Nova won't
    touch its folder: make it again (the branch was never merged, so only test homes have one).
- **No process outlives its command (3, 11).** Before and after every command only the machine's init
  and its `sleep` may run, else the machine is restarted (0.24 s here) and checked again. The relay
  lives for one command and starts only then, so nothing can hold its port first (and if something
  did, it fails closed). The proxy asks on every new connection: not local-only, and the task still
  running with its OK.
- **Snapshots (4).** Paused for the image, the copy and the digest. The copy and digest are Nova's own
  walk: links stay links, files are opened `O_NOFOLLOW` and checked against what was listed, FIFOs,
  sockets and devices are never opened (and not kept). On the unfixed code a racing loop got a
  canary's bytes into a checkpoint.
- **`.git` (5).** Mounted read-only over itself when it is a real folder or file (never a link,
  which Docker would follow). `git_writable` at creation lets commands commit, and asks first (tier
  2). `.envrc`, `.vscode`, `.idea`, `.devcontainer`, `.husky`, `.gitmodules` and a `.git` a command made
  aren't blocked (changing a project is what a workspace is for), but a command that changes one is
  reported, by a metadata stamp with ctime (cheap for a large `.git`).
- **Proxy memory (6).** Credit frames on the relay's stdio: 128 KiB in flight per connection each
  way, at most 64 connections, a refused connection dropped. Measured: 138 MB held for a download
  nobody read before, 64 KiB now.
- **TLS and SNI (14).** It was cheap, so it is done: a tunnel must carry a ClientHello whose SNI is
  the host asked for (none for an address). Non-TLS protocols through a tunnel are refused, which the
  plan's "HTTPS only" already said.
- **Untrusted text (7).** Attempts get fixed reason codes; summaries name only declarations and
  counts; 200 raw attempts at most are kept (the rest counted), in the run file only, and screened
  with the output.
- **Disk (8).** Caps for workspaces (20), a folder (4 GiB), one workspace's checkpoint copies (16
  GiB) and the machine's layer (8 GiB). `--storage-opt` is used only where a one-time probe shows it
  enforced. **Found:** this machine's Docker accepts it and ignores it (64 MiB cap, 200 MiB written);
  GitHub's overlay2 on ext4 refuses it. There the caps are checked before each command and every 5
  s. A reset that can't checkpoint first (folder over the cap) asks first (tier 2).
- **Read check (9)** by content; machine-side paths by what each is now (ctime included).
- **Run records (10).** Raw output only when the gate passed it.
- **Routes (12).** Did not reproduce: every `/computer` route was already behind the console's
  checks. Kept as a test.
- **safe-fetch (13).** 6to4, Teredo, IPv4-compatible and local NAT64 addresses were counted public;
  now refused.
- **Evidence (15).** "Byte for byte" and "every command is a ledger task" now say what they cover.
- **Known limits:** domain fronting through a declared CDN host; publishing in registries mode;
  caps checked by polling where not enforced; a `.git` a command creates is writable until the
  machine is next made (reported); ECH (see round two, above).
- **Decisions the owner may want to revisit:**
  - the cap defaults (no source in the packet);
  - TLS-only tunnels, which refuse SSH or `git://` through a declared host;
  - host-run files reported rather than blocked.
- **Deviation (the branch).** The local `m10a/computer` branch is checked out in another worktree,
  which this work doesn't touch. The work was done on a local branch made from
  `origin/m10a/computer` and pushed to `m10a/computer`, so PR #236 has it.

**2026-10-30 (M10a, Nova Computer: Amendment 2026-10-30-C Part 4).** Branch `m10a/computer`. The
ADR is `docs/plans/M10.md`, the plan `docs/plans/M10a.md` and the evidence `docs/evidence/m10a-gate.md`.
- **One Nova.**
  - Behind a `Computer` interface (`src/core/computer/`) with a Docker adapter.
  - Every action is a Work Ledger task for the `computer` worker, gated by the ledger's own tiers
    (`minTier`) and privacy gate (`egressFor` + `permits`).
  - A command's output is screened by the ingest gate (source `tool`), and Nova verifies it itself
    through a `confirmation` from `nova-computer`.
  - The egress proxy applies `src/safe-fetch.js`'s rules (`publicAddress`, and its private-name rule,
    now exported as `privateName`).
  - Declared hosts use the browser's host syntax (`HOST`, now exported).
  - Docker CLI processes are tracked with `trackChild`.
- **Isolation is `--network none`, always:**
  - only the project folder is mounted;
  - Nova's own uid, never root;
  - `--cap-drop ALL` and no-new-privileges;
  - memory, CPU, pid and open-file limits;
  - no Docker socket.

  **Found while testing:** under Docker Desktop (this machine), a container on the default bridge
  reaches this machine's loopback, and so Nova's console, through `host.docker.internal`. The
  isolation test's positive control shows this, and with bridge networking the test fails on
  exactly that.
- **Egress was built, not deferred.** A relay inside the workspace runs as `nobody` and carries
  connections over its `docker exec` stdio to a CONNECT-only proxy in Nova:
  - the host and port must be declared;
  - every resolved address must be public;
  - names that only mean something on a private network are refused;
  - the connection goes to exactly the checked address;
  - every attempt is recorded.

  No Docker network is created and nothing else is mounted, so the host's network configuration
  doesn't change. Plain HTTP is refused (HTTPS only).
- **Deviation, the tier numbers.** The ADR calls a reversible write "tier 2 (do, notify, undo)". In
  this ledger (and NOVA-SPEC §6), tier 2 means *ask first*. The amendment's behaviour, "reversible
  write = do + notify + undo", is NOVA-SPEC's tier 1, so it is recorded as tier 1:
  - a write: a checkpoint first, then it runs, shows as handling and can be undone;
  - a reset: the same;
  - a read: tier 0;
  - egress and delete: tier 3;
  - a folder of the person's: tier 2.
- **A read is checked, not trusted.** The folder's metadata digest and the container's `docker diff`
  are taken before and after; a read that changed anything fails and says what changed.
- **Tests:**
  - `tests/core/computer-{policy,docker,egress,ledger}.test.ts`;
  - `tests/acceptance/m10a-{isolation,computer}.test.ts`.

  They skip with the reason where Docker isn't available. CI pulls the pinned image first.
  - **Seen failing first:** the policy test, before `policy.ts` existed.
  - **Mutation runs:** each fix was removed in turn and the test failed. The fixes removed were the
    folder restore, `--network none` (bridge instead), the computer's local-only check, and the read
    check.
- **Gaps:**
  - no disk quota (overlay2 on ext4 can't set one);
  - the read check misses a change to a container file that had already changed;
  - checkpoint copies are full copies;
  - no agent tool drives the computer yet (M10c);
  - no UI (the ADR asks for none in M10a);
  - after a factory reset, its containers are swept the next time a workspace is made.

**2026-10-30 (test fix: a device-agent test read a half-written file).**
- **What happened:** CI on #233, which is docs only, failed `the boot agent makes only the runtime’s own hub calls for it` with `Unexpected end of JSON input`.
- **Why:** the test's stand-in runtime rewrote `state/answers.json` in place while the test was polling it. `writeFileSync` empties the file before writing, so a poll could read it empty.
- **Fix:** the stand-in now writes a temporary file and renames it into place. Nothing in the product changes.
- **Evidence:** 10 of 10 runs pass, and the whole file passes, 16 of 16.

**2026-10-30 (M9, Feel & Polish: Amendment 2026-10-30-C Part 2).** Branch `m9/feel-polish`. Plan
`docs/plans/M9.md`, evidence `docs/evidence/m9-gate.md`. Every gate item is a test that was seen
failing first; the numbers are in the evidence.
- **Measured, not asserted.** Each item has its own browser test (`tests/ui/m9-*.test.ts`):
  - Web Vitals at p75 (12 fresh runs per view and width, PerformanceObserver);
  - skeleton geometry;
  - the progress bands;
  - motion;
  - contrast in every look and state;
  - hit areas (elementFromPoint);
  - the four foldable tests.
- **What the tests found, and the fixes:**
  - A 0.06 layout shift at every desktop start: the page painted in the phone layout first. The
    shell now shows once its layout and first view are set.
  - Closing a sheet was slow to paint (INP up to 240 ms) because of its whole-screen backdrop blur.
    It is a plain veil now.
  - From the plan's audit rather than a test: Home and Tasks drew "Nothing needs you" before their
    data arrived, then redrew. They wait now.
  - A streamed reply dropped its first piece: the server sent the piece, then said "streaming"
    with the text from before it. Fixed at the source in `src/runner.js` after review (see below);
    the first fix, in the page, was wrong.
  - Typing in a Settings field didn't count as "touched", so late data took focus from it.
  - The takeover sheet waited an extra 0.6 s before moving to the evidence: an artificial delay,
    now removed.
- **Progress rules in one place** (`ui/js/wait.js`): the 1 s and 10 s bands, real units, and a
  general estimate: from a measured rate (a download), else this device's earlier waits of the same
  kind, else a built-in one per kind of wait. An agent's reply has no known total, so after 10 s it
  shows the steps done and the time so far, not a percentage (DESIGN-SYSTEM §1.3: no percentage
  where the units aren't known). The bands run on the page's own clock.
- **Skeletons are the view's own last layout on this device** (`ui/js/skeleton.js`, localStorage,
  per view, layout and width; per conversation for chat). They can be exact because the same data
  draws the same blocks. With no layout kept (a first visit, a conversation not opened here) there is
  no skeleton, only the waiting line. When the data changed while away (new tasks), the kept shape is
  the last visit's: what stayed lands exactly, the rest grows below, and nothing moves. A conversation's
  blocks are kept by their distance from the end, because turns far above the screen are laid out
  as estimates (content-visibility).
- **Motion:**
  - The two loops (orb breathing, the working pulse) show a state for as long as it lasts, so they
    aren't held to 150–300 ms. They stop under reduced motion.
  - Hover and selection colours now change instantly. The "found" mark is a static wash that goes
    after 1.6 s.
- **Contrast:**
  - The live check (Settings › Appearance, and its one-tap fix) now sees a see-through surface over
    both ends of the page gradient, and checks hover rows, popovers and links on cards. Validation's
    contrast is unchanged from before M9 (see the review below).
  - Package values that moved: Orb Teal `status/error` and `text/secondary`; Aurora `text/secondary`
    and `accent/primary` (from the core's own smallest-nudge fixer).
  - Text never uses `text/faint`; that token is for graphics only.
  - Status words are in primary text, and keep their colour in the icon, border and tint.
- **Hit areas:**
  - A `--hit` constant: 44 px, or 48 px on a coarse pointer. It is an accessibility constant like a
    breakpoint, not a design token.
  - Small-looking controls keep their look and get a square invisible `::before`.
  - Exempt, and stated in the test:
    - links inside running text (WCAG 2.5.8's inline exception);
    - a message's time, which a finger reveals by pressing the whole message.
- **Layout:**
  - **The right column starts at 1024 px**, where it used to start at 1280. This supersedes
    DESIGN-SYSTEM §5's "off by default on smaller widths" for desktop widths: the amendment wins
    where they differ ("use the second pane").
  - On a desktop, Settings' sidebar takes the column's room, as it already did on a tablet.
  - The tablet's main column keeps at least 45ch.
  - Prose is capped at 70ch.
  - Type tokens are emitted in rem, so a person's text size applies. Packages keep px.
- **A real hinge in CI:** Chromium's `Emulation.setDeviceMetricsOverride` with a `displayFeature`
  gives real viewport segments and `env(viewport-segment-*)` values in the Docker browser.
  - Layouts and overlays now size to the segments.
  - `?posture=` still emulates only the arrangement.
- **Starter packages:** both still have the same structure; only token values changed.
- **Review of PR #234, fixed on the same branch, each test first:**
  - **Designs made before M9 were refused.** Motion outside 150–300 ms had become a validation
    problem, so every pre-M9 starter's copy failed, fell back to the default without a word and
    showed "Has problems". The fixture had been changed (120/320 ms → 150/300 ms), which hid it; it
    is back to its pre-M9 values. Motion out of range is now a warning, and the generated CSS clamps
    it (an overshooting curve is clipped). Validation's contrast is back to what it was (a surface
    over bg/base), so an old Orb Teal copy's error colour no longer disables it; the stricter view is
    the live check's, which warns and offers the fix.
  - **Streaming.** The page's "keep the longer text" workaround kept a step's blank lines or a
    ```xml fence on screen past its tool call. `src/runner.js` now says "streaming", with the text
    so far, before each first piece, and the page just follows the events.
  - **The page could stay blank** (the shell is hidden until the first view is set). A classic
    script shows it after 1 s whatever happens; a read unanswered for 10 s counts as Nova out of
    reach, and the page says so. A conversation that doesn't exist no longer stays "Loading".
  - **Clock skew:** Thinking, a running step and Sending were timed from the hub's timestamps. They
    now run from when this page first saw the wait.
  - **Sending recorded no length** (its start was passed in, so its end found nothing). Fixed.
  - **Coverage added:**
    - contrast at phone width with the tabs, drawer, More, a sheet and a toast open, and every Tab
      stop. It found the toast's Undo at 4.01–4.32:1; it is in primary text now, and 48×48.
    - hit areas at desktop width (44 px, rail and right column);
    - Web Vitals that send a message through a streamed reply, with the phone runs' CPU slowed 4×.
      That found a 0.091 layout shift on desktop chat once a conversation was long: turns on screen
      were laid out from content-visibility's estimate, then moved. The newest ten blocks now always
      render.
    - skeletons for another conversation and for Tasks after new tasks;
    - a general estimate after 10 s even with no history on this device.

**2026-10-30 (security: the ingest gate — the final adversarial pass on #229).** Each finding is a test
through the runner that failed first: `tests/ingest/round3.test.js` (4).
- **X1, the address judged wasn't the address fetched:** the guard trimmed trailing punctuation
  before comparing, but `web_fetch` sent the raw address. Fixed:
  - A `web_fetch` argument is now replaced by its one canonical form, the WHATWG parser's `href`,
    before the guard. That exact address is judged, recorded and fetched.
  - A tainted run follows it on its own only if it equals a known link exactly.
  - Trimming trailing punctuation and dropping a fragment happen only when links are taken from
    text read from outside, never to the model's argument.
  - Trailing punctuation (the probe's 66-character payload), a case change in the path, a different
    percent-encoding, an added `?`, `#` or `?x=1`, and a trailing slash each ask now.
- **X2, the caps reset per run:** they now count for the whole conversation: its turns, the helpers
  and scheduled runs it starts (a helper belongs to its parent's conversation, a scheduled run to the
  one its reports go to), and its follow-ups.
  - Each free follow is a `follow` event in that conversation's own session log. The counts are
    rebuilt from the log, as taint is, so a reload or restart keeps them.
  - The test fans out three helpers, each following three pages, plus three follow-ups: the site
    sees 8 pages, and the rest ask.

**2026-10-30 (security: the ingest gate — fixes from the second adversarial review of #229).**
Each finding is a test through the runner that failed first: `tests/ingest/round2.test.js` (14) and
`device.test.ts`. The N5 test with a model was written with the fix, against the code that had kept
a passing note.
- **N1, a "known" address planted by an echo:** fixed.
  - A known address now comes only from what was really read from outside: the links parsed from
    fetched pages, search result addresses and mail, recorded with the screened read.
  - A helper's read links travel with its report as data.
  - The person's own messages count; a helper's brief doesn't.
  - Tool errors and echoes, files the run wrote, the model's own arguments and a report's text
    never count. Read-file errors, write-then-read round trips, unknown skill names, delegate
    titles, empty search echoes and helper report text each ask now.
- **N1b, data leaking through link choices:** in a tainted run, a link the run read is followed on
  its own at most 8 times per host and 20 times in all; after that each follow asks.
  - The caps are `DEFAULT_LINK_CAPS` in code, so raising one is tier 3, as with the thresholds.
  - *Residual risk:* each free follow still says something by which link it picks. Within the caps
    that is a few bits per follow, to a host the content itself named.
- **N2 and N3, skills:** a skill that is held back, or whose SKILL.md changed since Nova checked it,
  is kept off the matching and listing, and `use_skill` refuses it with the plain reason.
  `use_skill` stays offered while any skill is installed, so the model hears that reason.
- **N4, import file names:** the briefing gives only how many files wait in `workspace/import/`.
  Their names arrive through `import_files`, a new tool whose result is screened as outside content
  (kind `file`), and which taints the run.
- **N5, device notes:** every one now waits for the person, even one a model passes.
- **N8, outside text in the briefing:** device names, capture and provider status words, problems,
  error text and triage reasons are quoted data: folded, protocol tags escaped, at most 200
  characters, in quotes. The whole briefing is also protocol-escaped.
- **N10, "Turn it on":** it trusts only a skill's text files. Images, fonts and archives were never
  checked, so they stay outside content. `read_file` refuses a skill file whose first bytes aren't
  what its name says.
- **N6, accepted for now (a known limit):** without a model, a paraphrased injection in command
  output that no check matches reaches the model as held-back data and doesn't taint the run.

**2026-10-30 (security: the ingest gate — fixes from the adversarial review of #229).** Same branch.
Each finding became a test that failed first, through the runner (createNova and a scripted
attacker) where it applies: `tests/ingest/review.test.js`, `review-core.test.ts`, `device.test.ts`.
This entry supersedes the one below where they differ.
- **Blockers fixed:**
  - **B1, a failed read:** it is outside content too. A failed fetch, search or mail read is
    screened and taints the run. `web_fetch` errors now carry only the status number, not the
    server's reason phrase.
  - **B2, standing files under another spelling:** the guard compares the normalised target, folded
    the way `write_file` folds. `./USER.md`, `workspace/../SOUL.md`, `~/` and case all ask.
  - **B3, the outbound guard:** in a tainted run, matching can't win against chunking, short
    encodings or reversal, so the policy changed:
    - Following a link is free. That means an address that appears verbatim (normalised) in what
      the run read: a page's `href`s, search results, mail, reports, or the person's own messages.
    - Any other address the model put together asks, showing the address.
    - Matching stays as a second line.
    - Search queries keep the secret and memory matching only. The search engine isn't a place the
      attacker can read, and a query that carries a vault or memory match still asks.
  - **B4, uploaded skills:** every file is screened before anything is written.
    - NULs no longer skip the screen.
    - A text file that isn't UTF-8 is refused.
    - A file Nova can't read as text (an image) can't be checked, so the skill is held. So is one
      checked without a model, said plainly on its card.
    - The skill goes in through a staging folder, already held if it is to be held.
    - Its files are trusted only while their hashes match the check. A changed file is screened
      when read, and a changed SKILL.md takes the skill out of use until the person turns it on.
    - Nova's own catalog skills are trusted by being identical to the catalog.
- **Should-fixes:**
  - **S1:** attacker-chosen strings never go in a tag attribute. The origin is an escaped `From:`
    line in the body, attributes are fully escaped, and origins are cleaned before they reach ledger
    titles or approval cards.
  - **S2:** a device note waits as a memory candidate unless it passes the screen. With a sorting
    model, one that passes is kept as before. A note Nova's own checks block is refused before
    anything is written.
    - *Limit:* waiting candidates are not replicated. They stay on the node that took them, so a
      failover before the person decides loses them; the device's own queue has already settled.
  - **S3:** `exec` output is screened in every run (the amendment binds: tool output). It taints
    when a check flags something or the model isn't sure. Without a model, ordinary output passes on
    as held-back data without tainting, so auto-run keeps working.
    - *Residual gap:* without a model, a paraphrased injection in command output that no check
      matches is not caught. It reaches the model as data, but doesn't taint.
  - **S4:**
    - The tokenizer is linear: no token can scan past the next `<`.
    - Style blocks are found with `indexOf`, sentence widening is bounded, and nesting past 256 is
      flagged.
    - HTML past 1 MB and text past 2 MB is cut, flagged, and never passes.
    - Screening yields once to the event loop first.
    - 2 MB of adversarial markup takes about 1.1 s in the test.
  - **S5:** any change to `ingest-screen` is tier 3, and `weakens()` refuses one that drops or
    changes any of its five Noul questions.
- **Minor fixes:**
  - **Folding before the checks:** NFKC, Latin lookalikes in mixed-script words, soft hyphens, and
    letters spelled out one by one. A fully folded copy is checked for detection.
  - **More hiding:** font size under 2px or 10%, `hsl`/`hsla` and more named colours, any `clip` or
    `clip-path`, and descendant selectors read by their last part. Text in `svg`, `noscript` and
    `math` is screened.
  - **Markup outside HTML:** non-HTML content that carries markup gets the HTML checks.
  - **The browser worker fails closed.**
  - **Approval cards:** the standing-file card shows the content, and a waiting forget names its
    memory.
  - **Case:** standing files are matched by exact name on a case-sensitive disk.
- **After merging the grounding PR (#231):**
  - Its read-only `nova_*` tools are Nova's own state: never screened, never taint. A test covers
    this with a stand-in tool.
  - Its `memory_import` needs an OK, so in a tainted run it always asks.
  - **Closed at the lead's request:** `memory_import` went through the gate. An import file is
    outside content of unknown provenance, so:
    - It is screened as `read_file` would screen it, and a block refuses the import with the reason.
    - Its records never go into memory: each becomes a candidate, "imported from <file>", waiting in
      Memory for the person's OK. This holds in any run, whatever `permissions.md` says.
    - A record Nova's own checks flag waits flagged; one they block is left out.
    - The tool doc, its result, the approval card and the briefing say the memories wait for the
      person's OK, never that they are loaded. The briefing counts waiting memories, never what
      they say.
    - Tests: `tests/ingest/import.test.js` (5, through the runner), plus `self.test.ts` and the
      grounding acceptance test, changed to match.
- **Still not caught (stated plainly):**
  - hiding by an external stylesheet or by script;
  - a paraphrased injection in visible text when there is no model. It is still never passed, but
    it isn't stripped.

**2026-10-30 (security: the ingest gate — Amendment C Part 3).** Branch `ingest/gate`, plan
`docs/plans/ingest-gate.md`, evidence `docs/evidence/ingest-gate.md`.
- **What it is:** `src/core/ingest/` (`checks.ts`, `screen.ts`, `outbound.ts`, `index.ts`),
  migration 0013. Every read of outside content is screened before a model acts on it:
  - the agent's `web_fetch`, `web_search`, `gmail_search`, `gmail_read`;
  - `read_file` on anything that isn't the person's own;
  - `exec` output while tainted;
  - helpers' and scheduled runs' reports from tainted runs, and files passed to helpers;
  - uploaded skills, captured text before the promote decision, device notes, and browser page
    reads.
- **The verdict rules:**
  - The Noul screen is the built-in template `ingest-screen` (five questions). It goes through
    `Decisions.decide` forced local-only, and only the `local-model` provider's answer counts.
  - The highest probability decides: below 0.2 with no quarantining flag → pass (wrapped as data);
    0.2–0.8, a quarantining flag, sampled long content, or no model → quarantine (instruction-like
    spans and hidden text removed, listed by kind; with a model, a reader's facts-only extract);
    0.8 or a blocking flag (hidden instructions, hidden protocol tags) → block (one line, a verified
    ledger task owned by the internal `ingest` worker).
  - The thresholds are constants in code (`DEFAULT_THRESHOLDS`), not a setting: lowering one is a
    change to Nova, so tier 3 through its pipeline.
- **Taint** is now the list of sources a conversation read (screen id, kind, origin, verdict, top
  score), kept in the session log. It carries into handoffs and into helpers a tainted run starts.
  - While tainted, `exec`, mail drafts and changes, schedules, writes to standing files, and any
    tool that needs an OK always ask, naming the source. A yes in `permissions.md` still holds for
    untainted runs.
  - The old blanket `online` permission is gone. Fetching and searching go through the outbound
    guard: secrets always, and in a tainted run memory/standing-file content (24 characters) and
    encoded blobs.
- **Memory guard:** `<remember>`, `<note>` and `<forget>` in a tainted run become candidates.
  They wait in Memory › Waiting for your OK, out of every prompt.
- **Where I read the plan, and why:**
  - **Handoffs are screened only when the run that wrote them read outside content.** An untainted
    helper's report is Nova's own work on the person's brief.
  - **`exec` output is screened only while tainted, as the plan says.** The amendment lists "tool
    output". I took the plan's reading: screening every command's output would taint every run
    that runs one command, and end auto-run for multi-command work that the person allowed.
    Owner's call. *Known limit:* an untainted command the person approved that fetches from the
    network isn't screened.
  - **`<forget>` in a tainted run "asks first" as a waiting candidate,** not a blocking card.
  - **Device notes:** the plan says they "keep the person-accept step they already have". They
    don't have one: they are recorded as unreviewed and go straight into MEMORY.md. I added Nova's
    own checks before the write (a block refuses the note) but no new accept step. *Gap.*
  - **Workspace provenance** is by content hash in `file_provenance`. Only what Nova wrote itself
    in an untainted run is its own; anything else (commands, providers, downloads, edits) reads as
    unknown and is screened.
  - **Nova's own state tools** (and any tool not listed as reading from outside) are trusted:
    never screened, never taint. That holds for the self-state tools in the parallel grounding PR.
  - **The stand-in Ollama's default structured answer** for the screen's questions is now
    "unlikely" (0.05). Near the top of the range had called every capture an attack. Tests that
    need the screen to fire pass their own `reply`. No check or threshold changed.
- **Not built:** a cloud screener (a screen a mode change can skip isn't a gate); opening
  attachments (Nova doesn't); HTML for IMAP mail (the Gmail API path passes it when there is no
  plain part); a model step that reads browser page reads (none exists; reads carry their verdict).
- **Tests:** `tests/ingest/` (61): the deterministic checks, the screen, guards, core wiring, the
  corpus (31 injection payloads, 15 benign items), the canary end to end, taint, the person's
  side, device notes, and local-only egress under the tripwire.

**2026-10-30 (UI fixes, after review).** Same branch, after merging `main`. An independent review
found these; each now has a test that was seen failing first (`tests/ui-review.test.js`,
`tests/ui/ui-review.test.ts`).
- **Undo after Save is exact.** Undo restores exactly what that Save changed (`look.js`
  `undoPlan`), and nothing else:
  - the light/dark mode;
  - the synced design, but not when the design saved was already the synced one;
  - this device's own design, if Save made it follow the synced one.

  When Save changed nothing, no Undo is offered.
- **The live check covers every control outline the UI draws.** The test reads those colours from
  the CSS rather than from a list.
  - It found `border/subtle` on fields, choices, design cards, Jump to latest and the capture
    indicator (about 1.2:1 everywhere). Those now use `border/strong`; `border/subtle` stays for
    separators and cards.
  - The pressed mic used the orb's listening colour (Companion Light 1.7:1). It now uses the
    accent, so the orb's own colours are left alone.
  - `status/attention` and `status/error` are now checked as outlines.
  - All six built-ins pass, so no package changed in this round.
- **Times:**
  - The "Next:" times on schedules and approvals were faint (3.27–3.64:1).
  - Card, task and playbook times were also faint.
  - `<time>` now has a base rule at `text/secondary`.
  - Tests find time-bearing classes from the templates, and a browser test checks the contrast of
    every element whose own text is a time.
- **Settings:**
  - From 840px (expanded) the sidebar shows; on a tablet it takes the context pane's room.
  - A category link (`#models`) opens at the category's top, as a click does.
  - Search results always focus something.
  - Data arriving late leaves focus and scroll alone once the person has started.
  - Search has more words. It is a combobox over a listbox, with a result count in a live region
    that persists.
- **Contrast panel:**
  - When the checks couldn't load, it says it couldn't check.
  - Undo is shown whenever a fix is applied, even a partial one.
  - A fix is never re-offered once one is applied.
  - It says plainly what can't be fixed.
- **Also:**
  - Focus goes to the next sensible control after fix, Undo, Save and Cancel.
  - Appearance's live regions are drawn once and updated in place.
  - Long press tolerates 10px of movement.
  - A background redraw no longer hides a revealed time. This was found while testing long press:
    the earlier tap test passed only because a tap also hovers.
  - Revoking a device forgets its appearance: its own design, rollback and fix. The core now
    records which paired device uses each appearance id.
  - The approval letter isn't a tab stop.
  - Offline shell v10.
- **Carried to M9:** 44 pt / 48 dp touch targets (review item 13). M9 gates hit areas.

**2026-10-30 (Amendment 2026-10-30-C Part 1, UI fixes).** Branch `ui/amendment-c-part1`. Every
item has tests that failed first (`tests/ui-fixes.test.js`, `tests/ui/ui-fixes.test.ts`); evidence
in `docs/evidence/ui-fixes-gate.md`.
- **Orb once per view:** no orb on messages, empty states, verified-result cards or proactive
  banners. On a phone, the top bar's orb (Home: the hero); beside a rail, the rail's (Home's hero
  hides on a tablet too, as it already did on a desktop).
- **Timestamps, as written:** a group is one author, under five minutes apart. In a plain
  back-and-forth the author changes every message, so each one starts a group and shows its time;
  runs from one author (Nova's follow-ups and reports) show one. Exact time on hover, tap, long
  press and keyboard focus. The amendment gives no number for a "gap"; **an hour** gets its own
  divider. Work-trail steps say "took 2 s, finished 9:00 AM" from the log's own timestamps.
- **Settings:** eight task categories, one level. (First built with the sidebar on desktop only;
  after review it starts at 840px, the expanded width. See the entry above.)
- **The contrast check and its fix:** the check is stricter than validation (it adds text/secondary
  on raised surfaces and `border/strong` at 3:1) and only warns. The fix is a per-device nudge in the
  core (`appearance.device_fixes`, applied when the CSS is generated): each failing colour moves
  towards the package's own primary text in 5% steps, the smallest step that passes in every look
  the package has; nothing else changes, other devices and designs are untouched, Undo removes it.
  This fits the token model (one CSS generator, per-device scope already in the core) and never
  invents a colour. **Both starters failed it:** field outlines were 2.79:1 (Orb Teal) and 1.72:1
  (Companion Light). Their `border/strong` is fixed at source with that same nudge (v1.0.1), so all
  six built-ins pass in every look (tested).
- **The recommendation:** the starter that matches the device's light or dark (the person's choice,
  else the system's) and passes the check, with that as its reason; otherwise the passing design with
  the most room to spare. A light system gets Companion Light, a dark one Orb Teal.
- **Deviations, said plainly:** light and dark is one setting for all devices in the core (there is
  no per-device mode), so it always goes through Save. `scrollbar-gutter` is `stable both-edges`
  (a form of stable that keeps the centred column centred). The rail and the right column are
  separate panes, not nested in the view; they keep `overflow-y: auto` so a very short window never
  clips them, and they don't scroll at the tested sizes.
- **Caught on the way:** the existing offline test failed because the two new modules
  (`settings-ia.js`, `contrast.js`) weren't in the service worker's shell, so the cached app
  couldn't load. Shell v9; a unit test now checks every module `app.js` imports is in the shell.
- **Existing tests changed:** `tests/ui/live-swap.test.ts` (it asserted the preview frame, which the
  amendment removes; it now tries a design for all devices live and unsaved, applies for this
  device, Undoes, Saves and undoes from the toast) and the appearance block of `scripts/shots.js`
  (same reason: its frame check goes, and "#appearance focuses the current mode" goes because the
  first control there is now the scope; `npm run shots` is not part of CI and was not re-run). No
  other assertion was removed.

**2026-10-30 (Screenpipe 0.4: accessibility text).** Branch `capture/screenpipe-accessibility`.
With the API key saved, the owner's Screenpipe answered 400. Screenpipe 0.4 renamed the content type
for accessibility text from `ui` to `accessibility`; its items still come back as type `"UI"`. The
adapter asked for `ui`. I confirmed this against Screenpipe's current API documentation (the
`/search` parameters list `ocr`, `audio`, `accessibility`, `input`, `all`).
- Nova now asks by the new name. It falls back to `ui` only when a Screenpipe answers 400 to the new
  one, and remembers which name each address took.
- The stand-in Screenpipe can speak either version (`speaks('0.4' | 'old')`), and the test covers
  both.
- `input` (clicks, keys, clipboard) isn't taken in: capture never asked for it, and adding it would
  be a new consent question, not a fix.

**2026-10-30 (grounding: the chat agent knows what Nova is).** Branch `agent/self-grounding`
(`agent/grounding` was already checked out in another worktree). Evidence:
`docs/evidence/agent-grounding.md`.
- **Self-briefing.** `src/core/self.ts` (`core.self`) builds a compact briefing from the core's own
  registries, in process: instance (preview, production or development, from `NOVA_INSTANCE`;
  `scripts/preview.sh` sets preview), data home, device, version and commit; the person's profile
  summary and memory counts; the chat model; providers with their health; the hub's Ollama, read
  now (cached 30 s); connections; capture sources with their detail; devices; schedules and
  automation rules; approvals; appearance; open problems. About 3,100 characters (some 750 tokens) on a
  typical instance. The runner builds it once per turn and `buildSystem` puts it after the system prompt.
  Per turn, not per session: the main conversation lives for weeks, and a briefing from its first
  turn would go stale. Helpers don't get it; their context is scoped to their brief.
- **Status tools.** `nova_instance`, `nova_capture`, `nova_devices`, `nova_schedules` and
  `nova_settings` are read-only and need no approval. They call `core.self` in process, never Nova's
  HTTP API. `nova_instance` checks an enabled provider that was never checked (up to 2 s).
- **Secrets and privacy.** The briefing reaches whatever model the conversation uses, cloud ones
  included. So:
  - It carries names and states only: a setting whose name says secret shows as "(set)".
  - Everything passes `redactText`, so a vault value can't slip through an error message.
  - Memory counts go in, never memory contents. Capture status goes in, never capture text.
  - Connector accounts and device addresses are left out.
- **Rules.**
  - The check-before-answering rule is in `CHARTER`, next to the honesty rule. It carries
    capability honesty: say it's not in the current setup and how to add it, never "I can't, I run
    on X".
  - The obvious-intent and subsystem-status rules are in `SPEECH`.
- **First run and imports.**
  - A Nova with no memories says it is fresh and names its home. It offers `~/workspace/import/`
    (seeded with a README): paste here, or put a file there, and the agent reads it and suggests
    memories. They arrive unreviewed for the person to check in Memory.
  - A Nova memory export (`memory.json` from `POST /memory/export`) found there is offered. The new
    `memory_import` tool asks first and loads it: each memory not already kept is added unreviewed,
    recorded by `import`, with the file as its source. It only reads plain files inside
    `~/workspace/import/`, never through a link.
  - **Gap:** "profile packs" don't exist. The profile archive in PROFILES-AND-CUSTOMIZATION
    (settings, triggers and extensions, with secrets re-linked) was never built. The only pack
    Nova offers is a memory export, and a pack is looked for only in the hub's own
    `~/workspace/import/`. A pack on another device is never looked for.
  - **Gap:** there is no memory-export button in the PWA (API only), so moving memories between
    Novas still takes a call to `POST /api/v1/memory/export`.
- **UI.** The conversation view has plain labels for the new tools and an approval sentence for
  `memory_import`.
- **Live check (local Ollama, opt-in).**
  - qwen3.8:27b answered all four questions from the real registry.
  - gemma4:12b avoided "I can't, I run on X", but stayed general: it didn't name the real
    schedule or design system, and it once claimed a check it hadn't made.
  - Two briefing fixes came from these runs:
    - keys are never asked for in chat or in a file;
    - there is one OpenAI-compatible provider, and repointing it replaces what it serves now.
  - Small local models rarely call the status tools on their own. The briefing carries the answer
    for the common questions; the tools carry the detail.

**2026-10-30 (Screenpipe source: edit in the console, API key).** Branch `capture/screenpipe-key`.
These are two gaps the owner found live.
- **The address and lookback can now be edited** in Settings › Capture › Address and API key. It
  uses the PATCH route, so the validation is the same. The panel opens by itself when the source
  can't be reached or is refused.
- **Screenpipe 0.4's API key:** an optional `api_key` on the source.
  - It is entered as a password, never filled back in, and kept in the vault under
    `capture/<source>`, never in the source's config.
  - It is sent as `Authorization: Bearer` on every Screenpipe request, and sent on none when unset.
  - `null` removes it.
  - The view says only `has_api_key`.
  - A 401 or 403 is a state of its own, `needs_key`, with the owner's wording, not "isn't
    answering". With a wrong key saved, it says so.
- **Found by the test, and fixed:** Settings' Capture section redraws when a source's status
  changes, and that threw away what was being typed. The "don't redraw under typing" check covered
  text fields only, and clicking Save moved focus away anyway. The Capture section now carries typed
  fields and open details over a redraw, and resets a form once its change is saved. This is
  limited to Capture, since other sections may rely on a redraw to clear their forms.

**2026-10-30 (security: web_fetch could read Nova itself — Amendment C Part 3, first piece).**
Branch `fix/web-fetch-ssrf`.
- **The hole:** Nova's console answers any request from this machine as the person. The agent's
  `web_fetch` had no address guard, needed no approval, and followed redirects. So a page could
  talk the agent into fetching `http://localhost:<port>/api/v1/memory` (or `/capture/events`,
  `/tasks`), and then into sending what it read out in another URL. Neither step asks the person
  (web pages never set the mail "taint"). I confirmed it on the preview: a plain local GET, made the
  way `web_fetch` makes it, returned memory.
- **Found by:** the Part 3 inventory, ahead of the gate's design.
- **Fix:** `src/safe-fetch.js`. Only public unicast addresses can be reached. A name is resolved,
  every address it resolves to must be public, and the socket connects to the very address that was
  checked, so DNS rebinding can't slip through. Every redirect is re-checked. Names that only exist
  on a private network (`.local`, `.ts.net`, …) are refused. IPv4 inside IPv6 is judged as IPv4.
- **Tests:** they failed first on the old tool. A test may widen the rule; the runner can't, because
  the model controls only a tool's arguments.
- **Still open, and the ingest gate's job:**
  - outbound checks on what a URL carries;
  - taint for web content;
  - the screen itself.

**2026-10-30 (Amendment 2026-10-30-C, owner-approved).** `AMENDMENT-2026-10-30-C.md` and
`UX-RESEARCH-2026-10-30.md` were added to the packet exactly as given (sha256 `e3b1862d…` and
`dda206f4…`).
- **OPERATING-RULES:** the amendment is noted there.
- **ROADMAP:** it gains the Part 1 UI-fixes PR (after M7, which is already merged, so next), M9 "Feel &
  Polish", the ingest security gate, and M10 "Execution Plane".
- **DESIGN-SYSTEM §1:** it gains the binding progress and waiting rules.
- **Earlier packet text the amendment replaces,** edited to match:
  - the orb as "avatar in chat" (§1, §5), which becomes once per view;
  - the apply path's "preview in a sandboxed frame" (§4), which becomes a live apply on the real UI,
    with an instant Undo for this device and an explicit Save for all devices.

  This is a later owner decision superseding older text, not a conflict.

**2026-10-30 (pairing on iPhone).** Branch `fix/webkit-pairing`. The owner's iPhone joined and
showed its digits, was approved on the hub, and then stayed on "Check the digits" for good.
- **Root cause:** WebKit (every iPhone browser) can't keep an X25519 `CryptoKey` in IndexedDB. A
  record holding one reads back as nothing. So `key.load()` gave `null`, and the `pending` update
  saved a record with no keys. Every signed status poll then threw before reaching the hub, and
  `/pair` retried that silently as if offline. Reproduced in Playwright's WebKit 26.0; Chromium keeps
  the key, which is why the Chromium-only gate missed it.
- **Fix:** the browser keeps only the X25519 public half, which is all the hub asks for; no page
  opens anything sealed to it. `/pair` retries only when Nova is out of reach and says every other
  failure. A leftover identity with no key is forgotten, and the page asks to pair again.
- **Gate:** `tests/ui/m4a-webkit-pair.test.ts` pairs an iPhone-sized WebKit end to end and checks
  the recovery. It failed first on the same empty record. The UI gate now runs WebKit as well as
  Chromium.
- **Left for the owner:** the preview's half-paired "iPhone Duo" device has a key no browser holds
  any more; revoking it in Settings › Devices is theirs to do.

**2026-10-30 (M7 amendment §2, final review).** Branch `m7-amend/final` (from
`m7-amend/checkpoints-reset`); each with a test that failed first.
- **Nova doesn't adopt a folder that clashes with its own entries.** At start, a folder that
  already holds something named like one of `NOVA_ENTRIES` is refused, naming them ("This folder
  already has .git/ and workspace/ that aren't Nova's. Choose an empty folder for Nova's home, or
  move them."): Nova's data would otherwise end up inside the person's folders, out of a reset's
  reach. Nova's own: a new or empty folder, one whose `nova.db` has Nova's schema, and (added here)
  an Era 2 home that holds all four standing files Era 2 seeded (`AGENTS.md`, `SOUL.md`,
  `IDENTITY.md`, `USER.md`), which has no `nova.db` yet. Other things already there are recorded and
  left alone. Tests that pre-fill a fresh home now let Nova mark it first (`ensureMark`), as Nova
  does before seeding.
- **`write_file` allows a path only as spelled exactly and after folding**; refusals stay folded.
- **Relay:** when it is on or was ever handed work, the confirmation and the result say its work
  stays in Relay's own storage and a reset of Nova doesn't erase it.
- **The home's git history** never takes `.nova-home` (the seal key), a reset's marker or report, or
  `checkpoints/` (which holds the identity and the vault key); `src/home.js` `UNTRACKED`. A home
  that already committed any of them before isn't rewritten: not changed here.

**2026-10-30 (M7 amendment §2, re-review fixes).** Branch `m7-amend/reset`; each with a test that
failed on `dcbc98df` first.
- **The mark means "this folder is Nova's".** `.nova-home` records `before`: the top-level names a
  folder already held when Nova was first pointed at it. A new or empty folder, or one whose
  `nova.db` has Nova's schema (existing homes, the preview's), holds nothing of the person's. A
  standby's `mesh/` with only its identity and role file counts as Nova's (its enrollment wrote
  them). A reset never erases `before` entries, and the confirmation and the result list them
  ("already here before Nova; left alone"). `server.js` marks the home before seeding it.
- **`write_file` never goes through a link**, dangling ones included: every part is `lstat`ed, and
  the file is opened `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` (not `O_EXCL`: replacing a file is
  the tool's job).
- **Names are folded** (NFC, lower case) for the read blocks, the secret folders and the write
  allow-list, as a case-insensitive disk would see them.
- **`Clear-Site-Data` only on the hub's own screen, once per reset**, until setup is done: the
  cookie `nova-reset-cleared=<reset id>` (HttpOnly, SameSite=Strict) marks it done. Never a
  paired device, whose new key it would take.
- **A finished reset whose marker was left behind** (stopped after the report and the new key) is
  recognised by its report's id and cleared quietly.

**2026-10-30 (M7 amendment §2, review fixes): factory reset hardened.** Branch `m7-amend/reset`;
each fix has a test that failed on `55fddabd` first.
- **A hole older than the amendment (fixed here):** the agent's `write_file` could write
  `nova.db`, `backups/*.db` (what a rollback restores), `.git/hooks/*` (the change pipeline commits
  in the home, so a hook would run with no approval) and a reset's marker. `src/tools.js` is now
  an allow-list: `write_file` writes only inside `workspace/` and to `AGENTS.md`, `SOUL.md`,
  `IDENTITY.md`, `USER.md` (the standing files the prompt names; `MEMORY.md`, `memory/`,
  `sessions/`, `schedules/`, `permissions.md` keep their own refusals). `read_file` refuses
  `nova.db*`, `checkpoints/`, `backups/`, `.git/`, `factory-reset.json`, `.nova-home`, and as
  before `vault/`, `mesh/`, `connectors/`; it still reads the standing files, `memory/`,
  `workspace/`, `sessions/`, `skills/` and the rest of the person's content. Links are followed
  before the check. The other tools write nothing in the home (`exec` runs in `workspace/` with
  approval; `schedule_set` is approved).
- **The marker is sealed:** an HMAC under a key in `.nova-home` (`resilience/home-mark.ts`). Chosen
  over a per-boot secret because a reset must still finish after a crash or a reboot, and over the
  vault because the vault's key is the first thing the wipe removes. A key in the home is enough
  once the agent can't write there: what else can write the home is the person's own programs,
  which can delete it anyway. A marker that doesn't verify (forged, changed, junk, or for another
  folder) is never acted on: it is renamed `factory-reset.json.set-aside-<time>`, Nova starts as
  it was, and a problem says so. The mark gets a new key after each reset.
- **Checkpoints, by the same reasoning:** the restore marker and `checkpoints/.seal` are in the home
  too; the agent can no longer read or write either, and the restore marker is checked against the
  staged files' hashes. A same-user program could forge them, as it could delete the home. Not
  changed here.
- **Only Nova's own home:** a reset is refused, staging and finishing, for `/`, the person's home
  folder or any folder containing it, and for a folder without `.nova-home` (holding the home's id
  and the seal key, 0600, never in a backup, checkpoint, export or the standby's copy). Nova writes
  it when it sets up a home: a new folder, or one whose `nova.db` has Nova's `schema_migrations`.
  So the preview home gets it at its next start; a folder holding some other `nova.db` never does.
- **The export** is checked by its real path (links followed); one gone by the end is said to be
  gone, never "untouched".
- **Late backups:** staging stops the heartbeat and the work queue (`core.stopWork`) before telling
  devices, then lists the backups again into the marker. Half-written ones (`.nova-backup-N.partial`,
  the database in the clear; `nova-backup-N.nbk.partial`) in Nova's recorded folders go too.
- **Encrypted copies** are erased only if they open under the backup key (the tag checks, nothing
  unpacked; `archive.ts` `verifyFile`), and are then known by their whole file's sha256.
- **Computers:** `hub_reset` is signed by the hub's identity key over
  `nova-hub-reset-v1.<device>.<reset id>`; the boot agent acts only on one in a heartbeat answer it
  got itself, from a pinned key. The runtime can't say it.
- **Browsers:** on the `reset` event and on the first-run screen after a reset, the page forgets its
  device key, `nova.*` storage (drafts) and the service worker's caches (`ui/js/forget-here.js`).
  Until setup is done after a reset, the first-run page and `GET /setup` send
  `Clear-Site-Data: "cache", "storage"`. The result says a phone was told and asked to forget; it
  doesn't claim it did.
- **Open:** keychain items of vault ids Nova no longer knows can't be removed: the `KeyStore`
  abstraction can't list items. Only the ids recorded at staging are removed.

**2026-10-30 (M7 amendment §2): factory reset, as built.** Branch `m7-amend/reset`; plan
`docs/plans/M7-amendment.md` §2 has the as-built note.
- **Nova's own entries, by name:** `NOVA_ENTRIES` in `resilience/entries.ts` (below). Anything else
  in the home is the person's: left and listed. A report from an earlier reset is overwritten.
- **Backups:** Nova's own sealed backups and recorded encrypted copies in every folder from
  `backup_run` (and the ones set now). Each is recorded with its seal (or its header's nonce) when the
  reset is staged and checked again before it is deleted. A folder that isn't there (the rule
  forgetting uses) is named before and after; strays are left.
- **The export holds no `vault/` at all**, not just no key: the plan's "no saved secrets". Nor
  `mesh/`. The recovery key is returned once and stored nowhere, not even in the vault.
- **The keychain key** goes through `Vault.forgetKeys` (the vault's own KeyStore, for each vault id
  recorded at staging); a keychain that isn't answering is said in the report, not guessed at.
- **Telling devices.** Phones and browsers can be told only while their stream is open; a computer
  heard from in the last 2 minutes is waited for (its next heartbeat); the standby while it copies.
  Waiting is capped at 45 s, then every session ends. A computer's agent stops for good on
  `hub_reset` (exit code 3, as when revoked). The standby wipes its replica in place and stages its
  own marker for the rest (identity, role file), which finishes at its next start.
- **While staged** the core refuses every change (409), except what telling devices needs (sessions,
  heartbeats, sync acks, the reset ack).
- **Restart in place, wired** (after merging `m7-amend/checkpoints`): once devices are told, the
  reset calls `restartInPlace` (`resilience/restart.ts`); the standby does too, once it has
  reported back. `stagedPending` and `finishStaged` (`checkpoints.ts`) include the reset's marker,
  so the supervisor honours the restart, and a staged reset goes first and wins over a staged
  restore (a restore can't be staged while a reset is, and the other way round).
- **The same staging rules as a restore** (after the checkpoints review fixes, `b78ecc6f`): the
  marker carries the sha256 of itself and is never acted on once changed (Nova doesn't start, and
  nothing more is erased); `core.stopWork` runs before the restart and before a standby wipes its
  copy. **A restart that fails** leaves the reset staged to finish when Nova starts next (the person
  confirmed an erase), said on the Danger zone and the sheet and as a problem, with every change
  refused (409) until then. A restore that fails is dropped instead: there the person keeps now.
- **Acceptance:** `tests/acceptance/m7-checkpoints-reset.test.ts`, one real server process, both
  restarts in place, the egress tripwire empty. The two browser tests stay separate files.
- **One list of Nova's entries:** `entries.ts` (`NOVA_ENTRIES`), shared with checkpoints. Added
  there by the reset: `factory-reset.json` and `reset-report.json` (both also in checkpoints'
  `SKIP_TOP`, so a restore leaves them as they are). Not added: `captures`, which the plan names
  but no code writes (capture lives in the database); a folder of the person's by that name stays.
- **Browser test** is `tests/ui/m7-reset.test.ts` (the plan names one shared file,
  `m7-checkpoints-reset.test.ts`; the integrator may fold them together). Nobody restarts the
  server in it: the page opens first-run setup by itself once Nova is back.

**2026-10-30 (M7 amendment): checkpoints and restore.** Branch `m7-amend/checkpoints`; the plan's §1
and its as-built note. Every behaviour has a test that failed first.
- **What a checkpoint is.** The whole home, the identity and vault key file included, in
  `<home>/checkpoints/<seq>-<slug>/` (0700/0600), with a sealed manifest in the nightly format. Its
  seal key is `checkpoints/.seal`, not the vault, so a stopped home can be checkpointed. Nightly
  backups (`SKIP_TOP`) and the standby's journal (`NOT_JOURNALLED`) leave `checkpoints` out.
- **Retention, as the UI states it.** The newest 10 automatic checkpoints, counted by sequence and
  never by date. Named ones stay until the person deletes them (tier 3, the hub's screen, after
  review: NOVA-SPEC puts deleting data at tier 3), at most 20 of them. A new checkpoint is
  complete before any prune. A disk too full refuses in plain words.
- **Automatic.** At ship and before a canary that hasn't applied yet: none, and the change waits
  ("Not shipped: Nova couldn’t take a checkpoint first…"). Before a database upgrade: none, and no
  upgrade, so no start. Before a release switch: the supervisor, on the stopped home; none, and no
  switch. A home with no database yet is skipped. Before a restore.
- **Forgets.** `Backups.also` cleans every checkpoint and a staged restore. One that can't be
  cleaned is destroyed and reported. Unsealed folders named like checkpoints are cleaned too,
  because they sit in Nova's own folder.
- **Restore.** Tier 3, the console only, `{confirm: true}` every time. A damaged checkpoint, or
  one from a newer schema, is refused. It is staged, then applied before the database opens by
  renaming top-level entries; each step can be repeated. The record becomes a ledger task once.
- **Interpretations.**
  - "Identity" means this node's `mesh/` folder as it is now. A key replaced since is never put
    back, and the identity is the same in the ordinary case.
  - "Trust decisions" means the stricter of then and now for approving. Sign-ins that ended stay
    ended. Unused pairing codes from then are spent.
  - Forgets: the "forgotten" notes and capture tombstones come along, so nothing forgotten is
    taken in again.
  - Problems are matched by time, source and message, not by id, so they survive restores that
    happen one after another.
  - Nova's own records of what is outside the home come along: backup runs and drills, the
    recovery key it showed, and its `nova/*` vault keys. Without them, backups made since would
    become strays, out of reach of forgets. The person's saved secrets go back with the
    checkpoint.
  - Only Nova's own top-level entries (`src/core/resilience/entries.ts`, derived from every place
    the code writes under the home) are checkpointed and restored. Files in the home that aren't
    Nova's are never copied, moved or undone, and the confirmation says so.
- **The standby copies afresh.** It treats its own hub at a higher epoch as a restarted log: it
  drops what it copied and reads the log from 0. Promotion names another hub, and replacing the
  hub's keys revokes the standby, so neither triggers this.
- **Restart in place.** `core.restartInPlace(why)`. Under the supervisor, a `restart` request
  with `staged: true` is honoured only with a marker on disk, and is no crash. Without the
  supervisor, the server's release hook closes the listeners and the core, then `process.execve`
  restarts the same program: same pid, same ports. The reset builder adds its marker to
  `stagedPending` and `finishStaged`.
- **After review (same day).** Each fix has a test that failed on the code before it.
  - What is kept from now is read at swap time from the outgoing database, so a revocation,
    problem or backup made after staging survives.
  - A restore whose restart can't happen is dropped at once and said; it never fires later.
  - The marker lists every staged file by hash. An incomplete or changed staging is dropped
    (anything moved put back) with a problem: Nova never runs a mix. Dropping renames the folder
    away first.
  - `core.stopWork` halts running tasks and ends every process Nova started (`children.ts`)
    before an in-place restart and on a stop.
  - Half-taken checkpoints are removed at start and before every forget.
  - Deleting a checkpoint is tier 3, and at most 20 named ones are kept.
  - A full disk while staging refuses in plain words; after a complete swap it is a problem, not
    a failed start.
- **Small changes elsewhere.**
  - `Db.migrate({before})`.
  - `ChangesOptions.checkpoint`. "Ship it" on an OK'd change that was held back retries its task.
  - `SupervisorLink.request(…, {staged})`.
  - `SyncLog.fresh()`.
  - The service worker never caches `/api/v1/resilience` (shell v8).

**2026-10-30 (packet amendment, owner): checkpoints and factory reset, folded into M7.** Added to
ROADMAP-AND-GATES under M7, binding, and not a new milestone. M7 was already merged (#219), so it
ships as its own PR; the plan is `docs/plans/M7-amendment.md`.
- **Checkpoints:** restore points of the whole data home. Nova takes one automatically before
  self-changes, upgrades, releases and restores, and the person can take named ones. Each is
  listed with date and size. Retention keeps the newest 10 automatic ones, by sequence, and named
  ones until deleted.
- **Restore:** tier 3, from the hub's screen only. It never brings back a revoked device or a
  forgotten memory, and it raises the mesh epoch.
- **Factory reset:** in Settings, under a Danger zone section. Nova offers an export first, and
  wipes only what it made, by name.
- **Backups on reset:** wiped as the owner expected, in every folder Nova ever backed up to,
  after the export offer. A folder that can't be reached (an unplugged drive) can't be wiped;
  that is said beforehand and afterwards.
- **What the export leaves out:** saved secrets, the vault key and identity. The screen says so.

**2026-10-30 (M8b): Relay is a provider like the others, and Nova's checks still decide.** This
work is on branch `m8b/relay-adapter`. It was built against Relay v0.9.0's own `contract/v1.json`
(commit `4add265`); `tests/support/relay-contract-v1.json` is a byte-for-byte copy of that file.
The as-built note is in `docs/plans/M8.md` §2.

- **Relay is registered as a built-in implementation, `relay`.** It is a coding agent over HTTP,
  with no special UI. Its address must be loopback, because Relay binds loopback, and it has no
  secrets.
- **Where the data goes is what Relay reports, not what the address implies.** Relay is always on
  this computer, but its workers may send the brief to Anthropic.
  - Providers gained an optional `reportedWhere` hook. Each run reads its settings once. Relay is
    asked again at its start, and the provider checks the task's privacy mode against Relay's fresh
    answer right before a worker starts, so a local-only task never reaches a remote worker.
  - **What "local" can't tell.** Relay reports `local` when the address Claude Code calls is on this
    computer. A proxy on this computer that forwards to the cloud would still read as local. The
    provider's words in Settings › Providers say so.
  - Receipts record Relay's report as the egress (`local` or `remote:anthropic`), with provider
    `relay`. They don't say "remote:anthropic via relay": the receipt format allows only `local` or
    `remote:<name>`. A receipt is written once a worker has started, with what Relay said then; a
    busy answer writes none.
- **No `.git` in the task's folder.** The task's files are committed into a repository under Nova's
  state for the task, one per content. That location is untracked and not synced.
  - One per content, because Relay keeps a connected folder's commit from its first connection: the
    same files reuse it, changed files get a new one.
  - **Nova never runs git in a folder Relay names** (the review found that a crafted `.git` there
    could run a command). It walks the worktree with `lstat`, never following a link and skipping
    `.git`, and compares it with the files it handed Relay. The worktree must be
    `<dataDirectory>/worktrees/<runId>`. Copy-back happens only when the walk matches Relay's list.
    It is planned, sized and read in full before anything is written, and it includes deletions.
- **What Relay reports is kept, but it is never evidence.** The run is kept as a `relay-run`
  artifact: its id, worktree, branch, base commit and Relay's diff. Providers can now return
  `artifacts`, and they are carried through Nova's ask-before-testing step.
  - Nova asks Relay for `check: 'none'`, so the brief's test is Nova's own run, after the person's
    OK.
- **A busy Relay is a wait, not a failure.** A `runtime_busy` answer is a blocked report with
  `retry_after_s`. The registry asks again by itself, and after a restart too. That is safe, because
  the worker only edits a copy.
  - **The `requestId`** is a UUID made from the task id, its idempotency key, the attempt and the base
    commit, so the same attempt never starts a second run. One Relay project and task are kept per
    attempt.
  - **Nova stops asking after `busy_limit` busy answers in a row** (120 by default, an hour at 30 s).
    The task then waits for the person: "Relay has been busy for an hour; Nova stopped asking."
  - **Cancelled while a start is on its way:** the same request is sent again, which names the run,
    and the run is cancelled.
- **A dispatch whose work never started isn't an attempt (a ledger change).**
  - **The rule.** A running worker may call `ledger.notStarted(id, why)`. Only a `blocked` report takes that claim. The ledger then gives the dispatch back and records `attempt_returned` ("Relay was busy; this didn't count as an attempt."). A done or failed report is counted regardless.
  - **Restarts.** `recover()` gives back an active task's dispatch if it had claimed not-started.
  - **Relay** claims it only for `runtime_busy`. Relay records a run only after its busy check (`runtime/workers.mjs` 77–100), so reusing the attempt's `requestId` after a give-back starts a fresh run.
  - **Why.** Before this, four busy answers and then one failed verification ended the task failed ("Gave up after 6 attempts").
- **The independent review of M8b** found eight problems, each now a test in
  `tests/core/relay-review.test.ts` that failed before its fix:
  - privacy judged on a stale answer, or on another Relay than the brief went to;
  - git run in a worktree Relay names;
  - a stale baseline after a busy wait;
  - an unbounded busy loop;
  - an orphan run after a cancel mid-start;
  - a `requestId` that could recur;
  - a copy-back that could half-apply or exceed the size limit;
  - unbounded answers.
- **The re-review** found three more problems, each now a test (R1–R4 in the same file) that
  failed before its fix:
  - **Ignored files or line endings failed every run.** Nova's own git now runs with no system or
    personal config, no excludes, `autocrlf` off and no attributes file. It commits with
    `add -A -f`. Its `info/attributes` turns off eol and filter rules, so the task's
    `.gitattributes` can't change the bytes, in the commit or in Relay's checkout. The commit is
    checked blob by blob.
  - **The 1 MB answer cap broke on a Relay with history.** Caps are now set per route: 64 MB for
    `/api/state`, 8 MB for a run record, 1 MB otherwise.
  - **A start that timed out was given up.** It is now sent again with the same `requestId` and no
    time cap, and the run it names is followed. The per-answer wait is the hidden
    `request_timeout_s` (default 20).
  - **Also:** hard links in the worktree are refused, the walk stops past 20,000 entries or 64
    folders deep, and a run id must be a UUID.
  - **Known limit:** files the worker creates that the task's own `.gitignore` ignores (a build
    folder) are left out of Relay's list but seen by Nova's walk, so such a run fails with the
    mismatch reason.
- **A chaos test made robust.** The full-database test (`tests/chaos/disk.test.ts`) depended on how
  full SQLite's last pages happened to be, and Relay's manifest changed that. It now fills to the
  brim.
- **Open:**
  - Relay keeps every worktree, and Nova keeps each attempt's repository: there is no cleanup yet.
  - Relay's accept/merge into a real repository is a later mode.

**2026-10-30 (owner decision): real-phone pairing check deferred; pairing clocks logged as a
usability defect.** The owner's first real pairing attempt, from a phone over Tailscale, didn't
finish. Before that, it was refused as cross-origin: a proxy pointed at the console, not the device
door. That is fixed: the preview opens the device door on loopback, and Tailscale Serve 9446 points
at it.
- **Deferral.** The owner decided that the real-device pairing check waits until they are back at
  their desk. The emulated-phone pairing in the M4 gate (`tests/ui/m4-mesh.test.ts`) stands in for
  it. No milestone blocks on it.
- **Defect, open (usability), as the owner reported it.** A person juggling two devices loses the
  race against the clocks: the code seemed to expire about 7 minutes after it was made, and a
  pending request had about 2 minutes to be approved.
- **The code's clocks today:**
  - a pairing code works once, for 5 minutes (`PAIRING_CODE_TTL_MS`, `src/core/mesh/wire.ts`);
  - after the phone joins, the confirmation must be revealed within 2 minutes
    (`JOIN_REVEAL_TTL_MS`);
  - then it must be approved within 10 minutes (`JOIN_APPROVE_TTL_MS`, `src/core/mesh/enroll.ts`).

  The 2-minute reveal window is very likely the "approval window" the owner hit. The reveal happens
  on the phone's side, so a slow step there ends the request.
- **When pairing is revisited**, the windows get longer, or the flow tolerates a retry without
  starting over (for example, an expired request can be re-revealed under the same code while the
  code is still valid). Both keep commit-then-reveal and the single use of a code. Not changed now.

**2026-10-30 (M7 review fixes): the change pipeline's guards.** Branch `m7-fix/changes`; tests in
`tests/core/changes-guards.test.ts` (the reviewer's probes, made real), each failing on the code
before its fix (checked against `fdd33ea2`).

- **Only the pipeline makes its tasks.** A worker may be `internal` (`ledger.ts`): the ledger
  refuses `create()` for it unless the caller holds the worker's own key, before even the
  idempotency look-up. `changes` and `foundry` are internal, so POST /tasks, a device's
  task_request, a connector's delegate and a trigger's action (heartbeat, webhook or a firing
  that carries its own action) can't make one; `createRule` refuses such an owner too. Backstops:
  the changes worker runs a brief only when its `task_id` is the record's own check/ship/rollback
  task, its `minTier` is the change's tier for ship and 2 for rollback, and `#ship` refuses a task
  whose ledger approval is below the change's tier or absent. The approval stage's evidence is read
  from the ledger (task id, tier, `approved_at`, the `approved` event); `confirmed` is true only for
  a tier-3 task the ledger approved, never asserted.
- **The sandbox is inert.** A sandbox core's triggers record a task action as it would have acted
  and start nothing (`Triggers({sandbox})`). `inert()` also deletes the `backups`, `providers` and
  `models` profile sections and turns capture sources off with no config (also used by the restore
  drill, which checks before `inert`; that edit is two lines in `changes/sandbox.ts`). A rule
  pack's task may be for `workspace` at any tier; any other worker needs an explicit
  `approval_tier` of 2 or 3; `changes`/`foundry` never (already refused by `weakens`). A change
  that fails its contract stops at tests without its own tests running on the copy.
- **Rollback is exact.** An extension's snapshot copies aside, byte for byte, only the paths the
  change will write (`workers/changes/<id>-previous/`, removed once it is rolled back), with their
  hashes; rollback writes back only those (a copy that doesn't hash as recorded is not written:
  the change goes `broken` with the reason) and deletes what wasn't there. `Extensions.restoreState`
  puts `installed`/`enabled`/`disabled` back exactly; a brand-new extension is removed with
  `remove(id, {purge: true})` (no kept/ or exports/ copies). Design systems use the same state and
  purge, and put back only what the change set: the person's choice while it is still this one,
  and the canary device's own entry; other devices' choices stay.
- **A rollback by hand during a canary is immediate.** Rollback tasks have their own lane
  (`rollback:<id>`); the Ship task is cancelled with "You rolled it back during its canary." (the
  person's decision: no failure, no problem).
- **The approval card shows what ships.** A rule pack's task line names the worker, tier (in
  words), privacy mode and the task's inputs as JSON.
- **Ship and roll back need an approver** (`access: 'approver'`). A canary `device_id` must be the
  hub or a trusted paired device (`knownDevice`), else the proposal is refused (400).
- **Minors.** The canary record carries `applied` (false until apply finishes; a rerun applies it
  again; ticks skip it meanwhile) and `elapsed_ms` measured on a monotonic clock between looks in
  this process (a wall-clock jump can't end a window early; time Nova was stopped doesn't count;
  `ends_at` stays as the estimate shown). On the test clock, or with an injected `now` in tests,
  that clock is the monotonic one. A promotion that throws rolls the change back. Right before
  apply the artifact is hashed again and the release file read back; a mismatch stops the change
  unapplied.
- **Known limits.** The set-aside copies live under `workers/`, which isn't journalled to a
  standby: rolling back an extension change on a standby promoted mid-canary can't put files back
  and ends `broken`, saying so.

**2026-10-30 (M7 review fixes): resilience — supervisor, releases, backups, drill, playbooks.**
Branch `m7-fix/resilience` from `m7/self-modification`. Every fix has a test that failed first.

- **Forgets owed to a missing folder.** A forget reaches every folder Nova ever backed up to
  (from `backup_run`), not only the one set now. A folder that isn't there owes it: the forget
  is written to `kept/.nova/forgets-owed.json` (in the home's `kept`, so never in a backup, a
  sandbox copy or the standby; its words sealed with AES-GCM under a key derived from the seal
  key) and carried in before any backup run, prune or drill, and on every heartbeat. A problem
  (`forget-owed`, one per folder) says so until then. A folder counts as back when it exists and
  holds Nova's backups (or never had any): an empty mount point doesn't silently drop a forget.
  Residual: if the person deletes every backup in that folder themselves, the problem stays open
  until they mark it dealt with. The drill checks every kept backup (or encrypted copy) for
  forgotten things (`forgotten-everywhere`), not only the one restored.
- **Only Nova's backups count.** A backup is a folder recorded in `backup_run` (id and seq) whose
  manifest carries Nova's HMAC seal (key `nova/backup-seal` in the vault). Anything else named
  like one is a stray: never restored, never latest, never pruned, shown in GET /backups and on
  Health. No migration was needed. Backups made before this fix carry no seal and are strays
  (M7 is unreleased; nothing is deleted). Manifest paths go through the same check as untar
  (`safeRel`) in `restoreInto` and `cleanBackup`.
- **Backups are the person's alone.** 0700 folders, 0600 files whatever the umask; a folder
  owned by someone else, or writable by group or others, is refused when chosen and at backup
  time. `PUT /backups/settings` is approver-only (tier 2).
- **The recovery key.** The encrypted copy's key is shown once as a recovery key (64 hex digits,
  eight groups) when the copy is set up; again only at tier 3 (`POST /backups/recovery-key
  {confirm: true}`, the hub's own screen). `openEncrypted(file, key, out)` opens a copy with no
  home and no vault. The drill opens copies with the recovery key the person was shown (checked
  by fingerprint), or one given to it, never whatever the vault holds now. The key is in no
  backup in readable form; the vault's file in a backup carries it encrypted under the vault key,
  which never leaves the machine.
- **Supervisor problems close; restarts don't run away.** A crash or hang the supervisor dealt
  with closes at the next sweep of the server it started. `restart-server` is never run by Nova
  itself, and a person's restart repair is the console's or an approver's. The supervisor takes
  at most one asked-for restart per window (a minute), and each counts toward safe mode.
- **free-scratch** deletes only this process's leftover scratch and that of stopped processes
  (scratch names carry the pid: `nova-<kind>-p<pid>-…`), never a running process's folder.
- **Rollback restores.** The release reports its mark (sync log seq, newest problem) over IPC as
  `core.start()` begins, before recovery, ticks or dispatch. The slot records `mark.by`
  (`release`, or `supervisor` for a release too old to say, read after its start). A restore says
  in the history and on its problem what it restored.
- **Minor.** Tags `current` and `base` are never releases. Any failure after the running release
  stops puts it back. Rollback from safe mode with nowhere to go keeps safe mode. A refused
  rollback whose release won't start again goes to safe mode, with the refusal in the database.
  `base` runs a slot pinned to the repository's HEAD at supervisor start
  (`releases/.base-<commit>`), never the checkout on disk. The supervisor's folder must be the
  person's and 0700. The control socket wants the typed confirmation (the version, or
  `rollback`); `rollback --confirm` is now `--confirm rollback`. **Residual:** any program running
  as the person can connect to the 0600 socket and send the same bytes as the CLI. Node has no
  peer-credential check, and a same-user process could drive the CLI anyway. The confirmation
  guards against slips, not against code already running as the person. Sandboxes always get
  `NOVA_HOST=127.0.0.1`.

**2026-10-30 (M7b): the supervisor, code releases, backups, the restore drill and the chaos pass.**
Branch `m7b/resilience`; the plan's §2–§3. Code in `src/supervisor/` and `src/core/resilience/`,
migration `0012_resilience.sql` (local tables: playbooks, backup runs, drills).

- **The supervisor is its own process** (`node src/supervisor/main.ts run`), the server its child
  over an IPC channel (no listening port: only the child can ask it anything). Crashes restart
  after 1 s, doubling to 30 s; three within a minute is safe mode: the server is held, the reason
  goes into the state file, the database (a problem with the `safe-mode` playbook, written
  directly since no server runs) and a small page on Nova's own port (loopback, 503 for the API),
  with `rollback` (to the last good release) and `recover` offered. Safe mode survives a restart of
  the supervisor. Health is asked every 30 s; three unanswered in a row restart the server (3 s
  grace, then SIGKILL). The command line reaches a running supervisor through a 0600 Unix socket in
  its state folder. It refuses to start when a server already runs the home (`nova.pid`).
- **Releases are git tags**, each in a slot `<dir>/releases/<tag>/` (a worktree of the tag's commit;
  a slot that isn't exactly its tag any more is made again), `current` a symlink swapped by rename.
  `base` is the checkout the supervisor runs from. Deploying is tier 3: the command line asks for
  the tag to be typed (or `--confirm <tag>`); the API (`POST /api/v1/supervisor/deploy`) is the
  console's only, with `confirm: true`. Stages: the release's tests (`npm test` by default, run in
  the slot with a scratch HOME; a slot borrows the base's `node_modules` when the lockfiles match)
  → a sandbox start on a copy of the home → smoke probes → switch → canary (2 min by default, never
  under 2 s or two probes) → promote. A release from before M7b (no sandbox mode) is refused at
  prepare. Health that already failed before the deploy (a backup drive unplugged) is no fault of
  the release and doesn't fail its canary or smoke probes.
- **The database across a release.** "Nothing was written since" is the sync log (migration 0006)
  not moving past the mark taken when the new release first answered: every write to the person's
  data adds an entry with a rising sequence. Set aside: problems (Nova's own diagnostics, carried
  over into the restored database so none is lost) and the file journal (the files stay on disk and
  the journal records them again). Deviation worth knowing: writes the new release made between its
  migration and its first answer are Nova's own start-up, and are undone with the restore.
- **Backups** go to a folder the person names, which Nova never creates (a drive not mounted must
  not become a folder on the wrong disk) and which can't be inside the home. Retention keeps the
  newest N by sequence number, never by date, and only after a new backup is complete. The
  encrypted copy is one file per backup (a ustar archive, AES-256-GCM, header bound as AAD, written
  in chunks, nothing unpacked until the tag checks); its key is `nova/backup-key` in the vault. The
  vault's own file is in a backup, its key is not: a restored home can't open its vault, said
  plainly (the drill sets that check aside). The home's git history isn't in a backup (it can hold
  keys exposed before M4c untracked them). Forgetting: `Backups.also` carries every forget into
  each nightly backup (the snapshot cleaned like M2's, text files rid of the lines with the words,
  hashes rewritten) and each encrypted copy (decrypted, cleaned, encrypted again); one that can't be
  cleaned is destroyed and reported.
- **Schedules are visible rules**: setting a folder adds "Nightly backup" (03:30) and "Weekly
  restore drill" (Sunday 04:00) heartbeat rules; both run as `resilience` ledger tasks whose
  evidence Nova reads itself (the backup's database hash against its manifest; the drill's record).
- **The sandbox is M7a's.** Its sandbox mode (`createCore({sandbox})`, `NOVA_SANDBOX=1`) and its
  `inert()` (exported for this) are used by the drill (after the restored copy is checked) and by
  the release sandbox (on `copyHome`, a snapshot plus the files a backup carries). The drill and the
  supervisor start the process themselves (a release's code; a restored home), so M7a's `Sandbox`
  class, which snapshots the live database in process, isn't used as is. server.js also skips
  fencing, schedules and helpers in a sandbox; config.js gives a sandbox no mesh listener whatever
  `nova.config.json` says.
- **Playbooks** (`resilience/playbooks.ts`): problems opened in other modules' own words are
  classified (a failed task by its worker, the model manager's fault, the standby behind, a device
  in safe mode, a full disk), so no module had to change how it reports. Automatic repairs only
  where nothing of the person's can change; at most three by Nova, a minute apart; the person can
  run one any time. A failed task's problem stays open after its worker answers again: the task is
  the person's to retry. Changes to M5/M6 behaviour, each found by the chaos pass: the model manager
  opens its fault problem in local-only too (it only did when the cloud answered instead); a
  secret that didn't reach the disk is no longer kept in memory; a problem the database can't take
  (a full disk) is still emitted and listed, from memory, and the log never throws; the hub can ask
  a device agent in safe mode, once, to restart its runtime (`restart_runtime` in the heartbeat
  reply; the boot agent runs `recover`); a connection that keeps failing to reconnect is watched,
  and its problem says when the name won't resolve.
- **The clock**: the heartbeat compares wall time with the time that really passed; a start
  compares now with the newest time written down. A jump opens `clock-jump`: schedules whose last
  run is "in the future" are put back on time, device sign-ins dated in the future end, and capture
  retention is held until the person marks it dealt with. Backup retention needs no hold (by
  sequence).
- **Chaos simulations, all safe**: a full disk is SQLite's own `max_page_count` (the same "database
  or disk is full") and ENOSPC injected into Node's fs for one test folder (`syncBuiltinESMExports`);
  DNS failing is an injected resolver (no real query); partitions and slow links are a loopback
  proxy the test controls; crashes are SIGKILL/SIGSTOP to processes the test started.
- **Gaps.** No OS service unit for the supervisor (run it as you'd run Nova). A device that is
  simply off isn't a problem (devices sleep); its queue delivering exactly once on reconnect is
  what is tested. The standby's own "unreachable for a minute" is wall time, so its test records
  that problem rather than wait a minute. No remote backup target (the owner's choice later).

**2026-10-30 (M7a): the governed change pipeline and the foundry.** Branch `m7a/changes`; the
plan's §1. Code in `src/core/changes/`, migration `0011_changes.sql` (the integrator renumbers).

- **Two ledger tasks per change.** *Check* (worker `changes`, tier 0) runs sandbox → tests →
  health → release and never asks anyone; a change that fails it is stopped with the reason and
  never offered. *Ship* is made only once the ledger has verified Check (Nova re-reads the release
  file and re-hashes it), at the change's tier, so approval always comes after the sandbox
  evidence; it then runs the canary and ends Done (promoted) or Failed with the probe's reason
  (rolled back by itself; the ledger opens the problem). A Ship task waits on the canary's outcome;
  the canary is driven by the clock (every 60 s; `POST /changes/tick` under `NOVA_TEST_CLOCK`).
  Every stage is also a `stage` ledger event with its evidence. Rollback by hand is a third task,
  tier 2, OK'd by the click that asked for it (`{confirm: true}`).
- **The sandbox is a real Nova process** (`src/server.js` with `NOVA_SANDBOX=1`, loopback, port 0,
  the parent's preloads so the egress tripwire covers it) on a scratch home in `workers/changes/<id>`
  built from `VACUUM INTO` plus the standing files and, for an extension, its folder. The copy is
  made inert before it starts: queued and running tasks cancelled, the person's rules paused,
  provider/automation/connector extensions disabled, device addresses and sessions cleared, the
  sync log dropped; no vault is copied. Sandbox mode (`createCore({sandbox})`) starts no
  connectors, capture, model watch, heartbeat or canary clock, and takes no changes. Its chat model
  is declared remote so the privacy probe has something to refuse. Deviation: the plan says
  "needed files"; only the standing files and the extension's own folder are needed today.
- **Gates.** Frozen constants (`gates.ts`): stage order, minimum canary per kind (rules and
  extensions 30 min, templates 15, design systems and settings 10), at most 7 days, three passing
  probe runs minimum, the fixed sandbox and canary probe sets. No route or profile section holds
  them. `weakens()` refuses a proposal that names a gate field (`skip_stages`, `tier`, …), asks
  for a shorter canary, replaces the core probes, changes a `changes`/`pipeline`/`gates` setting
  or a canary/probe/stage key, asks to write the pipeline's records, starts pipeline work from a
  rule, or carries files into Nova's code. Refusals are kept as `refused` records; nothing of them
  runs. `enter()` refuses any stage whose predecessors haven't passed, whoever asks.
- **Tiers.** Proposed by the foundry or a provider: 3, every time. Privacy and policy settings: 3.
  An extension update asking for permissions the installed version didn't have: 3; any
  permissions: 2. Rule packs whose rules start tasks: 2. Otherwise a person's own change is 1 (act
  and report), its proposal being the OK.
- **Kinds and canary scopes.** Rule packs: the rules (created_by `changes:<pack>`, changed in place
  by name so their history stays), watched over their first firings (its error probe counts firings
  that failed to start work or whose tasks failed). Design systems: one device (the hub's, or
  `canary.device_id`), then everyone; the live check is the device showing it with contrast
  holding. Extensions: skill packs, plugins and MCP servers as manifest and files (providers,
  connectors and design systems keep their own ways in); tests and the health probe are
  declarative, since Nova runs no extension code. Settings: identity, user, tuning, privacy,
  policy (the rest have checked routes of their own). Templates: proposed, dry-run, activated
  through the ledger; rollback reinstates the previous version (`Templates.reinstate`, new).
- **Rollback restores the snapshot taken just before the canary**, and only that target: an
  extension's previous manifest, state and files; a design system's package and the four
  appearance keys; a setting's value or its absence; a pack's rules; a template's active version.
  Rolling back by hand is offered only for the newest live change of a target; the one it had
  replaced is live again.
- **Release.** `changes/<target>/<version>-<id8>/` holds `artifact.json` (canonical JSON, hashed as
  the record's `content_hash`), `change.json` and `evidence.json`, committed with
  `git commit -- <that folder>` when the home keeps history (files only; the privacy check fails a
  change carrying a vault value, so none reaches history). Previous releases stay. The folder is
  journalled, so it reaches the standby with the record (`change_record` replicates).
- **The foundry** asks the local model by default (`models.infer`, role reasoner, receipts by the
  model manager) or the chat model (`via: chat`, a receipt when the handle keeps none), with M5's
  JSON files contract, and writes the reply into `workers/foundry/<task>/` with M5's path checks.
  It needs `manifest.json`, `tests.json` and `probe.json` and proposes the package as the
  foundry's change; the Check/Ship path is the same as anyone's.
- **PWA:** Settings › Changes (`ui/js/changes.js`, `ui/styles/changes.css`): the waiting change
  with what the sandbox showed and "Ship it" (the one standout; tier 3 needs the confirm box), the
  list with status in the one vocabulary, canaries with their probes as last run, evidence one
  layer down, Roll back that asks first. `/api/v1/changes` is network-only in the service worker.
- **Tests:** `tests/core/changes.test.ts` (8, real sandbox processes), `tests/acceptance/
  m7a-changes.test.ts` (2: hub and standby with the egress tripwire, the foundry on the stand-in
  Ollama; canary sabotage over the API), `tests/ui/m7a-changes.test.ts` (Chromium, via
  `scripts/ui-test.sh`), and opt-in `tests/acceptance/m7a-real-ollama.test.ts`
  (`NOVA_REAL_OLLAMA=1`, read and infer only). Run once here with Qwen3:8b: the first prompt
  (placeholder shapes) got a pack with `"cron": "M H * * *"`, which the gates stopped at tests;
  with example-filled shapes it wrote a 21:00 wind-down pack that passed every gate, waited for
  the OK, canaried and went live. Both outcomes are the pipeline working; only the second is the
  prompt working.
- `tests/acceptance/m4b-device-agent.test.ts` now picks its restartable mesh port below the
  ephemeral range (M4c's `freePort`): the sandboxes' port-0 listeners made the old race show up.

**2026-10-30 (M6b review fixes): the model manager's guards.**
Branch `m6-fix/models`; tests in `tests/core/models-guards.test.ts` (the reviewer's probes, made
real), each failing on the code before its fix.

- **Trust is checked per call.** `placement()` returns a role only while its device is the hub or a
  trusted computer; a revoked one (the devices `revoked`/`change` events) loses its roles and its
  runtime address, reads `unassigned`, gets no call and no wake packet. Local-only work waits.
- **Ollama cloud models never serve a role.** One rule (`OLLAMA_CLOUD` in `providers/types.ts`,
  used by the registry and the manager), plus tags carrying `remote_host`/`remote_model`: refused
  in assign and accept, re-checked in `#local`, never recommended, and System 1 stays on the rules.
- **Model tasks always ask.** The worker's `minTier` is 2 whoever made the task; at run time the
  brief's URL is ignored (Nova's own runtime for the device is asked), and the name, the
  role-in-use guard and the disk budget (catalog size over the brief's) are checked again. Only
  lists read from that runtime are recorded.
- **System 1 is never quieter than the rules.** A model's drop/silent where the triage rule says
  act/queue escalates (held for an OK); the reason kept is Nova's fixed words, never the model's
  `why` (ADR-7).
- **Budgets.** Each cloud call sends `max_tokens` (4096 unless the cloud model sets one) and
  reserves its most possible cost in the same step as the check; overshoot is at most one call's
  maximum. A stream that breaks after text arrived is charged its full reservation (what was used
  isn't known). Tokens without a cost are priced from `models.prices` (`PUT /models/prices`) or,
  with a budget set, said plainly and the cloud waits. The "can't tell what the cloud model costs"
  refusal applies only to calls for the cloud model; a provider's budget wait (`via: 'provider'`)
  is released by the budget alone.
- **Fallback before output only.** Once text reached the person, `infer` ends with an honest error
  instead of a second model's reply.
- **Spoke addresses.** Before every call and wake the host must be in the computer's latest
  heartbeat and private, LAN or mesh (a name must resolve only to such). Not "recent": a sleeping
  computer sends none, and the latest is what it last said. Heartbeats keep only private IPv4
  addresses and a one-label host name (`desk.local` reads as `desk`; dotted names are dropped).
  Private here includes the example ranges (192.0.2/24, 198.51.100/24, 203.0.113/24), which are
  never routed on the internet and are what tests use. Wake targets: private or broadcast IPv4.
- **Minors.** Receipts for a computer name it (`ollama@<name>`; plain `ollama` stays the hub, so
  existing receipts and gate tests read the same). Work waiting on a computer that didn't wake says
  so and runs on its next heartbeat; Nova doesn't keep sending wake packets. Ollama 5xx or an error
  line mid-reply (out of memory) is local capacity: the work waits. The role-set provider's words
  name the cloud model when the privacy mode lets it answer.

**2026-10-30 (M6c): the gate, a day in the life local-only.** Branch `m6c/gate`; the plan's §3.

- **CI:** `tests/acceptance/m6-day.test.ts`, with the day itself in `m6-day-support.ts`. It runs
  two real processes (a hub and a standby, M4's helpers; `setup()` now takes extra hub env), the
  egress tripwire, a fixed hub-class hardware reading, and stand-ins for Ollama, Screenpipe and the
  cloud model. The day runs on capture's test clock (`2030-01-15`) and covers:
  - setup by conversation, local-only;
  - roles accepted from installed models, with transcription unassigned;
  - capture classified by signals: one event stays unclassified, and an incognito window is
    never stored;
  - triage by the local decision provider: a Noul proposal, plus heartbeat and event triggers
    (Choice);
  - chat and the M5 calc brief through the reasoner role;
  - a captured fact promoted, then forgotten on both nodes (database, WAL, backups);
  - a midday outage: the task waits, the person is told, the cloud is asked nothing, and the task
    reruns;
  - the evening retention sweep.

  Every step is asserted. `NOVA_EVIDENCE=1` writes `docs/evidence/m6-day.md`.
- **Real:** `m6-day-real.test.ts` (opt-in, `NOVA_REAL_OLLAMA=1`) runs the same day with the hardware
  read for real and Nova's own recommendation: Qwen3:8b, deepseek-r1:32b and nomic-embed-text.
  - Screenpipe is still the stand-in, and there is no standby.
  - Ollama is reached through a loopback relay that passes only reading and inference. The outage
    is that relay closing, a dead port; the evidence says so.
  - What a model decides is recorded as it happened. Privacy is asserted as in CI.
  - The committed `docs/evidence/m6-day.md` is a real run: 415 s, every step done, every receipt
    local.
- **Fixed on the way.** An event captured while the sorting model was down fell through to the
  rules, which have no rule for `capture-promote`. It was counted as looked at and never proposed.
  Now the pass stops when the provider that should answer (`proposer`, the local model once one is
  assigned) didn't, and a later pass asks again.
- **Seen in the real run, not fixed.** Qwen3:8b answers p = 0.9 to `capture-promote` for nearly
  every event, so its proposals aren't selective yet. Proposals stay proposals: nothing becomes
  memory until the person accepts.

**2026-10-30 (M6b): local models — hardware, roles, downloads, one inference API, wake, fallback, budgets.**
Branch `m6b/models`; the plan's §2. Code in `src/core/models/`, migration `0010_models.sql`
(M6a took 0009). PWA: Settings › Models (`ui/js/models.js`, `ui/styles/models.css`).

- **Hardware.** `models/hardware.ts` reads CPU, memory (`/proc/meminfo` where there is one), GPUs
  (`nvidia-smi`, `rocm-smi`; `system_profiler` on macOS, where Apple silicon's shared memory counts
  as three quarters of RAM), free disk (`statfs` of Nova's home, which may not be the disk Ollama
  keeps models on) and network cards. Node built-ins only, so the device agent carries it (the
  boundary test and the agent's file list now name it). The **boot** agent reads it, because the
  runtime may not start programs, and hands it to the runtime, which sends it in the heartbeat as
  an additive `hardware` field; the hub checks and keeps it (`device_hardware`). Windows: only
  `nvidia-smi`. `NOVA_HARDWARE_FILE` replaces the hub's own reading (tests, the gate's stand-in run).
- **Recommendation.** One model per role, not a list: sorting (`triage-text`) is the smallest
  capable text model (3–9B) on the hub; thinking and writing (`reasoner`) the deepest that fits
  (file size × 1.15 within VRAM, or half the RAM with no GPU, said as slow), coders last; a GPU
  spoke only when it is clearly deeper (×1.5) than the hub, with a hub model for small jobs;
  finding by meaning the smallest embedding model. Installed models first; with none that fits,
  one download from a short catalogue, never assigned by itself. Transcription: Ollama can't, and
  Nova has no whisper adapter, so it says so (also when it finds a whisper binary) and stays off.
  Against the real Ollama here: Qwen3:8b, deepseek-r1:32b, nomic-embed-text, transcription off.
- **Roles live in profile section `models`**, set only through `/api/v1/models` (the generic
  profile route refuses it, like providers). A role names `hub` or a paired computer; a computer's
  runtime address must be one of the addresses (or its hostname) its own heartbeat reported.
- **Downloads and removal are tier-2 ledger tasks** for the worker `models`, evidence a
  `confirmation` from system `model-runtime`. The verifier's checkers are synchronous, so, as with
  n8n's callback, the checker reads what Nova itself recorded from the runtime's own `/api/tags`
  after the pull (`model_version`, never the pull stream's say-so) for this task, and a digest the
  request pinned. Ollama checks each layer's sha256 as it writes it; Nova doesn't re-hash blobs.
  The worker's egress is `local`: Nova talks only to the runtime, which fetches the model from its
  library; nothing of the person's goes with that, so a download runs under local-only too (the
  approval says so). **Disk budget** (`disk_budget_gb`, the same number for each device): refused
  at once when the size is known (the catalogue), else stopped as soon as the layer totals pass it
  ("at least N GB", since Ollama names layers as it goes); nothing is installed. Removal of a model
  that serves a role is refused until another is assigned.
- **One inference API.** `models.infer({role, messages | input, privacy_mode, task_id?, ...})`; a
  caller's mode only tightens the person's. Chat and the M5 `openai-compatible` provider use it
  when the provider is set to a role (`config.role: reasoner`); then the model manager writes each
  call's receipt with where it really went (the registry skips its own; the runner hands over its
  receipt draft, `ownReceipt`), so there is one receipt per call. What the person should know
  (cloud stepped in, possibly less depth, a wake, the hub served a small job) comes back as
  `notes`: a task's summary carries them; chat ends the reply with them in one italic line.
  Placements are Ollama only; OpenAI-compatible servers stay M5's provider without a role.
  Embeddings have no cloud fallback.
- **Fallback chains** exactly as LOCAL-MODELS: local-only is local only (the cloud isn't in the
  chain at all, and the receipt refuses a remote call under local-only behind that); a task waits
  "Waiting on local capacity: …", a `waiting_on_model` note is kept, and the person is told once,
  as a proactive message (triaged, quiet hours kept); a watch (15 s, `NOVA_MODELS_WATCH_MS`) asks
  the role's runtime (never waking a device to find out) and retries the task when it answers.
  local-preferred: local first, then the cloud model, with the note and one problem per fault.
  cloud-allowed: the cloud first, then local with "may be less thorough". **One cloud model**, set
  by the person (`PUT /models/cloud`, a new address needs `confirm: true`); whatever its address it
  counts as remote (a loopback stand-in in tests is named by its name).
- **Budgets** (`per_task_usd`, `per_period_usd`, `period` day/week/month UTC; a brief's
  `max_cost_usd` too) are checked before every cloud call; one call can take a budget past its limit
  by its own cost, no further. A cloud model without a price under a budget isn't used. Usage is
  `cloud_usage`, from every cloud call and every report from a provider whose receipt went remote
  (once per attempt), and a `cloud_usage` note on the task. Over budget: local answers if it can,
  with the reason; otherwise the work waits with it. A remote provider's task waits on the budget
  before it runs.
- **Wake-on-LAN.** A magic packet to the device's broadcast address (from its heartbeat), port 9,
  or the target set (`PUT /models/wake`; tests use a loopback listener). Nova waits as long as the
  last measured wake took, half again plus 2 s; never measured, the setting (120 s) and says it was
  a guess. Small jobs (≤ 2000 characters) go to the hub model while the spoke sleeps. Letting it
  sleep is the device's own policy; Nova asks Ollama to keep a model loaded 5 minutes only.
- **The local Decision Model Provider** (`local-model`, egress local) is asked first once a sorting
  model is assigned; it always asks the inference API as local-only. Answers are typed JSON
  requested with the template's schema (Ollama's structured output) and checked strictly; anything
  out of schema is unused and escalates. The person's hard policy for triage (a category turned off,
  quiet hours for a message) binds it: a contrary answer escalates. With decisions kept on the rules
  (`PUT /models/decisions {use: rules}`) it still answers templates the rules have no rule for, so
  capture's proposals get an answer. Finding against the real Ollama: a thinking model asked for a
  schema spent its reply reasoning and missed it (34 s cold for one decision); Nova now sends
  `think: false` to models that say they think (2.6 s).
- **Not done.** A whisper adapter; downloads through anything but Ollama; a spoke's models are
  read only while it is awake (last seen otherwise); fallback is per call, before output.

**2026-10-30 (M6 review fixes): capture.** Branch `m6-fix/capture`. Tests:
`tests/core/capture-review.test.ts` (the reviewer's probes as real tests), new cases in
`tests/core/capture-rules.test.ts` and `tests/ui/m6a-capture.test.ts`; each failed on the code
before its fix.

- **Private windows (blocker).** `isPrivate` now reads what the source sent, before any clipping
  (a browser puts its marker at the end of a long title, past the 300 characters kept), on both
  ways in (Screenpipe and the device inbox), and checks the address too (`about:privatebrowsing`).
  Markers cover Chrome/Edge/Brave/Opera/Vivaldi/Firefox/Safari wording in English, French,
  German, Spanish, Italian, Portuguese and Dutch (plus a little Polish and Swedish), with accents
  and case folded. It is best effort and says so: real Screenpipe sends no private flag, so the
  posture copy and Settings › Capture say detection is by window title and recommend Screenpipe's
  own ignored-windows setting. A page title that merely mentions "incognito" is dropped too; that
  errs the right way.
- **Backlogs and late items.** Screenpipe answers newest first, so the adapter now reads by
  windows of time, oldest first: a window holding more than 1,000 items is narrowed, then read
  whole, paged until a short page (not by the first total, since new items push older ones later).
  The cursor is the end of the last window read whole (never past it); 60 requests per type per
  pull, and the rest carries on next pull. Each pull asks again from `after − lookback` (5 minutes
  by default, `PATCH /capture/sources/{id} {lookback_minutes}` 1–240, never before consent or
  resume), and the cursor keeps the ids taken within the lookback, so a late, older item arrives
  once. The old cursor shape (`ids`) is still read. Answers over 16 MB are refused.
  Still missed: an item reported later than the lookback, and anything Screenpipe never kept.
- **Exclusions.** A site matches a trailing-dot host, the window title as a host token (not part of
  a longer name), and, for browser apps, the screen text. App names are folded (case, spaces,
  `.exe`/`.app`) and a rule covers word-prefixed editions ("Signal" keeps out "Signal Beta", not
  "Signalling Tool"); signals use the same folding without the prefix. A time window checks the
  event's whole `[at, ended_at]` stretch. Settings says per kind what each keeps out, and that app
  and site exclusions can't stop audio (time windows and spaces do).
- **Who did it.** Promotions and accepted proposals are recorded as the caller, like consent and
  forgetting: `device:<id>`, or `console` for the hub's own screen (was always `person`; consent's
  `by` is now `console` there too). A promoted memory is still confirmed (the caller chose it).
- **Smaller ones.** The indicator says "Capture state unknown" when the hub can't be reached (it
  re-asks when the event stream drops or returns, and on `online`), never hiding while capture
  might be on. A Screenpipe that isn't the hub's (`elsewhere`) makes the indicator say it needs
  you. Paused copy says Screenpipe itself keeps recording. A revoked device's sources go off.
  Accepting a suggestion opens the remember sheet and asks which space (the sheet never fills in
  "personal" for an unclassified event; the API's own default is unchanged). A standby's pages
  reload capture on sync (`capture.synced()` on `applied`). Triage that no provider could answer
  (no rule, no provider) leaves the event waiting instead of marking it looked at, so it is
  triaged once a provider exists. Device times without a zone are refused; a zoneless Screenpipe
  time is read as UTC (Screenpipe keeps UTC).

**2026-10-30 (M6a): capture — the Capture API, consent, storage, classification, promotion, Screenpipe.**
Branch `m6a/capture`; the plan's §1. Code in `src/core/capture/`, migration `0009_capture.sql`
(numbered 0009 alongside M6b's; the integrator renumbers).

- **One API, two adapters.** `capture.stream(device, kind)` (and the views) hands out normalized
  events: timestamps, device, the space and who set it, consent (`granted` at), and provenance
  (adapter, source, the source's own id, how it arrived). Every adapter goes through one `ingest`,
  which is where consent, private contexts, exclusions and classification happen, so no adapter
  can skip them. Screenpipe is pulled over its REST API (`/health`, `/search` for OCR, audio and
  accessibility text) with its own cursor per content type; a device agent sends `capture_event`
  through M4's inbox.
- **Consent.** Every source starts off, per source and per device. A Screenpipe is added off; a
  paired computer's heartbeat capability `capture.<kind>` offers a source, off. Turning one on
  records who and when; capture starts *then*: nothing Screenpipe kept from before consent is
  pulled, unless the person asks for an earlier `since` (never the default). Pausing stops intake,
  and resuming moves every cursor to now, so nothing from the paused stretch arrives later. Events
  timestamped before consent or resume are dropped (counted, not kept).
- **The indicator** is in the top bar on every page while any source is on and not paused; a
  phone's Home, which has no top bar, keeps one for it then (without the small orb). It opens the
  Capture view.
- **Private and incognito** windows are dropped in `ingest` before anything is stored: a source's
  `private`/`incognito` mark, or a window or app titled Incognito, InPrivate, Private Browsing,
  Private Window or "(Private)". Tested with sentinels: nowhere under the home afterwards.
- **Exclusions** per app (name, case-insensitive), site (host and its subdomains, or a window
  title naming it, since screen text often has no address), space (after classification) and time
  window (weekly, in the person's time zone, past midnight allowed); each may be scoped to one
  source. Kept in profile section `capture` (new), written only through `PUT /capture/settings`,
  which checks them.
- **Classification** only by the person's signals: app, device, "calendar" and the explicit
  switch. Nova has no calendar connection yet, so "calendar" is a weekly block of hours the person
  names (their working hours); a calendar connector can feed the same signal later. The switch
  wins while on; otherwise all matching signals must agree on one space, and none or a
  disagreement leaves the event unclassified, never guessed. Folder paths are refused as a signal.
  Resolving an item can also remember its app as a signal.
- **Storage and forgetting.** Captured words live only in `capture_event` (text, app, window
  title, address). Promotion rows, proposals and tombstones carry ids, times and hashes, not words;
  a trigger keeps a hash of its payload; the inbox keeps the key and the event id, never the body.
  Forgetting deletes the row (secure_delete on the connection), truncates the WAL, cleans every
  backup (`backups.forget('capture_event', …)`, which also drops the backup's sync-log entry), and
  leaves a tombstone (hash of the source's own id) so a re-read can't bring it back. The sync log
  carries a content-free delete; a standby applying it cleans its own backups (`SyncLog.forgetting`,
  a small hook next to memory's). All five tables replicate.
- **Capture is evidence, not memory.** Promotion is deliberate: `POST /capture/promote` (the
  person) or accepting a proposal. The memory's provenance is `source: capture:<event ids>`,
  `observed_at` the first event's time, `recorded_by: person`; `capture_promotion` keeps the
  link, the proposal if any, and when and where each event was captured, and outlives the event.
  Forgetting the memory forgets the events it came from (they hold the same words); forgetting an
  event forgets memories made from it unless the person keeps them (`keep_memory`). Retention
  never touches memory.
- **Proposals.** A built-in decision template `capture-promote@1` asks one Noul question
  (`remember`, floor 0.7). Only a confident yes (p > 0.5, not escalated) becomes a proposal, which
  is never a memory until the person accepts. The local rules provider has no rule for it, so
  until a model-backed local provider exists (M6b), nothing is proposed. Note for M6b:
  `Decisions.decide` takes the first allowed provider, and the rules provider answers every
  template (escalating when it has no rule), so a local model provider must come before it, or the
  rules provider must step aside for templates it has no rule for.
- **Retention** is `capture.retention_days` (default 14), swept on the hub's capture pass: deleted
  the way a forget deletes (WAL, backups, standby), without tombstones.
- **Event triggers.** A rule can listen to the connector `capture` with topic `any`,
  `unclassified`, `space:<name>` or a kind. The core wraps `triggers.connectorCheck` for it.
- **Local-only.** A Screenpipe's address decides its egress with M5b's `addressEgress` (loopback,
  private ranges, `.local`, the person's devices). Under local-only, a remote one can't be turned
  on or pointed at, and one already on stops being pulled (status `refused`) without a request,
  if privacy tightens. Redirects are refused.
- **Outages.** A Screenpipe that doesn't answer is status `unreachable` and one problem (not one
  per try), resolved when it answers; the cursor stays, so what Screenpipe kept meanwhile arrives.
  After a failover, a Screenpipe at a loopback address belongs to the device it was set up on: the
  new hub doesn't pull its own loopback in the old hub's name (status `elsewhere`).
- **The service worker** never caches `/api/v1/capture` (a forgotten event must not survive in a
  cache); its cache is `nova-shell-v6`.
- **Test clock.** Under `NOVA_TEST_CLOCK=1`, `POST /api/v1/capture/tick {now}` runs one pass
  (pull, retention, triage) and capture keeps that time as now from then on (consent, resume and
  retention use it), so the gate can run a day in minutes with the stand-in's timestamps.
- **Device agents.** `capture_event` joins the inbox kinds (device_inbox is rebuilt in 0009 to
  widen its CHECK, rows and sync triggers as 0007 made them) and the device queue's kinds
  (`boot.ts queue capture_event '<json>'`). The runtime agent can't read the active window: it
  runs under Node's permission model with no child processes or addons, and every OS needs either
  a native call or a permission for it. Desktop app activity is therefore a later native
  component (ADR-2); the inbox path and a heartbeat capability are ready for it.
- **Platform posture** is said plainly in setup's closing line and in Settings › Capture
  (desktop deep under OS permissions; Android with accessibility and notification access, not
  built; iOS no passive capture of other apps).
- **Not done, and why.** An item Screenpipe reports later with a timestamp older than the cursor
  is missed (Screenpipe's timestamps are monotonic in practice; reading by id would need its
  database). More than 5,000 new items of one type per pull wait for the next pull. Meetings,
  browser and sensor kinds exist in the API, with no adapter yet. Proposals for classification
  (a decision proposing a space) are not built; the person resolves unclassified items.
- **For the owner to check by hand:** a real Screenpipe on this machine (its `/search` paging and
  `start_time` inclusivity are as its docs describe; the stand-in, `scripts/fake-screenpipe.js`,
  follows them).

**2026-10-30 (M5 review fixes): providers, vault, connectors.** Branch `m5-fix/providers-vault`.

- **What a provider may change.** A brief's `inputs.editable` (paths or globs in the workspace)
  is the list; without it, everything the brief's refs cover except tests (`*.test.*`,
  `*.spec.*`, `*_test.*`, `test_*.*`, `tests/`, `test/`, `__tests__/`, `spec/`, `conftest.py`),
  test-runner settings (jest/vitest/playwright/karma/cypress/ava configs, `.mocharc*`,
  `pytest.ini`, `tox.ini`), every word of the test command taken as a path (so a script it names
  counts, even one the provider added), and the files the command's program reads its scripts
  from (`package.json` for npm/node and kin, `Makefile` for make, `setup.cfg`/`pyproject.toml`
  for pytest). A named folder protects only the tests in it, or nothing would be left to fix. Any
  change outside the list refuses the work whole (failed, not retried: a provider that touched
  its checks doesn't get two more goes).
- **No approval when a task is made; one after the provider finishes.** The creation-time tier 2
  (`minTier`) was approving code that didn't exist yet, so the provider worker no longer sets it.
  When the provider changed anything, Nova always asks before running the test (the task waits
  as *partial*, with the diff), whatever `task_tests` says; `allow` still covers a run on files
  nobody changed. The OK re-queues the task through `ledger.retry`, and the next run sees the
  approved question and runs only the test, on the folder's hash as shown. No ledger change was
  needed. A plain "Try again" without the OK starts the provider afresh. Each retry after a
  failed verification runs the provider again and asks again: that is the ledger's existing
  retry, and each ask is about new code.
- **Process groups.** Every command Nova starts for a provider or a test has its whole process
  group killed when it exits. A process that leaves the group on purpose (`setsid`, a double
  fork into a new session) escapes; containing that needs namespaces or a cgroup, which Nova
  doesn't set up. The test run's environment is PATH (with Nova's node first), a temp HOME and
  TMPDIR, and LANG/LC_ALL only; it still runs as the person, with their files in reach, which
  the approval says in those words.
- **Claude Code's flags.** `--setting-sources project` and `--safe-mode` are as `claude --help`
  2.1.259 describes them; no real session was run, so it is unverified that an older CLI accepts
  them (one that doesn't fails the task with its own message). Project settings are Nova's home's
  (the git root above the task folder), which has no `.claude/`.
- **Vault re-key on delete.** Every delete (and `deletePrefix`) makes a new key and re-encrypts;
  the standby is unaffected because the key travels at serve time with the current file. The new
  file is written beside the old, then the key stored, then the file swapped in; an interrupted
  re-key is finished on the next open. A lost vault (no key that fits, a damaged file) is set
  aside as `secrets.json.unopenable-<time>` on the next save; one whose key may be in a keychain
  that isn't answering is not, and `POST /vault/reset` (tier 3) does it on purpose.
- **Not done, and why.** Asking Ollama's `/api/show` whether a model is remote: a call per check,
  for what the `*-cloud` / `*:cloud` naming already tells. Home Assistant's WebSocket isn't given
  `redirect: 'error'` (WebSocket handshakes don't follow redirects). A bare-name Home Assistant
  is resolved once, when connected; if the name later moves off the network, Nova keeps counting
  it local until it is connected again.

**2026-10-30 (M5 review fixes): browser work, and work with outside effects.** Branch
`m5-fix/browser-effects`.

- **A browser task never reaches Nova itself.** Its browser runs on the hub, so loopback from it
  was the console. Two walls, each enough alone: the plan can't name Nova's listeners (console and
  mesh ports, on a loopback name or one of this machine's addresses, or a name resolving here),
  and the session's interception refuses them whatever the declared hosts say; and every request
  the browser lets through carries `x-nova-browser-task`, set at the CDP layer, which makes it
  public to the access policy (not a device either). This machine without a port can't be
  declared at all: Chromium sends a declared host's WebSockets straight there, past interception,
  and a WebSocket handshake is never the console. Nova's ports reach the core as `hubPorts`.
- **Workers say what a brief may change outside (`effects`: none, idempotent, external).** For
  external work, a failure after dispatch (evidence that didn't hold up, a throw, an unreadable
  report, a time-out, a restart) leaves the task waiting, Needs you: "May already have happened:
  <why>. Check, then retry or cancel." Only `retry()` runs it again, and it clears the approval of
  a tier-2 or tier-3 task first. Browser: external with fill/select/click/person steps; Home
  Assistant service calls: external; n8n: idempotent only with its "Safe to send twice" setting
  (`idempotent: true`); the providers that work in the task's folder: none. A plan may flag the
  step that commits its effect (`commits: true`): `commit_point` is written before it runs (and
  when someone takes over), and a failure before that point may still rerun by itself; each such
  decision is a `rerun_decision` event.
- **Browser plans:** fill/select/click asks first (tier 2). A `url` requirement needs
  `verify.expect`; a plan with outside effects needs `url` evidence on a page it names
  (`verify.url`), and the checker judges by Nova's own re-fetch whenever there is one. Only
  addresses count as local (not `.local` or `.home.arpa` names). The worker re-checks a takeover
  right before each acting CDP call; a revoked device, or one that may no longer approve, loses
  the browser at once; left-behind profiles are removed at start (each names its process); and
  Chromium resolves only the declared names (`--host-resolver-rules`).
- **Not done, and why.** A name that resolves to a private address at check time doesn't count as
  local (no lookup at delegation; it would need pinning in Chromium to mean anything). Pages may
  still open WebSockets to a declared host:port directly (the proxy bypass), as before; only
  Nova's own ports are now out of reach that way.

**2026-10-30 (M5b): the vault, the connector kind, Home Assistant, Gmail as a connector.** Branch
`m5b/connectors`; the plan's §2 has the "as built" note.

- **One vault file, the key elsewhere.** `home/vault/secrets.json` (0600) is AES-256-GCM over the
  whole name → value map, the vault id as associated data (a vault can't be passed off as another).
  The key is in the OS keychain when one answers, else `home/vault/key` (0600) and the person is
  told, in Settings › Connections and health, that the key sits next to the vault. A file key
  moves into a keychain once one answers (written, read back, then deleted). Era 1 encrypted with
  ChaCha20-Poly1305 and kept the secrets themselves in the keychain; the plan says AES-256-GCM and
  "the key held by the keychain", so only the key goes there, which also makes the standby simple.
  The Windows backend (Credential Locker through PowerShell) is written and its command shape
  tested, but has not run on Windows. Tests never reach a real keychain: `auto` means `file`
  under the test runner, test servers set `NOVA_VAULT_KEY=file`, and the real `secret-tool` is
  tried only where it exists, with a throwaway account it removes.
- **Redaction is by value**, not only by key name: every value the vault reads or writes (8
  characters or more, and each field of a JSON value) is replaced in log lines, problems (stored
  and replicated) and receipts.
- **The standby gets the vault sealed.** `vault/` isn't journalled. The hub's sync log carries
  one `vault` entry, the ciphertext, and adds the key only while serving a batch, inside the
  batch already sealed to the standby's X25519 key; the standby stores the entry without it and
  puts the key in its own key store. No sync log on either node holds the key (tested in-process
  and with two real processes and a failover). This closes M4's note that connectors had to be
  reconnected after a failover. Known gap: a database backup taken before a secret was revoked
  still holds the old ciphertext, which the same key opens; the revoked token is revoked at the
  service where the service allows it.
- **A built-in connector is in the extension host only while it is connected.** The host lists
  what the person chose (the fresh-user check that it starts empty still holds); connecting is the
  OK on the permissions the Connections page shows; Disconnect removes the record and its data
  folder. Disconnect is full revocation: sign out at the service where it can, then delete its
  secrets, the rules listening to it and its settings. `DELETE /extensions/{id}` does the same
  through a new kind hook, `revoke`, which runs before the data folder goes. Era 2's own Gmail
  disconnect on the Skills page is unchanged (it keeps the OAuth client).
- **Connector events fire only for what a rule listens to.** An event rule names
  `{connector, topic}` (source `connector:<id>/<topic>`, no webhook token); a Home Assistant state
  change or new Gmail becomes a trigger record only when a rule listens for that entity or for
  `inbox`. A record per state change would flood the trigger table, which replicates. One rule
  per entity (the existing unique source index for event rules).
- **Home Assistant service calls are ledger tasks.** The tier comes from the domain (2, or 3 for
  marked domains; locks and alarms marked to start, a recommendation the person can undo with a
  confirmation), and the worker refuses a brief below it, so a task can't lower its own gate. The
  evidence is a `confirmation` that Nova's own read-back of the entity backs (a sync checker, so
  the worker takes the reading and the checker accepts only readings Nova took). Local-only never
  contacts a Home Assistant at a remote address: reads are refused in plain words, live events
  stay off, and the ledger refuses the task. Egress is decided from the address as written
  (loopback, private ranges, `.local`/`.lan`/`.home.arpa`/`.internal`, single-label names and
  mesh device hosts are local). Worker egress stays `local | remote`; M5a's `remote:<host>`
  form can replace it at integration.
- **Gmail's mail events are a poll** (every 5 minutes, only while a rule listens and the privacy
  setting allows it); the first look only learns what is already there.
- **Gmail tests.** Two assertions checked plaintext files in `connectors/gmail/` with mode 0600;
  they now check the vault (0600, encrypted, no plaintext file). Behaviour is unchanged.
- **Also:** the file tools refuse `vault/` as they refuse `connectors/`; approved `exec` runs as
  the person and can still read `vault/key` where there is no keychain. The service worker never
  caches `/api/v1/connectors` or `/api/v1/vault`; its cache name is now `nova-shell-v5` (after M5c's v4).
- **Providers' secrets come from the vault** (after merging M5a): `secret://NAME` in a provider's settings is the vault's `provider/NAME`, set with `PUT /api/v1/vault/NAME`. M5a's `NOVA_SECRET_<NAME>` environment variables stay only as a development and test fallback: the vault wins, and a value from them is redacted like a vault value. There is no PWA field for entering a provider's secret yet; the API sets it.
- **For the owner to check by hand:** a real Home Assistant (connect, a light on and off, a
  door sensor rule, Disconnect deleting the token there), and the vault's key in the keychain on a
  desktop with one.

**2026-10-30 (M5a): the provider registry and agent/automation adapters.** Branch
`m5a/providers`; the plan's §1 "as built" note has the details and the gate's interfaces.

- **Providers are extensions** (agent-adapter, automation-adapter) whose `adapter` block picks
  one of five built-in implementations (`claude-code`, `codex`, `openai-compatible`, `custom-cli`,
  `n8n`); no extension code runs. Each enabled one is a ledger worker in its own lane, gated by its
  egress (an HTTP provider's address decides: loopback or a mesh device is local), with a context
  receipt per call. Enabling is tier 2 (the permissions OK).
- **Nova verifies, not the provider:** each coding or chat task works in `workspace/tasks/<id>/`;
  Nova computes the diff against a baseline kept outside the workspace, runs the brief's declared
  test command itself (tier 2 unless policy allows, tier 3 to allow), and copies results back only
  once the task is done. A provider that says it succeeded when it didn't ends failed with the
  verifier's reason (tested with lying stand-ins).
- **Chat goes through the registry.** `agent_cmd` is the `custom-cli` provider and stays the
  default, run by Era 2's runner unchanged; a chosen chat model (the Ollama profile by default)
  carries its own egress into privacy checks and receipts.
- **n8n both ways**, signed with HMAC-SHA256: out to the workflow webhook, back through M2's token
  webhook carrying a confirmation that Nova checks against the signed callback it kept.
- **Secrets by name only** (`secret://NAME`), resolved through `CoreOptions.secrets`; until the vault
  (M5b) plugs in, the server reads `NOVA_SECRET_<NAME>`.
- **Core hooks added:** `minTier` on a laned worker, `ledger.note` and `verifier.registerKind`
  (shared with M5c), the profile's `providers` section.

**2026-10-30 (M5c): browser work with human takeover.** Branch `m5c/takeover`; the plan's §3
"as built" note has the details and the gate's interfaces.

- **Nova drives Chromium itself over CDP** (`src/core/browser/`), through `--remote-debugging-pipe`:
  no port is opened, so nothing else on the machine can attach to the browser, and there is no
  runtime dependency. Playwright stays a dev dependency, used only by the tests.
- **Declared hosts are enforced twice:** CDP Fetch holds every request of every target (pages,
  popups, iframes, workers), and a local refusing proxy catches what Fetch can't see
  (WebSockets). Every refusal is in the task's record. Chromium's own calls home reach that proxy
  and are refused too.
- **The ledger learned to wait for a person mid-run**: `needsPerson`/`personDone` (active ⇄
  waiting while the worker runs) and `note`. A worker's egress may depend on its brief
  (`egressFor`), so a browser task on this machine or a private address counts as local.
- **Evidence Nova checks itself:** a screenshot its own browser took into the task's folder
  (`workers/browser/<task>/`, untracked), and the final page read afresh, re-fetched inside the
  declared hosts or read from the final DOM. `screenshot` and `url` checkers are registered with
  the verifier (`registerKind`).
- **Takeover** is for the console and approver devices only. Frames and screenshots live under
  `/api/v1/browser`, which the service worker never caches.

**2026-10-30 (M4, re-check of the blocker fixes): three more ways out of the runtime's sandbox,
closed; key replacement made safe.**

- **Process signals:** the runtime could still signal any process of the person's through the raw
  binding under `process.kill` (`process._kill`). `process._debugProcess` sends any process the
  signal that opens its inspector (the boot agent, the Nova server, editors). Both are locked in the
  runtime's preload, with `_debugEnd`, `chdir` and `abort`. The boot agent is started with
  `--disable-sigusr1` as well, so nothing else can open its inspector by signal.
- **IPC messages:** the boot agent took `process.send(null)` from the runtime as an unhandled
  rejection, which ends it. It now drops anything that isn't a message it knows, and says so if
  handling one fails.
- **Key replacement:** `scripts/rotate-hub-keys.js` refuses while a Nova server runs the home. The
  server writes `nova.pid` at start and removes it on a clean stop; a stale one is ignored. The
  "keys in history" warning closes by itself once the current keys are no longer in the history.
- Each has a test that fails on the code before it: the sandbox probe signals a bystander process,
  a runtime sends junk over IPC, and the key replacement is run against a home with a live pid.

**2026-10-30 (M4 review): the device agent's sandbox, and failover.** Fixes
from the M4 review, branch `m4-fix/agent-failover`; each has a test that
failed before the fix.

- **The runtime's sandbox had holes (ADR-3).** Tried by hand on Node 26.3.1
  under the runtime's flags: `node:sqlite` ignores the permission model (it
  opened, ATTACHed and VACUUMed INTO any path); with `--allow-net`, unix
  sockets anywhere (an SSH agent, a container daemon) and loopback services
  were reachable; `process.report` (signal and uncaught-exception reports)
  wrote into any folder (Node checks only the working folder);
  `v8.setFlagsFromString('--trace-turbo-path=…')` and
  `--redirect-code-traces-to` wrote files anywhere; trace-event files landed
  in the folder it was started from. Already refused by `--permission`: WASI,
  the inspector, `process.binding`, child processes, `execve`, workers,
  addons, links and renames out of `state/`, `loadEnvFile`, `chdir` out;
  `localStorage` has no file. Now: no `--allow-net` (the boot agent makes the
  runtime's two hub calls, heartbeat and inbox, over IPC with its own session,
  refusing any other path and anything over 900 kB; the runtime no longer
  holds a session token either), `--no-experimental-sqlite`,
  `--no-experimental-webstorage`, diagnostics and trace files pinned to
  `state/`, `--disable-sigusr1`, started in `state/`, and a preload that
  replaces `process.report`, `process.kill` and `v8.setFlagsFromString`
  (non-configurable, so they can't be had back). `tests/core/device-sandbox.test.ts`
  runs every route above under the exact flags.
- **The offline queue is JSON files** (`state/queue/{pending,done,tmp}/`,
  one file per item, named by its key), not SQLite: written whole to `tmp/`,
  then hard-linked into `pending/` (which also refuses a key already there);
  answered by writing `done/` and then removing it from `pending/`. Order is a
  sequence stamped at add time. Node's permission model refuses `fsync`, so
  only the boot agent's `queue` command (outside the sandbox) flushes what it
  adds; an answer the runtime records and a power cut loses is sent again, and
  the hub answers it as a duplicate (exactly once still holds). The newest
  1,000 answers are kept. No migration from `queue.db`: M4 hasn't shipped.
- **Who can make a hub step down.** Only its current standby (`standby_id`)
  or, for a node that was itself a standby, the hub its role file names, and
  only with a roster signed by that device's registered key at a higher
  epoch. Any other trusted device making that claim is a problem ("isn't
  this hub's standby … revoke it"), once per claim. Approving a new standby
  turns any earlier one still in the registry into a `spoke` with no
  address, so devices don't look for the hub there and fencing doesn't ask it.
- **Automatic failover counts only silence.** The standby counted any
  non-200 answer, and a batch it couldn't apply, as "unreachable", so a live
  hub answering 500s or sending a newer schema was taken over after
  `auto_failover_after_s`. Now only transport failures (refused, reset, timed
  out) count; any answer is a problem for the person ("The standby can't copy
  the hub: …") and resets the count. Before promoting itself, the standby also
  asks the hub's `/mesh/hello`; any answer there starts the count again.
  Trade-off: a dead hub behind a proxy that answers 502 isn't taken over
  automatically; the person promotes by hand.
- **A hub that steps down owns up to what it never copied.** On demotion it
  counts its sync-log entries past the standby's last ack and says so ("N
  changes made here were never copied to … they are only on this node").
  Forgets among them (memory `delete` entries) can't be left behind (order
  4): their ids, never the words, go to `mesh/owed-forgets.json` (local, not
  journalled), and the node signs in to the new hub with its own identity
  key (its old record there: a trusted computer) and calls the new route
  `POST /mesh/forgotten {ids}` (`access: 'device'`), at once and every 30 s
  until it lands, also after restarts. The new hub takes it only from a
  device named `previous_hub` in one of its "Standby promoted to hub" ledger
  tasks (any other computer gets 403), forgets each memory the whole way
  (`device:<id>` as who), and says so as a problem. A refusal is a problem on
  the old node naming the memory ids to forget by hand; it keeps trying. Other
  uncopied changes are reported, not carried over (still the documented gap:
  enroll the old node again).
- **A big item can't jam the queue.** The runtime sent the oldest 50 items in
  one call whatever their size; past the hub's 1 MB body limit every flush
  failed and nothing behind it moved. Now an item over 256 kB is refused when
  queued ("too big to queue … put large content in a file"), a flush packs
  items up to 768 kB a call, and an item that can never fit (queued by an
  older agent) is answered here as refused ("too big to send … never sent",
  marked `local`) so the rest flows.
- **No runtime downgrades.** The runtime manifest now carries `epoch` and
  `issued_at`, signed with the rest (a node signs its bundle again when its
  epoch changes). The boot agent refuses a validly signed bundle that orders
  before the hub-signed one installed (lower epoch, or same epoch and signed
  earlier), and reports it like any refused update. A manifest without them
  counts as oldest. A promoted standby's clock doesn't matter: its epoch is
  higher.
- **Nested transactions are savepoints.** `db.tx` inside `db.tx` used to join
  the outer transaction, so an inbox task request that failed after its task
  was written was recorded "refused" while the task was committed too. A
  nested call is now `SAVEPOINT … RELEASE`, rolled back to on a throw; the
  outer one commits or rolls back as before. The inbox runs each item's effect
  in its own savepoint.
- **join.sh: the archive's hash, and trust on first use, said plainly.** The
  served `join.sh` names the SHA-256 of the `device-agent.tar` the hub serves
  and refuses (installs and runs nothing) a download that doesn't match, or a
  computer with no `sha256sum`, `shasum` or `openssl` to check it. That
  catches a damaged or swapped archive, not a hostile hub address: script and
  archive come over the same channel, and no fingerprint can be checked in
  `sh` before the agent runs (the six digits prove the hub only afterwards).
  So the command is trust on first use, and the Add a device sheet now says
  so: "The command installs whatever <hub> sends. Run it only where that
  address can only be this Nova: over HTTPS the computer trusts, or on a
  network you control." Also: `--kind=standby` is recognised like
  `--kind standby`, so a standby is never started as a computer agent.
- **A file that outgrows the journal is dropped on the standby.** A
  journalled file that grew past 8 MB stayed on the standby as its last small
  version, with no delete. Now it gets a `file_delete` entry when it crosses
  the limit, and the problem says the standby's older copy was removed and
  that the file wouldn't be on a new hub. Shrinking back copies it again.
- **The mesh listener takes port 0** (`NOVA_MESH_URL=http://127.0.0.1:0`):
  it binds a free port, fills it into the public address the core hands out
  (roster, `join.sh`, pairing links) and says so in its "Devices pair and
  connect at <url>" line; it exits plainly if it can't bind. The two-process
  tests start the hub that way and wait for that line, not just "Nova is
  ready" (the mesh listener binds after the console one, which was the flaky
  `ECONNREFUSED`). A standby's address is in the roster before it starts, so
  its port is still chosen ahead, now from 20000–31999, below the ephemeral
  ranges that port-0 servers and outgoing connections use.

**2026-10-30 (M4 review): trust, pairing and access fixes.**

- **The hub's private keys were committed to the home's git history.**
  `src/home.js`'s `UNTRACKED` lacked `mesh/`, so the first `git add -A`
  committed `mesh/identity.json` (both private keys) and `mesh/role.json` as
  blobs anyone who can read the home can read. `mesh/` is untracked now, and
  `ensureGit` stops tracking it on every start where it is still tracked. A
  home whose history (any ref or the reflog) holds the *current* private key
  gets a problem in plain words at every start until the keys are replaced.
  **Rotation:** `node scripts/rotate-hub-keys.js <home>` with Nova stopped
  (`rotateHubKeys` in the core): new keys under the same id, epoch + 1, and
  every computer and the standby revoked, because they pinned the old key and
  would follow a roster signed with it; phones and browsers keep their
  sessions (they never take a roster on trust after pairing). The old blobs
  stay in history, harmless once nothing trusts them; Nova doesn't rewrite the
  person's history. The secret-scan test now also reads every git object.
  Every M4 home made before this fix should be treated as exposed.
- **What a computer may read** through `GET /mesh/config/{section}/{key}` is
  what it may change: `DEVICE_CONFIG_SECTIONS` and the inbox's key pattern.
  Setup (the transcript), privacy, appearance and mesh are a 403.
- **`mesh.auto_failover_after_s` is the approvers' and tier 3.** It decides
  which machine becomes hub, like promotion, so a phone without `can_approve`
  gets a 403 and every change needs `confirm: true`. The PWA has no control
  for it yet.
- **A malformed or `null` Origin is a 403** (`originHost` in `api.ts`, and
  Era 2's `api()`). It was a thrown `TypeError`: a 500 and a problem per
  request, reachable without a session through the public enrollment routes
  before their rate limit.
- **Rate limits.** An IPv6 client is limited by its /64 (`rateKey`), since a
  phone or a home network can pick a new address per call. Wrong codes are
  also capped for the whole hub (50 in five minutes from every address
  together; a right code still works), with one problem. Refusal reports are
  forgotten after ten minutes, so many addresses can't grow that map. Behind
  `NOVA_MESH_TRANSPORT=proxy` the client address is the last
  `X-Forwarded-For` entry: **the proxy must append to that header or replace
  it** (README); one that passes the client's header through lets a client
  choose its own limit. Nova can't tell which kind it is behind.
- **Webhooks are public, as this ledger already said.** `POST /hooks/{name}`
  now carries `access: 'public'`; it was `person` by default, so an
  automation calling the mesh address got a 401. Its token is still checked.
- **Device sessions count only on the mesh listener.** With `NOVA_HOST`
  beyond loopback, the console port took a device's cookie or bearer token
  over plain HTTP, a transport §0 doesn't accept. There it is now public, like
  any unpaired caller.
- **A spent session signature stays spent across a restart.** Migration
  `0008_session_signature.sql` keeps `(device, signed time)` for each session
  started, until the time is too old to be fresh (two minutes), instead of an
  in-memory map a restart emptied. The same exact-match rule as before (not
  "strictly newer"), so two tabs signing out of order aren't refused, and a
  refusal stays a 401. Never replicated. If another branch also adds an
  `0008`, renumber one of them: migrations must have no gaps or repeats.
- **A revoked phone keeps no cached answers.** `forget()` in
  `ui/js/device-key.js` (what `/pair` calls when the hub refuses the key) now
  also deletes every service-worker cache: the shell and the `/api/v1/*`
  answers kept for offline use. Memory, receipts, health and the mesh were
  already never cached.
- **Console residual (not new, not fixed): a silent forwarder is the
  console.** The console test is a loopback socket, a loopback `Host` and no
  forwarding headers. Anything on the hub that passes TCP or HTTP to the
  console port without adding those headers (`ssh -L/-R`, `socat`, a tunnel,
  a proxy that rewrites `Host` to `localhost`) gives whoever reaches it full
  control. Now said in the README (a boxed warning) and in the startup log at
  every start. **Proposed mitigation, not built** (each changes how the
  person opens Nova, so it is the owner's call): a per-start console key, as
  Jupyter does. `npm start` prints `http://localhost:4317/#k=<key>` once; the
  page trades the key for an HttpOnly, SameSite=Strict cookie bound to the
  console port; the console test then also needs that cookie. A forwarder
  passes the cookie only from a browser that already has it, so a stranger at
  the far end gets nothing. Cost: the first open after each start (or each
  key rotation) needs the printed link, and `npm run shots`, the UI gate and
  scripts would read the key from the home (0600). A cheaper half-measure,
  refusing a `Host` whose port isn't the console's own, stops only forwarders
  that keep the client's `Host`, and those already fail the loopback-`Host`
  test.

**2026-10-29 (M4c): hub, standby and sync; promotion and fencing.** Plan §3.
`src/core/mesh/{sync,replica,promote}.ts`, migrations `0006_sync.sql` and
`0007_device_inbox.sql`.

- **The sync log** is filled by SQLite triggers on every replicated table, with
  the whole row as JSON, and keeps **one entry per row** (the newest): a
  standby that is behind can't miss a change, one that starts from nothing
  reads the state once, and an old entry can't keep a forgotten memory's words.
  The migration backfills what was there before. `hlc` is wall-clock ms, a
  counter from the log's sequence, and the node (SQL can't run the HLC class;
  order is `seq`). A hub records (`sync_state.logging = 1`); a standby copies
  the hub's entries with the hub's `seq` instead, so after promotion it serves
  a new standby the same way.
- **Replicated, beyond the plan's list:** `memory_event` (memory's history),
  `decision_template` and its history, `trigger_rule_event`, and
  `device_inbox` (M4b's table, now migration 0007 with `device_heartbeat`,
  which stays local) so a computer's queued items are taken in exactly once on
  whichever node is hub. Never: `device_session`, `pairing`, `join_request`,
  `mesh_state`, `sync_state`, `sync_log`, `schema_migrations`, identity files.
- **Home files** are journalled by a scan every 3 s and soon after a change
  (`fs.watch`), as `file_put` (text, or base64 for binary; up to 8 MB, a
  bigger file is a problem) and `file_delete`. **Deviation:** the plan says
  "everything outside UNTRACKED" but names `MEMORY.md` and `skills/`, which
  are in UNTRACKED (that list is about git history). What stays local:
  `nova.db*`, `logs/`, `backups/`, `exports/`, `kept/`, `workers/`,
  `connectors/` (connector secrets; reconnect after a failover), `mesh/`, and
  the home's git folder. The standby applies files with a hash check and
  refuses paths outside the home or into those folders.
- **Forgetting holds (order 4).** After a forget, once MEMORY.md and the day
  notes are rewritten, the hub rescans, so their old entries are replaced;
  anything in memory's entries or those files still carrying the words is
  removed, and the write-ahead log is folded in. The delete itself is an entry;
  the standby applies it through `Memory.forgottenElsewhere`, which does what
  a forget does there (WAL, backups, Era 2's files, its own log). Backups lose
  the log's entries too. Tests scan the standby's whole home (database, WAL,
  a backup taken while it held the memory, files) for the words, in-process
  and with two real processes.
- **Standby.** Reads its place from `mesh/role.json` (M4b's shape; a hand
  shape is tolerated; unknown fields kept on rewrite) and takes its registry id
  as its identity id. Runs no scheduler, heartbeat, workers or chat; Era 2's
  MEMORY.md import is off (`readOnly`). Every non-GET except `POST
  /mesh/promote` is 409 `This is the standby; “Hub” at <url> is the hub.` (Era
  2's routes too; a computer's agent moves on from a 409). Its own problems
  take ids below zero, so the hub's copies never overwrite them. It pulls
  `GET /mesh/sync?after=&wait=` (long poll, `access: 'sync'`, only the current
  standby), sealed to its X25519 key with AAD `nova-sync-v1|<standby>|<after>`,
  applies each batch in one transaction with foreign keys off (entries arrive
  newest-per-row, so a child can come before its parent), and acks.
- **Lag** is entries not acknowledged, and seconds since the last ack (or the
  approval) while there are some; over 60 s is "behind", one problem per
  episode. Measured from acks, not entry times: the triggers' clock is
  SQLite's, which tests can't move.
- **Promotion** checks that its own key is the one in the registry (the one
  devices pinned), then: epoch + 1, role hub, the old hub's record becomes a
  `spoke` (still trusted: it is the person's computer), signs the roster,
  rewrites role.json, starts the journal, fencing, the heartbeat and Era 2's
  scheduler, recovers the ledger, and records "Standby promoted to hub" on a
  `mesh` worker in its own lane, verified by a `nova-mesh` confirmation
  checker that reads the mesh state and the roster's signature itself. A hub
  that stepped down can't be promoted (it stopped copying). M4b's device
  routes are in the same route table, so the promoted node serves computers.
- **Fencing** at startup (before any work starts) and every 30 s: peers are
  trusted devices with an `address` and role.json's hub. `/mesh/hello` now
  carries the signed roster; a peer counts only if its roster is signed by the
  key this hub has for it, at a higher epoch, naming it hub. A forged higher
  epoch is a problem, not a demotion (tested). Stepping down ends every device
  session and open stream. **Gap:** a node that stepped down doesn't copy the
  new hub (its data diverged after the last sync); enroll it again.
- **Automatic failover:** `mesh.auto_failover_after_s` (a new profile section
  `mesh` with that one key, validated; the blank-profile tests now include
  `mesh: {}`), off by default, counted in wall time. A standby cut off from a
  healthy hub would promote itself too: that is the risk of turning it on, and
  fencing settles it when they see each other again.
- **PWA:** the banner on every page of a standby, with "Make this the hub"
  (tier-3 sheet) on its own screen; Health's Devices check shows the standby
  and its lag (hub) or the hub and the last copy (standby); the registry shows
  roles, and a standby shows it without add or revoke.

**2026-10-29 (M4b): the computer device agent, the one-line command, the
offline queue.** Plan §2. `src/device/`, `src/core/mesh/{spokes,agent}.ts`.

- **TypeScript on Node, not a port of Era 1's `novad`.** Evidence: no Rust
  toolchain here (`cargo`, `rustc` not found); Node 26's permission model
  enforces ADR-3's rule that the runtime can't touch the boot agent, and a test
  proves it (writing `boot/`, replacing or reading `boot/keys.json`, writing
  `runtime/`, spawning a process and starting a worker all fail with
  `ERR_ACCESS_DENIED`, using the exact flags the boot agent starts the runtime
  with); `novad`'s supervisor (`6e2cf142` `services/novad/src/supervisor.rs`:
  backoff, disable after repeated crashes) and signed updates (`update.rs`:
  verify, stage, swap) are the reference.
- **Two agents.** `boot.ts` holds `boot/keys.json` (0600, folder 0700), joins,
  pins the roster, signs sessions, runs the runtime under a watchdog and
  installs runtime updates. `runtime.ts` (with `queue.ts`) heartbeats and
  flushes the queue; it is started as
  `node --permission --allow-fs-read=runtime/ --allow-fs-read=state/
  --allow-fs-write=state/ --allow-net`, with an empty environment, and gets
  its session token (and the hub's CA, when there is one) over IPC.
  `--allow-net` is needed because Node 26's permission model also gates the
  network.
- **The agent ships alone.** `src/device` imports only `src/core/mesh/wire.ts`
  from the core (a narrow, tested exception to "only `index.ts`"), so
  `/device-agent.tar` is `src/device/**`, `wire.ts` and a package.json. The tar
  is a hand-written ustar (no dependency), checked with the system `tar`.
- **Who a device trusts.** Additions to `wire.ts`: `helloProofMessage` and the
  runtime manifest. A node answers `GET /mesh/hello/proof?challenge=` with its
  key; the agent signs a session request only for a node whose key it pinned,
  that says it is hub, at an epoch ≥ the one it knows (so a stranger at the
  hub's address never gets a usable signature), then takes its roster only if
  a pinned key signed it, its epoch is ≥ known and it names that node as hub.
  Lower epochs are never accepted. Tested with stand-in nodes and rosters the
  test signs (promotion itself is M4c).
- **Runtime updates.** `GET /mesh/runtime` is `{manifest: {version, sha256,
  files}, signature, signer, files}`, signed over `nova-runtime-v1.<manifest>`
  by the node's identity key; version is `<nova version>+<12 hex of sha256>`.
  The boot agent checks the signer is pinned, the signature, every file's hash
  and that the files are exactly the manifest's, then swaps `runtime/` by
  rename. A refusal is printed, kept in `boot/state.json`, and reported
  (`POST /mesh/devices/me/report` → a problem, once per ten minutes). The
  installed runtime is re-hashed before every start. With no hub reachable on
  first run, it installs the runtime from its own folder (`local+…`) and swaps
  in the hub's signed one when it can.
- **Watchdog.** Restarts after 1 s, 2 s, 4 s… (cap 30 s); three crashes within
  60 s is safe mode: the runtime stays down, kept across restarts of the boot
  agent; the boot agent heartbeats `safe_mode: true` (a problem on the hub, and
  the registry row says so); a new signed runtime or `recover` ends it.
- **Inbox** (`POST /mesh/inbox`, up to 100 items, in order). Each item is taken
  in with its (device, key) row in the same transaction, so a key is answered
  once and a repeat gets the same answer marked `duplicate`. `task_request` →
  a ledger task (origin `{kind: 'device'}`, idempotency key
  `device:<id>:<key>`) or a refusal kept with its reason and the request, plus
  a problem. `memory_note` → memory with `recorded_by: device:<id>`
  (`memory.ts` accepts that form now), unreviewed; the inbox keeps only the
  memory's id, never its words, so forgetting stays complete. `config_change`
  → identity, user, tuning and policy only (privacy, appearance and setup stay
  with the person's own screens); its `base_version` must equal the setting's
  current version (`GET /mesh/config/{section}/{key}`), else it is rejected,
  reported to the device and recorded as a problem: the hub's value stands.
  `event` → kept and sent on the stream as `device_event`. The device drops an
  item's body once the hub has answered it.
- **Additions to the plan's routes:** `GET /mesh/hello/proof`,
  `POST /mesh/devices/me/report`, `GET /mesh/config/{section}/{key}`,
  `GET /mesh/inbox/refusals` (person). Device views carry `agent: {version,
  runtime_version, safe_mode, at}` for computers.
- **Deviation: no numbered migration.** `device_inbox` and `device_heartbeat`
  are created by `mesh/spokes.ts` with `CREATE TABLE IF NOT EXISTS`.
  Migrations must be numbered without gaps, and 0006 belongs to M4c's sync,
  written in parallel; numbering this 0007 would fail to load until 0006
  exists. Both tables are new, so there is nothing to back up or convert. Once
  M4b and M4c are both merged, this can become migration 0007 if wanted.
- **TLS:** the system's trust, or `NOVA_CA_FILE` (copied into `boot/ca.pem` at
  join; curl in `join.sh` uses `--cacert`). The one-line command's first curl
  needs the CA too, through curl's own `CURL_CA_BUNDLE`. Tested over HTTPS with
  a certificate made by `openssl`.
- **Revocation:** the hub's refusal to start a session (after the node proved
  a pinned key) stops the agent, records it in `boot/state.json`, and `run`
  exits with status 3 from then on, saying why.

**2026-10-29 (M4a): device enrollment, the registry, sessions, and who may do
what.** Plan §0–§1. `src/core/mesh/`, migration `0005_mesh.sql`, Settings ›
Devices, `/pair`.

- **Who is asking** (`mesh/access.ts`), on every request, both listeners:
  - console: the console listener, a loopback peer, a loopback `Host`, and no
    `forwarded`, `x-forwarded-*`, `tailscale-*` or `x-real-ip` header;
  - device: a session of a trusted device (cookie `nova_session` or
    `Authorization: Bearer`), scoped by kind. Routes carry `access`:
    `public`, `person` (default: console, browser, phone), `approver`
    (console, or a browser/phone with `can_approve`), `device` (computer),
    `sync` (standby), `mesh` (any trusted device). Outside `/api/v1`
    everything is `person` except a short public list (`PUBLIC_PATHS`: the
    pairing page and what it loads, `/design-system.css`, the icons, and the
    reserved `/join.sh` and `/device-agent.tar`);
  - public: everything else. API: 401 (before route matching, so nothing is
    learnt about what exists). A page navigation: 303 to `/pair`. Another
    device's kind outside its scope: 403.
  - The `Host` check (421) and the X-Nova + Origin guard run as before, on
    both listeners; the mesh's public host is a trusted origin.
- **Tightening, said plainly:** with `NOVA_HOST` set beyond loopback, other
  machines used to get everything; now they get 401 until paired, and pairing
  needs a mesh address. Webhooks (`POST /hooks/{name}`) are `public`: they
  authenticate with their own token, as before. No existing test changed.
- **Transport** (`src/config.js` `meshConfig`): `NOVA_MESH_URL=https://…` needs
  `NOVA_TLS_CERT`/`NOVA_TLS_KEY`; `http://…` needs
  `NOVA_MESH_TRANSPORT=proxy|network`; otherwise Nova refuses to start and says
  why. A wildcard bind needs `NOVA_MESH_PUBLIC_URL`; `proxy` and TLS need an
  https public URL. Behind a stated proxy the rate limiter keys on the last
  `x-forwarded-for` entry, and only then. Joining and sessions are served only
  on the mesh listener.
- **Keys and formats** (`mesh/wire.ts`, node:crypto only so the device agent
  can carry it):
  - Era 1's code primitives and the HLC ported nearly verbatim; Era 1's fixed
    vectors still pass.
  - Fingerprint: the first 20 bytes of SHA-256 of the raw Ed25519 key, in
    Crockford base32 (the code alphabet), eight groups of four. A vector is
    checked against Python.
  - Every signed string has its own label: `nova-add-device-reveal-v1.<id>.<t>`,
    `nova-add-device-status-v1.<id>.<t>`, `nova-session-v1.<device>.<t>`,
    `nova-x25519-v1.<x25519 key>` (the join's `x25519_sig`: "over the X25519
    key", with a label), `nova-roster-v1.<canonical JSON>`. Times are Unix
    seconds within ±60 s.
  - `seal`/`open`: static-static X25519, HKDF-SHA256 with a fresh 16-byte salt
    per box and info `nova-seal-v1|<from>|<to>`, AES-256-GCM, optional AAD.
    Layout: version 1, salt, iv, ciphertext, tag.
- **Identity:** `home/mesh/identity.json` (0600, directory 0700, written
  atomically) holds this node's id and both key pairs. A looser file is
  tightened at start and recorded as a problem. The private halves never leave
  the module; serializing the identity shows public parts only. A test scans
  the database, its WAL and the log for the private keys, the code and the
  session token.
- **The hub is in its own registry** (role `hub`, kind `computer`), so the
  roster, `mesh_state.hub_id` and promotion (M4c) have a record to point at;
  for the console, "this device" is the hub. It can't be revoked.
- **Enrollment** (`mesh/enroll.ts`):
  - Codes: 20 an hour; single use; wrong, spent and expired codes all answer
    400 "That code didn't work."
  - The code is needed again for the digits, so between join and reveal the
    hub holds it in memory only (Era 1's approach); a restart forgets it and
    the request expires. **Deviation:** the join answer also carries
    `pairing_id`, which the digits are computed over.
  - Reveal within 2 minutes of the join, then approval within 10 minutes. A
    request that expired after showing its digits is a problem; one that never
    got that far is just tidied away.
  - A commitment that doesn't match denies the request and records a problem.
    A replayed reveal is 409; polls must be signed with a time newer than the
    last accepted one.
  - A revoked key is refused (403) without spending the code; a key already
    paired or already asking is 409. One standby at a time.
  - Rate limits per client address: 30 public calls a minute, 90 polls a
    minute, 10 wrong codes in 5 minutes. A refusal is one problem per address
    per 10 minutes.
- **Sessions:** `nvs_` tokens, 12 hours, stored as a labelled SHA-256. A signed
  session request starts one session only. `{cookie: true}` sets an HttpOnly,
  SameSite=Strict cookie (Secure when the public URL is https) and never puts
  the token in the body. `last_seen` is written at most every 30 s.
- **Revocation:** sets `trust='revoked'`, deletes sessions, emits `device`,
  and on the next turn destroys every response the device has open (core
  stream, Era 2 streams, anything in flight). A test shows streams close in
  well under a second, and fails without the closing.
- **Additions to the plan's route list:** `GET /mesh/status` (whether devices
  can reach Nova, where, and who is asking; the PWA needs it). `PATCH` joins
  the route methods. `join_request` events go only to approvers.
- **PWA:**
  - Settings › Devices lists the registry. Add a device is the standout,
    unless a device is waiting, when Review is. Revoke and "let it approve"
    are tier-3 sheets in the approval-sheet pattern. The join prompt opens by
    itself on the hub's screen and on approver devices, with the digits first.
  - The "Device id" row (the appearance id in localStorage) is now
    "Appearance id", since "device" means the registry now.
  - `ui/js/qr.js`: byte mode, level M, versions 1–10, the lowest-penalty mask,
    one `currentColor` path with a quiet zone. `.qr` uses `light-dark()` on
    `text/primary` and `bg/base`, so it is dark on light in every scheme with
    their 4.5:1 contrast. jsqr decodes every version and every mask, and, in
    Chromium, the pixels the page drew in light and dark mode without
    inversion.
  - `/pair` makes a fresh non-extractable Ed25519 + X25519 pair per pairing
    (IndexedDB); drops the fragment from the address bar; refuses a hub whose
    fingerprint isn't the QR's; shows the digits it computed itself and stops
    if the hub's differ; pins the hub's key and checks the roster's signature;
    signs in with the cookie. No secure context or no Ed25519: it says so and
    offers no way on.
  - A paired browser renews its session with its key two hours before it ends,
    and after a 401 (API or stream); if the hub refuses, it goes to `/pair`,
    which forgets the revoked key.
  - The service worker never caches `/api/v1/mesh/*`; shell cache v3.
- **Left for later:** `/join.sh` and `/device-agent.tar` are reserved public
  paths with no handler yet (M4b), so the command door answers 404 until then.
  The standby's lag in Health is `null` until sync (M4c).

**2026-10-29 (packet amendment): perception principles added to DESIGN-SYSTEM §1
as binding.** Owner's amendment; not a milestone, and M3/M4 scope is unchanged.
The current design already largely complies, so there is no UI rework for it alone:

- **Real progress:** the orb and every status come from real signals (ledger
  activity, approvals waiting, open problems, reachability) through one mapping
  (`ui/js/status.js`). A scan of `ui/js` found no simulated work or artificial
  delays: every timer is a reconnect check, a debounce or a toast's lifetime.
  The scripted stand-in model's `FAKE_DELAY` is a test tool, never shipped
  behaviour.
- **One standout:** each card and sheet has one primary button; approvals use
  the approval sheet, and tier-3 steps (including irreversible Era 2 commands)
  add the confirm box.
- **No engagement mechanics:** no streaks, badges for use, praise or guilt
  copy anywhere.
- **Endings:** ledger tasks end Verified with evidence, or Failed/Cancelled with
  a reason; setup ends on the welcome task's VerifiedResultCard.
- **Where it doesn't fully comply yet** (fix when the surface is next touched):
  the Appearance picker lists every installed design system as equal options,
  with the current one marked but no recommendation; Era 2's settings screens
  weren't audited view by view for a single primary action.

**2026-10-29 (M3c): the M3 gate runs in a real browser.**

- **Where:** `tests/ui/*.test.ts` drive Chromium (playwright-core) against the
  real server process. Locally, with no usable browser, the suite skips with a
  loud notice; in CI (`CI` set) a missing browser is a failure, so the gate
  never passes by not running. CI installs the Chromium build matching
  playwright-core in its own job and keeps the screenshots as an artifact.
- **This dev host can't start Chromium** (missing system libraries; installing
  them needs root). `scripts/ui-test.sh` runs the suite in the Playwright image
  with the host's Node mounted. Server, browser and tests share the container
  because Docker Desktop's host network doesn't reach WSL.
- **Screenshots** are written only when `NOVA_UI_SHOTS` names a folder, so a
  plain test run never rewrites tracked files; `scripts/ui-test.sh` writes
  `docs/screenshots/m3/`. Each waits for finite animations to finish first.
- **"No face"** is checked structurally: every orb on the page has exactly its
  four layers and no image, SVG or canvas inside.
- **Independent review, fixed before merge:**
  - Offline honesty: health checks are network-only in the service worker, and
    a cached answer never counts as Nova being reachable (a second outage used
    to flip the orb back to idle every two seconds). Browser-tested with two
    real outages; the test fails on the old code.
  - Tier 3 for Era 2 tool steps: removing a schedule, and commands that look
    irreversible (rm, dd, force push, hard reset, clean -f, branch -D, find
    -delete, DROP TABLE, recursive chmod/chown), need the confirm box every
    time. The command check only adds friction; anything it misses still asks
    first (tier 2). Settings' "without asking" permissions are the person's own
    policy and are unchanged.
  - Turning off the design system in use falls back to the one before, drops
    device overrides on it, and sends the `design-system` event, as removal
    does.
  - Applying "on all devices" from a device with its own choice now says that
    this device keeps its choice.
- **Found by the gate and fixed:** setup ignored the curly apostrophe phone
  keyboards type ("I’m Alex" became the name), and setup's transcript replayed
  its entrance animation on every answer.

**2026-10-29 (M3b): the PWA: layouts, navigation, components; Era 2's
aliases removed.**

- **Breakpoints** live only in `ui/styles/layout.css`. It turns widths into
  words on `:root` (`--viewport`: narrow < 600 px, medium 600–1023 px, wide
  ≥ 1024 px; `--aside-room`: yes ≥ 1280 px; `--segments` from the
  `viewport-segments` media features), and `ui/js/layout.js` combines them
  with the posture into `<body data-layout data-posture data-aside
  data-room>`. No script holds a pixel width.
  - phone: narrow, or `folded`. tablet: medium, or any half-open posture.
    desktop: wide and flat. The right column (desktop) shows at ≥ 1280 px
    unless the person closes it (kept per browser); on a tablet the same three
    quiet cards are the context pane.
- **Postures**, in Nova's words: `continuous`, `folded` (the cover screen),
  `half-open-horizontal` (segments side by side, book), `half-open-vertical`
  (segments stacked, laptop: conversation on top, the active card below).
  The Device Posture API's own `folded` means half-open, so Nova maps it to
  half-open by orientation. `?posture=` emulates one for tests and is read
  once per page load.
- **Navigation**: nine destinations, Home, Chat, Tasks, Memory, Automations,
  Skills, Activity, Health, Settings, reachable in every layout
  (`ui/js/nav.js`, tested). Phone tabs: Home · Chat · Tasks · Memory · More
  (Automations, Skills, Activity, Health, Settings). Rail: the orb is Home,
  then Chat, Tasks, Memory, Automations, More (Skills, Activity, Health), and
  Settings at the foot. `/` is Home now; the main conversation moved to
  `/chat`; `/schedules` still works and shows Automations. Conversations are
  a drawer from Chat's top bar in every layout.
- **Status**: one function maps ledger states (queued → Waiting; active,
  verifying → Working; waiting for an OK or flagged for attention → Needs you;
  other waiting → Waiting; done → Verified; failed → Failed; cancelled →
  Quiet). Era 2's activity states use the same words and never claim
  Verified. Automation rules and health checks are not work, so they show a
  plain pill (Paused, Fine), not the vocabulary.
- **The orb** is CSS light (gradients from `orb/*` tokens), no face. Its state
  comes from real signals, most urgent first: offline, listening, alert (open
  problems), attention (an OK waiting), speaking (a reply streaming), working,
  idle.
- **Buttons on the accent.** With the aliases gone there is no computed
  `--accent-text`; primary buttons, Send and the person's bubble are lit with
  the accent mixed 24% into `bg/raised`, labelled in `text/primary`. A test
  checks that pair reaches 4.5:1 in every built-in package and mode.
- **Device id**: `nova.device` in localStorage (a random UUID) is the only
  appearance state in the browser; the design system and mode come from the
  API. `scripts/shots.js` gives each browser context its own device id and
  applies its design system through the API.
- **Service worker**: the shell is precached, but every request is
  network-first, so a running Nova always serves fresh code. Offline GETs come
  from the cache with `x-nova-offline`, and the page says so. Memory and
  receipts are never cached (forgetting must hold everywhere); changes and
  event streams are never answered offline. The manifest's colours are Orb
  Teal's literal values, since a manifest can't read CSS variables.
- **Honest surfaces**: Devices shows this browser only; the Brief card says
  no brief exists yet; there is no Smart Home card. Voice is disabled in
  local-only with the reason under the composer, and elsewhere only where
  the browser has speech recognition.
- **Removed**: `ERA2_ALIASES`, `ERA2_NAMES`, `--accent-text`, the schema's
  `era2_aliases`, and the lint's `LEGACY` list. Every file in `ui/` uses
  schema tokens only, raw spacing is an error everywhere, and `@container`
  width queries count as breakpoints.
- **shots.js** now completes setup through the API first, and its memory
  margin-link check clicks the oat-milk note by text: since M2 a day note is
  also a linked memory, so "the first link" was no longer the one meant.

**2026-10-29 (M3a): design systems are token packages; Era 2's names are
temporary aliases.**

- **Tokens.** The schema is DESIGN-SYSTEM §2 in full, plus:
  - `type/weight-regular`, `type/weight-strong`, `type/line-tight`,
    `type/line-body`;
  - `motion/duration-fast`, `motion/duration-slow`, `motion/ease`.

  It lives only in `src/core/design.ts` (`TOKENS`), and `ui/` reads it from
  `GET /api/v1/design-systems/schema`. A name maps to a CSS variable by
  replacing `/` with `-` (`bg/base` → `--bg-base`). Values are literal and
  checked per family:
  - colours are hex or `rgb[a]()`, so contrast can be measured;
  - `type/h*` are sizes, and line heights are plain numbers;
  - `motion/breathe`, `motion/pulse` and `motion/transition` are durations,
    paired with `motion/ease`.

  Anything else is refused, so a value can't carry CSS beyond its token.
- **Package format.** A full CONTRACTS §4 manifest of kind `design-system`.
  It asks for no permissions, uses no secrets and keeps nothing on removal;
  the extension host enforces this at install.
  - `tokens{}`: the full set.
  - `modes{light?, dark?}`: partial overrides.
  - `reduced_motion{}`: may only shorten motion; loops must be `0s` and
    everything else at most 200ms. The core emits safe defaults anyway.
  - `components{}`: bindings that may name schema tokens only.
  - `content_rules{}`: DESIGN-SYSTEM §6 as numbers and switches, which may
    only tighten.
  - `extras[]`: any component outside §7 must be declared here.
  - `preview[]`, plus an optional `description`.

  A package that fails validation can be installed and inspected, but it is
  never applied or previewed. Built-ins come from `design-systems/` on every
  start, skip the `nova_compat` check (they ship with this Nova), can't be
  removed, and are updated in place.
- **Selection.** The profile section `appearance` holds `design_system`,
  `previous`, `mode` (auto by default) and `device_overrides`, plus
  `device_previous`, so a device's rollback doesn't lose an older override.
  With no record, Orb Teal shows, and a blank profile stays blank for setup.
  The mode is set through `PUT /api/v1/profile/appearance/mode`; the other
  keys only change through apply and rollback.
- **Era 2 themes converted.** Nova, Paper, Aurora and Obsidian are packages
  now, and `ui/themes/` is gone. Their values map onto the new tokens:
  - `--bg` → `bg/base`, `--surface` → `bg/raised`, `--raised` →
    `surface/card` and `bg/overlay`, `--wash` → `surface/card-hover`.
  - Status and orb colours come from each theme's accent and status colours.
  - `type/*` sizes come from the shorthands, and `weight-strong` and the
    line heights from the title and body styles.

  Fidelity losses: the `--t-*` shorthands become one strong weight for every
  heading (Paper's 400-weight serif display is now 600), `--r-bubble` follows
  `--r-card`, `--code-bg` follows `bg/base`, and `--shift` follows `space/1`.

  Faint text on cards, a pair Era 2 never checked, missed 3:1 by a hair in
  two themes:

  | Theme | Token | Era 2 | Shipped | Why |
  | --- | --- | --- | --- | --- |
  | Nova | `text/faint` | `#62626B` | `#65656e` | 2.87:1 on `surface/card`; needs 3 |
  | Obsidian | `text/faint` | `#62666D` | `#63676e` | 2.98:1 on `surface/card`; needs 3 |
- **Temporary aliases.** So today's `ui/` keeps working until the PWA
  replaces it, the generated CSS also emits Era 2's names (`--bg`, `--text-2`,
  `--t-body`, `--s3`, `--r-card`, `--m-fast`, …) as `var()` aliases of the
  new tokens. `--accent-text` is chosen per package for contrast.
  `lint:tokens` allows these names only in the Era 2 files listed in
  `LEGACY`. New UI code may use schema tokens only, and there raw spacing and
  breakpoints outside `ui/styles/layout.css` are errors too. The aliases, the
  `LEGACY` list and `ERA2_ALIASES` are removed together with the Era 2 UI.

**2026-10-29 (M2): a held message says why it waits.** Messages carry a
`hold`:
- `quiet`: delivered when quiet hours end, but only if its rule still exists,
  isn't paused and isn't turned off; otherwise `withdrawn`, never delivered.
- `needs_ok`: triage wasn't sure. Only the person releases it
  (`POST /api/v1/messages/{id}/approve`).
Privacy is re-checked before every model step, not once per turn, and a
caller's mode can only tighten the live setting. All of this is from the M2
review.

**2026-10-29 (M2): scheduled runs and helpers are ledger tasks; the M1 debt
is paid.** Each scheduled run is a heartbeat trigger record (source
`schedule:<id>`, claimed once per due time) whose task belongs to the
`chat-run` worker (`src/chat-run.js`); each helper is a `chat-run` task whose
origin names the conversation that asked. The worker runs them through the
Era 2 runner and reports a `confirmation` from `nova-sessions`, which Nova
checks itself by reading the report in the target conversation. The ledger
now runs tasks in lanes: scheduled runs one at a time, helpers three at once,
every other worker sharing one lane of one, as before. A run waiting for the
person's OK reports `blocked` and waits, giving up its place (in Era 2 such a
helper kept one of the three); when the run ends it is requeued to hand over
its report. A run interrupted by a restart is not run again (its steps may
have changed things): its conversation hears it didn't finish. A run uses the
stricter of its task's privacy mode and the current setting; if that refuses
the model, the task waits on local capacity. Schedule files stay the
schedules' registry, so the trigger engine takes a rule-less firing with its
own action; `runs.jsonl` stays as the per-schedule history the Schedules view
and catch-up read, each entry naming its task.

**2026-10-29 (M2): MEMORY.md is a view of the core's memory.** The curated
memory lives only in SQLite (ADR-4). `MEMORY.md` is re-rendered after every
change, with the same headings and `<!-- id= from= at= -->` comments, so the
model and the person see what they saw before. Existing entries were
imported once, keeping their ids, sources and times. A hand edit (detected by
hash before each read) is taken in as the person's: changed words become a
correction, a new bullet is remembered as confirmed, and a removed bullet is
forgotten. Trade-offs:
- Corrections, edits and undo create a new id.
- Invented headings, prose paragraphs and bullet order don't survive a
  re-render.
- Deleting the whole file re-creates it rather than forgetting everything.
- Day notes stay files until M3.

**2026-10-29 (M2): triggers are one engine with a visible registry.** Every
automation is a rule (`event`, `heartbeat`, `proactive`) listed at
`/api/v1/triggers/rules`; every firing is a trigger record (CONTRACTS §6)
with its triage decision and reason, and what it led to. The firing pipeline
runs in this order: dedup (default key is the payload hash, 600 s window),
cooldown, triage, act. Proactive messages are held during quiet hours.
Heartbeats run once per due time (`claim_key UNIQUE`); missed runs older
than 6 h become one "missed" record. Webhooks (`POST /api/v1/hooks/{name}`)
are the one route exempt from the `X-Nova` guard. They authenticate with a
per-rule token instead, shown once and stored as a hash, and `api.ts` refuses
any other route that claims the exemption. When triage escalates, the task
it creates waits for the person's OK.

**2026-10-29 (M2): System 1 is a provider interface with a local rules
provider; Jev stays a stub.** The owner chose not to create a Jev account
yet. `JevProvider` declares what it would answer and refuses to run. Local-only
uses only providers whose egress is `none` or `local`. Templates are authored
on cache miss only (propose, then dry runs, then activation). Activation is a
ledger task whose `test_result` evidence the verifier re-checks by re-running
the dry runs. The built-in `triage@1` template ships active.

**2026-10-29 (M2): Noul, as the owner defined it.** Noul is Jev's yes/no
type: one calibrated probability in [0, 1]. Its certainty is
`|p - 0.5| * 2`, and a provider's separate confidence is ignored for it. A
mixed template is only as certain as its weakest part. An out-of-range
answer becomes 0.5 and escalates.

**2026-10-29 (M2): memory is SQLite records (CONTRACTS §7); forgetting is
complete.** A correction supersedes the old record and keeps the history; a
forget deletes the whole chain with `secure_delete` and leaves an audit row
with no content. The owner's standing order makes deletion hold in backups
too. Each pre-upgrade backup is cleaned in place (rows deleted, file rebuilt),
so it stays restorable and can't resurrect what was forgotten. The retention
rule: backups are kept until the person removes them, but a backup Nova
can't clean is destroyed and reported. Exports the person wrote are theirs
and are not touched.

**2026-10-29 (M2): a context receipt for every model call.** The chat runner
records each one before calling the model: the system prompt, standing
files, recalled notes, skills and conversation, by reference and sha256,
plus purpose, privacy mode and egress. `GET /api/v1/receipts?egress=remote`
is the egress log. A receipt that would record a remote call under
local-only is refused and becomes a problem.

**2026-10-29 (M1): chat honors the privacy mode; the model command declares
its egress.** Found after the M1 gate passed: setup promised "nothing leaves
this machine", but chat still defaulted to a cloud model. Now `agent_egress`
(`none` | `local` | `remote`, from `NOVA_AGENT_EGRESS` or `agent_egress` in
`nova.config.json`) says where the model command sends conversations, and
undeclared counts as `remote`. With a local-only profile a remote model is
never started: the person gets a plain error saying nothing was sent, and
how to change it. Setup says up front when the configured chat model is a
cloud one. In local-only, tools that reach the internet (web, Gmail) are
not offered; `exec` still asks every time. Consequence: a new user who
keeps local-only has no chat until a local model is configured (M6 makes
that easy). That's the honest trade, per the non-negotiable that local-only
never falls back to cloud.

**2026-10-29 (M1): the core is TypeScript run directly by Node, inside the
same server.** `src/core/` is the modular-monolith core (ADR-1). Node 26
strips types natively, so there is still no build step; `tsc` only
typechecks (`npm run typecheck`). The existing server mounts the core at
`/api/v1` behind its existing loopback, Host and `X-Nova` guards: one
process, one Nova, not a second app beside the first. Only `core/index.ts`
may be imported from outside the core (a test enforces it). The JavaScript
modules move to TypeScript as they are touched. `engines` is now Node >=26,
the version actually tested.

**2026-10-29 (M1): SQLite through `node:sqlite`, no ORM.** Structured state
(profile, ledger, extensions, problems) is in `~/Nova/nova.db` (ADR-4).
Migrations are forward-only and checksummed, with a backup before every
upgrade; rollback is restoring that backup. Ported from Era 1's storage
package without drizzle. The database, logs, backups and extension data
stay out of the home's git history.

**2026-10-29 (M1): the task envelope gains one optional field, `inputs`.**
CONTRACTS §1 lists the brief's fields; a deterministic worker (no model)
can't act on a plain-language goal alone, so `inputs` carries its
structured parameters. Optional and additive, so envelope version stays 1.
Recorded here as the contract note the packet asks for.

**2026-10-29 (M1): a task can't be created without an evidence
requirement, and unknown evidence fails.** "Done without evidence is not
done" (NOVA-SPEC §3) is enforced at creation, and the verifier fails any
evidence kind it has no checker for, rather than passing it. Read-back is
the first checker: Nova re-reads the target itself.

**2026-10-29 (M1): setup is a scripted interview.** It has to work before
any model is configured and with no network (the M1 gate is local-only), so
it doesn't use one. Each answer is written to the profile as it is given;
unclear answers are asked again, never guessed. A model-assisted version
can replace the parsing later without changing the records it writes.

**2026-10-29 (M1): the persona moved out of `system/system_prompt.md`.**
"Who you are" is now rendered by `src/core/identity.ts` from the fixed
charter plus the profile (name, tuning), and the chat runner gets it from
the core. The old Truth / Respect / Restraint values are kept, as the
charter and the speech rules.

**2026-10-29 (M1): known debt, owned.** Era 2's helpers and schedules still
run outside the ledger, so for now there are two records of background
work. Schedules move onto the ledger in M2 (its gate requires it), and
helpers with them. The ledger runs one task at a time. A timezone set in
setup reaches the chat and scheduler side on the next restart.

**2026-10-29 (M0): the builder packet governs; the current tree is the base.**
From here on `docs/builder-packet/` is the authoritative design, and where it
and this ledger disagree, the packet wins. The build continues from this tree
(Era 2) rather than restoring Era 1: it is the owner's deliberate clean slate
(`7ea842b5`), it is small and fully tested, and restoring Era 1's ~465k lines
wholesale would break the packet's per-component reuse rule. Era 1 components
whose design already matches the contracts (device pairing, the secrets
vault, browser takeover, the migration runner) are ported in the milestone
that needs them, with their tests and without their framework dependencies.
Evidence: `docs/inventory/M0-DELTA.md`.

**2026-10-29 (M0): CI runs on every PR; the toolchain is pinned.** Nothing
ran the suite on GitHub before. `.github/workflows/ci.yml` runs the token
lint, a parse check of every JS source (not a typecheck: there are no types
until the TypeScript core lands), the theme contract, the tests and
`npm audit`. Node 26.3.1 is pinned in `mise.toml` and CI installs it from
there, so local and CI match.

**2026-10-21 (Phase 2): memory is kept with blocks, not tools.** The model
ends its reply with `<remember>`, `<note>` and `<forget>` blocks; the runner
strips them from the stream and applies them before `done`. A tool call per
memory would cost a model round trip (~1.5 s each). Entries stay markdown
bullets with a trailing `<!-- id=… from=… at=… -->` comment, so they remain
readable and editable by hand, and the Memory view, corrections and forgetting
all point at the id.

**2026-10-21 (Phase 2): session logs record memory by id only.** The words
live in the memory files; conversations look them up. Forgetting therefore
removes a memory from every conversation view too.

**2026-10-21 (Phase 2): forgetting a memory forgets matching day notes.**
Same exchange and one shared word stem, or most of its word stems anywhere.
Otherwise search would bring it back.

**2026-10-21 (Phase 2): memory stays out of the home's git history.** The
home folder's `.gitignore` excludes `MEMORY.md` and `memory/*.md`, so
forgetting leaves no copy in old commits, and no history is ever rewritten.
Conversations and standing files keep their audit trail. Agreed with Jeremy
in the thread.

**2026-10-21 (Phase 3): skills are playbooks, loaded by their words.** A
skill is `SKILL.md` with front matter (`name`, `about` for the person, `when`
for the model, `words`, `needs`, `try`) and a markdown procedure. Nova ships
two in `skills/`; installing copies the folder into the home. When a message
contains one of a skill's `words`, the runner loads its playbook (and the docs
of the connectors it needs) before the first model call, which saves a round
trip. Every installed skill is also listed, so the model can load one with
`use_skill` when the words miss. Real model: "Anything I need to deal with
from overnight?" matched nothing and the model loaded Email summary itself.

**2026-10-21 (Phase 3): Nova reads Claude's skill format, and people can add
their own.** Jeremy asked for plugins like Claude's and ChatGPT's. Skills are
the part that fits Nova now: a `SKILL.md` with only `name` and `description`
loads (the description is both the summary and the trigger), and its other
files are copied and listed to the model. Adding takes a folder or a .zip
(read with a small zip reader in `src/zip.js`, no dependency), capped at 200
files and 5 MB, refusing name clashes and paths outside the folder. An added
skill is trusted instructions, not code: scripts only run through `exec`,
which always asks. MCP connectors are a later phase.

**2026-10-21 (Phase 3): skills and sign-ins stay out of the home's history.**
`skills/` and `connectors/` join the memory files in the home's
`.gitignore`, so removing a skill leaves nothing in old commits and no token
is ever committed. Conversations still record which skill they followed (by
name), and show "since removed" afterwards.

**2026-10-21 (Phase 3): Gmail connects with an app password, over IMAP;
your own OAuth client is the Advanced way.** Jeremy found the OAuth-client
setup (Google Cloud project, consent screen, Desktop client, JSON) too much
for anyone to do. The one-click "Connect" other assistants offer needs a
Google-verified app; Gmail scopes are "restricted", so that means Google's
review (weeks) and a yearly third-party security assessment, and until then a
warning screen and a 100-user cap. Not now. An app password takes about two
minutes and no Google Cloud at all. Costs: it needs 2-Step Verification, it
opens the whole mailbox (no read-only), and work or school accounts often
can't make one, which is what Advanced is for. The OAuth path (PKCE, loopback
redirect, so localhost only) stays as it was, now with `gmail.modify`.
Connecting one way disconnects the other. This reverses the earlier call to
reject IMAP; what kept it safe is below.

**2026-10-21 (Phase 3): Gmail drafts and organizes; it never sends or
deletes.** Jeremy asked for actions. Drafts, archive, labels and read state
are all reversible from Gmail; sending and deleting aren't, so Nova has no
code for either (no SMTP, no delete call). Every draft and change waits for
the person on an approval card that shows the exact draft or the exact
messages, worked out before asking; a draft or change that can't be worked
out (a gone message, a label that doesn't exist) fails before the card.
Reading uses `BODY.PEEK`, so it never marks mail read.

**2026-10-21 (Phase 3): after mail is read, going online asks first.** Email
is outside content, and a malicious message can ask the model to put mailbox
details into a URL. In a conversation where Gmail has been read, `web_fetch`
and `web_search` wait for the person's approval. Real model: told to "do what
the security email says", it read the email, declined, and explained why.

**2026-10-21 (Phase 3): web search is DuckDuckGo's HTML page.** No API key
and no dependency; Nova parses titles, links and snippets, and drops ads. It
breaks if DuckDuckGo changes its markup; `NOVA_SEARCH_URL` points it
elsewhere, and the walkthrough uses a stand-in.

**2026-10-21 (Phase 3): shopping researches and never buys.** Payments are
out of scope and a purchase can't be undone. Real model: big retailers often
refuse automated page reads (503s, rate limits), and the playbook's rule of
quoting only prices it saw made it stop short of a recommendation. The
playbook now asks deciding details first, caps page reads at about six, and
falls back to agreeing sources labelled "reported".

**2026-10-21 (Phase 5): permissions, all "ask" by default, in Settings.**
Jeremy first chose full autonomy for unattended work, then revised: every
permission defaults to ask, with a Settings page of switches whose list is
dynamic. Each tool that needs an OK declares `permission: {id, label,
note}`; tools without one get a permission named after the tool, so plugin,
MCP or Nova-made tools appear without code changes. Going online after
reading mail is the one permission not tied to a tool. On = take the step
without asking everywhere (`approval {allow, auto: true}`, stamped "Without
asking"). Off = ask; with no one watching, the run or helper waits for the
answer, and a waiting scheduled run steps aside so the queue keeps moving.
Stored in `~/permissions.md`; `write_file` can't edit it. This replaces
Phase 4's "unattended runs decline approvals".

**2026-10-21 (Phase 5): Nova comments on a helper's report.** Jeremy's call.
After a helper's report is delivered (ok, not stopped), the runner starts a
turn with no message from the person (`user {text: '', followup: <handoff
id>}`), prompted with a `<followup>` note asking for its take and the next
step. Nothing is shown for the person's side of that turn.

**2026-10-21 (Phase 5): helpers start fresh.** A helper is its own session
(`kind: "helper"`, hidden from the list) with a scoped context: the base
prompt, AGENTS/SOUL/IDENTITY/USER, skills, its brief and up to five files the
parent passes. No MEMORY.md, day notes, recall or schedules, and memory blocks
it writes are ignored. The parent writes a self-contained brief, which keeps
the helper's context small and its work checkable from the log.

**2026-10-21 (Phase 5): helpers can't nest or schedule.** A step that needs
an OK waits for the person, per Settings (above); `delegate` and
`schedule_*` aren't offered. Up to three run at once and the rest queue. Stop and Try again are
in Activity and on the report; on start, a helper cut off by a shutdown
reports that it didn't finish.

**2026-10-21 (Phase 5): Activity is derived, not stored.** `/api/activity`
reads the session logs and `runs.jsonl` for a week in the person's time zone,
caching each parsed log by size and modified time. Steps keep only a few
arguments (path, url, command, query, name, id, title); tool output stays in
the logs. An `activity` server event (throttled) keeps the "N waiting" count
in the sidebar current.

**2026-10-21 (Phase 5): a fetch that fails is a failed step.** `web_fetch`
now throws on an HTTP error status instead of returning the error page, so
Activity and the transcript don't show a 429 as "Read".

**2026-10-21 (Phase 4): the main conversation is the front page.** "/"
opens one long conversation (`sessions/main.jsonl`) that scheduled reports are
delivered into, and a reply to a report continues there. New conversations
moved to `/new` (+, ⌘⇧O). A report's first sentence is set as a headline, so
the digest reads as a front page rather than a notification.

**2026-10-21 (Phase 4): a schedule is a markdown file with cron.** Front
matter (`name`, `cron`, `deliver`, `once`, `paused`) and the instructions as
the body, in `~/Nova/schedules/`. Five-field cron evaluated on the wall clock
of the configured time zone; a time skipped by daylight saving runs just
after, a repeated one runs once. No scheduler library: the evaluator is under
200 lines and tested on DST edges.

**2026-10-21 (Phase 4): schedules run only while Nova runs.** The scheduler
ticks every 30 s and runs one job at a time. On start, a run missed in the
last six hours runs late, once; older ones are recorded as missed in
`runs.jsonl`. Running while Nova is closed needs an always-on host (the hub
idea), which is out of scope.

**2026-10-21 (Phase 4): unattended runs decline approvals.** A run is its own
session (`kind: "run"`, hidden from the list). Anything that would ask for
approval is declined and recorded as not asked; the model is told to suggest
it in the report. Waiting for a person would stall the queue.

**2026-10-21 (Phase 4): schedules are set through an approval.** The model
uses `schedule_set` and `schedule_remove`, which always show a card with the
exact instructions; `write_file` refuses `schedules/`, so there's no way
around the card. The system prompt forbids promising a follow-up without one.

**2026-10-21: personal data lives outside the code.** The repo is public
(AGPL). Each person's Nova data is one folder of plain files (`NOVA_HOME`,
default `~/Nova`), seeded from `templates/home/`, and a local git repository
with a commit after every reply. Backup is wherever that folder lives. No
database, no sync service. This also fits a later hub-and-spoke deployment:
the data lives with the runner, and inference spokes only see prompts.
Jeremy asked for a recommendation; this is it, and it is a default path only.

**2026-10-21: a text tool protocol, not a framework.** The model ends a message
with one `<tool_call name="…">{json}</tool_call>` block; Nova runs the tool and
calls the model again with the transcript. This keeps `agent_cmd` swappable
and keeps every approval in Nova's hands. Claude Code is run with its own
tools, hooks, MCP servers and settings disabled.

**2026-10-21: four tools.** `read_file` and `write_file` are confined to the
home folder and cannot touch `sessions/`. `exec` always asks first and starts
in `~/workspace`. `web_fetch` reads http(s) pages as text. There is no
"always allow" in Phase 1.

**2026-10-21: the session log is append-only.** Regenerating a reply starts a
new attempt for the same turn; the view shows the newest attempt and the log
keeps all of them. If the server dies mid-reply, the conversation shows the
reply as interrupted, with Regenerate.

**2026-10-21: the agent's environment is cleaned.** When Nova runs inside a
Claude Code session, that session's memory reached `claude -p` through
environment variables, and Nova repeated things it had no business knowing.
Nova now strips `CLAUDE*MEMORY*`, `CLAUDE*ADDITIONAL_DIRECTORIES*` and
`CLAUDE*CLAUDE_MD*` before spawning the agent. Verified: a canary in
`~/.claude/CLAUDE.md` does not reach the model either.

**2026-10-21: the reply ends when the model stops, not when the process
exits.** `claude -p` spends about 2 s on housekeeping after the last token.
Nova finishes at `message_stop` and ends the process, which takes ~2 s off
every step of a tool loop.

**2026-10-21: the scroll budget is judged on Nova's own work per frame.**
The build container has no GPU, so Chromium composites in software and frame
intervals flip between 17 and 33 ms on identical code. The walkthrough traces
the scroll and requires the page's main-thread work to stay under 8 ms a
frame (half the budget); raw intervals are still reported. Older turns use
`content-visibility: auto`, so long threads only lay out what is on screen.

**2026-10-21: no conversation rename or delete in Phase 1.** Restraint: titles
come from the first message, and the files are on disk.

**2026-10-21: localhost only.** The server binds 127.0.0.1 and refuses other
Host headers (DNS rebinding) and cross-site POSTs (a custom header CORS never
grants). Phone access would need `NOVA_HOST` and has no authentication yet;
the server warns when started that way. Not in Phase 1 scope.

**2026-10-22: Nova is the default theme, as one token file (Path A).**
Jeremy kept the existing build rather than restarting. `ui/themes/nova.css`
comes from `design-system-nova.md`, and `nova` is first in `THEMES`, the
fallback in `theme.js`, and the first paint in `index.html` and
`styleguide.html`. Paper, Aurora and Obsidian are unchanged and stay
optional. A browser that already chose a theme keeps it. The Stellar Map is a
later phase.

## Theme token gaps

Era 2's record. Since M3a these themes are packages in `design-systems/`,
and the values below carry over (see the M3a decision above).

None of the three specs defines every token THEMING.md requires. Gaps are
filled from each theme's own palette (mostly `mockups.html`) and marked
`/* derived */` in the token file. Values changed to pass the contract's own
contrast check:

| Theme | Token | Spec | Shipped | Why |
| --- | --- | --- | --- | --- |
| Paper | `--text-2` | `#7A736A` | `#726C63` | 4.38:1 on `--bg`; needs 4.5 |
| Paper | `--text-3` | `#A79D8F` | `#91887B` | 2.5:1 on `--bg`; needs 3 |
| Paper dark | `--accent` | `#C4502B` | `#D9714C` | too dark on evening paper |
| Aurora dark | `--accent-text` | (none) | `#000000` | white on `#7D7AFF` is 3.4:1 |
| Nova | `--accent-text` | `#FFFFFF` | `#0A0A0C` | white on `#6E8CF5` is 3.12:1 |

Contract additions this build needed, proposed for THEMING.md (every theme
defines them, `scripts/check-themes.js` requires them):

- `--font-mono`, `--t-mono`: code, commands, keyboard hints.
- `--t-wordmark`: the sidebar wordmark.
- `--column`: the reading column (680 / 720 / 760 px).
- `--material-blur`: Aurora's frosted surface; 0 elsewhere.
- `--shift`: how far views move when they change; 0 under reduced motion.

Obsidian's spec names differ from the contract (`--panel` is `--surface`,
`--accent-dim` is `--accent-wash`, `--shadow-pop` is `--shadow-2`). Obsidian
is dark in both modes, as its spec defers a light variant.

Nova (default since 2026-10-22, Path A) is dark in both modes too: its spec
defines only the dark workspace. Its starlight tokens and `--folder` are not
shipped yet; they arrive with the surfaces that use them (Stellar Map, Files
explorer). Its spec gives the sidebar `--surface`, but the shared components
paint the sidebar `--bg` and the page `--surface`, so in Nova the sidebar is
the darker of the two. Swapping that is a component change, left for Jeremy.

## Known limits

- Screenshots are rendered on Linux, where New York, Iowan and SF are absent;
  the serif and sans fall back to Liberation/DejaVu. On a Mac, Safari renders
  New York (`ui-serif`) and Chrome renders Iowan Old Style.
- Performance numbers come from the build container, not Jeremy's Mac.
- Margin notes appear when a message matches a dated note. Nothing writes
  dated notes automatically until Phase 2's memory discipline.
