# S28 — attachments: giving her a file in the conversation

Owner's pick, 2026-09-16, after S25 closed: of the things v3 had and v4 does
not, this one first.

Today the composer takes text and nothing else. To show her a screenshot, a
log, a PDF or a CSV, he has to put it somewhere she can already reach and
then describe where — which means the one moment he has the file in his hand
is the one moment he cannot use it.

## What is already true, and shapes everything below

**She has a workspace and tools over it.** `WORKSPACE_ROOT` (/data/workspace,
its own docker volume) with `workspace_write_file`, `workspace_read_file`,
`workspace_list_files`, `workspace_delete`. An attachment does not need a new
storage concept; it needs to land somewhere she can already read, and the
read then shows up on the trace like any other.

**Vision is DERIVABLE, not a list.** `ollama show` reports capabilities per
model, and the household's models disagree:

| model | completion | tools | thinking | vision | audio |
|---|---|---|---|---|---|
| qwen3:8b (the current chat model) | yes | yes | yes | **no** | no |
| qwen3.8:27b | yes | yes | yes | **yes** | no |
| gemma4:12b / 31b | yes | yes | yes | **yes** | yes |

So "can she see this picture" has a mechanical answer for the model actually
selected, and the answer changes when he changes models. Nothing here may
hardcode a model name.

**nginx's default body limit is 1 MiB**, and there is no
`client_max_body_size` anywhere in this repo. In v3 this exact default broke
the phone path for attachments — the desktop dev server allowed the upload
and the one-origin build rejected it, so it worked everywhere except on the
device he actually uses. Whatever ceiling we choose has to be set in nginx
AND stated by the API, and the walk has to go through :3000, not the dev
server.

## The shape

1. **A file lands in the workspace, under a per-conversation folder.** It is
   a real file with a real path, so every later turn can read it again, she
   can act on it with the tools she has, and nothing about it is special.
2. **The turn is told what arrived** — name, type, size, path — as a fact on
   the message, never as a sentence someone wrote.
3. **An image goes to the model as an image IF the selected model reports
   `vision`.** If it does not, that is said plainly, with the names of the
   models on this box that can. Never silently dropped, and never described
   back to him from the filename.
4. **Everything else she reads with the tools she already has**, which is
   what makes the read appear on the trace instead of being asserted.

## Questions

1. **Where should an attachment live?** My recommendation: the workspace,
   under `attachments/<conversation>/<filename>` — she can read it later,
   act on it, and the read is on the trace. The alternative is a private
   store only the turn can see, which is tidier and makes the file useless
   the moment the turn ends.

2. **When the selected model cannot see an image** — refuse the turn with a
   stated reason and the models that can? Or switch to a vision model for
   that turn and say so? Or accept it as a file she can describe only by its
   metadata, and say she cannot see it?

3. **What should the ceiling be?** v3's trap was nginx's 1 MiB. Phone photos
   are 2–5 MB, screenshots under 1 MB, a PDF can be anything. I suggest
   25 MB with the limit stated in the refusal.

4. **Which kinds first?** Images and text (txt/md/csv/json/log) are cheap.
   PDFs need extraction — a dependency and a slice of its own. Audio is a
   real option now that gemma4 reports `audio`, but it is a bigger build.

5. **Should she be able to attach a file BACK?** She can already write into
   the workspace; a file she produced appearing in the conversation as
   something he can open is a small addition on top of this, or a later
   slice.

## Answers (Jeremy, 2026-09-16)

1. **The workspace**, as recommended — `attachments/<conversation>/<file>`.
   A file she can read later and act on, with the read on the trace.

2. **Switch the model for that turn, and say which.** Not a refusal and not
   a shrug: an image he sent is a thing he wants read, so the turn runs on a
   model that can read it and the reply says which one and why. Two
   consequences to build for rather than discover:
   - **The switch is DERIVED.** Capabilities come off the live model
     (`ollama show` reports `vision` and `audio`), never a model name in
     code. A box with no vision-capable model must say that, not pick one
     anyway.
   - **It is stated, not silent.** The turn records the model it actually
     ran on — that is already how `turn_spans` works — and the reply names
     the swap. A model switch the owner cannot see is how "she answered
     from a different brain" becomes invisible.

3. **100 MB**, set in nginx AND stated by the API. The v3 trap was the two
   disagreeing: the dev server accepted what the one-origin build rejected,
   so it worked everywhere except the phone. The walk goes through :3000.

4. **All four kinds**: images, text, PDFs and audio. PDFs need extraction in
   core; audio rides the same capability derivation as vision (`gemma4`
   reports it, the qwens do not). Build order is spine → images + text →
   PDFs → audio, so each lands walkable on its own rather than all four
   arriving at once.

5. Her attaching a file BACK is left for later — she can already write into
   the workspace, and this slice is about the direction that does not work.

## Audio: measured, and NOT shipped (2026-09-16)

He asked for audio and the honest answer is that this stack cannot carry it
today. Measured on the box rather than assumed, because `gemma4:12b`
advertises an `audio` capability and that is exactly the kind of claim this
project does not take at face value:

* **ollama 0.33.1, native `/api/chat`, `audio` field on the message** — the
  field is silently ignored. The model answers "please provide the audio
  file so I can tell you what sound is in it". It knows it got nothing.
* **ollama 0.33.1, OpenAI-compatible `/v1`, `input_audio` part** — accepted,
  and far worse. Given a 0.4 second 440 Hz sine tone, gemma4:12b answered:
  "a single, short word or sound... it sounds like 'Whoa'", high-pitched,
  "0.8 seconds long". Confident, detailed, entirely invented, and wrong
  about the duration too.
* **The control** — the same question with no audio at all — gets "please
  provide the audio file". So the difference is not a cautious model: the
  part makes it believe it has audio it cannot hear.

A capability the MODEL declares is not a capability the SERVER carries. The
failure shape here is the worst one available — fabrication with no signal,
about a file he sent — so audio lands in the workspace like anything else,
is named in the facts with its path, and the turn says plainly that nothing
here can listen to it. `test_audio_is_named_and_NEVER_sent_to_the_model`
holds that, and the whole request is checked for an `input_audio` part.

When ollama carries audio, this becomes a capability check exactly like
vision's — the derivation is already written, and only the "nothing here can
listen" branch has to go.

## What shipped, and what the walks found

Built in four pieces, each walked on the deployed stack before the next:
the spine (upload, workspace, binding), the turn (facts, vision routing),
the transcript (images drawn, files named), and PDFs. Audio was measured and
deliberately not shipped — see above.

**The design decision that paid off.** A file lands in the workspace she
already has tools over, so nothing needed a "hand the model the file" path
except images. The trace from the first walk is the whole argument:
`workspace_read_file {"path": "attachments/<conversation>/note.txt"} ok=true`
— she read it with the tool she already had, and the read is a fact rather
than a claim.

**Four defects, none of which any test caught.** Each one is now pinned:

1. The gateway publishes its catalogue under `rows`; core republishes it as
   `models`, and the vision helper read the wrong one. Every turn decided
   the catalogue was unreadable, so no image was ever looked at.
2. That failure was then reported as "no model installed here can see
   images" — a claim about his MACHINE when the truth was "I could not
   tell". `Choice.certain` separates them.
3. She read a PDF correctly and appended "no tool here can read PDFs...
   possibly a text file mislabeled as PDF". Both false. The facts had not
   said WHO extracted the text, and a gap in the facts is a thing a model
   fills.
4. A capability reading was ingested into her journal and recalled
   afterwards as current fact — a bug that lived for one turn became a
   belief. Turns carrying such a note are ephemeral now, the same gate a
   web fetch already used.

The first diagnosis of (4) was wrong: it looked like conversation history
repeating itself, and a clean-context probe — a cleared conversation, zero
messages — said the same sentence again. Memory is not per-conversation.
Probing before blaming the model is what turned a plausible story into the
cause.

Three poisoned journal lines from before that fix are LEFT IN PLACE (owner,
2026-09-16). `/forget` deletes whole files, so removing them would cost a
day of real conversation to delete three sentences — and the journal is a
faithful record that she said them.

**The probe, made a command.** The recall span recorded `hits: 4` — a count,
not the notes — which is why (4) had to be diagnosed by hand. It now records
the note PATHS (`meta.recalled`, never bodies), and
`tools/where-did-that-come-from.sh "a phrase"` asks the three places a
sentence can come from: the transcript, the notes recent turns recalled, and
the notes themselves.

**How it was verified, and how it was not.** Targeted core suites (187 tests
across chat, attachments, vision, conversations and settings), web at 1111,
and six live walks. NOT a full core run: the full suite wedged at about 12%,
in the chat tests, three times on 2026-09-16, and one run ignored the SIGTERM
from its own `timeout`. The hang first showed up while S25 was being gated,
before this slice began, so it is not this slice's defect — but no full-suite
number exists for this slice. Merged to `rebuild/v4` and `main` on that
evidence, at the owner's call (2026-09-17).

### Still open

Audio, if ollama gains it. Her attaching a file back to him (question 5),
which was deferred: she can already write into the workspace, and this
slice was about the direction that did not work.

The full core suite hang, above. Until it is found, no slice can show a
full-suite green, and a suite that wedges will eventually hide a real
failure.
