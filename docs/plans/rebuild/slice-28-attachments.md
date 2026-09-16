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
