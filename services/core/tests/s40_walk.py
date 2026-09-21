"""The three replies the S40 live walk caught (2026-09-19), kept verbatim for
every S40b pin that must hold on the real text rather than a paraphrase of it.

Verbatim except for one substitution: the GPU id each machine block quoted is
the owner's real card, and this repository is public, so it reads
`cuda:GPU-<uuid>` here. Nothing any guard reads depends on those characters.

  * B851AA91 — she called machine_status this turn and relayed it. Its machine
    lines are backed by that read; its "Current model in use" line is false
    (the round was served by hub:qwen3:8b).
  * B02A5694 — the same question asked again: she REPLAYED B851AA91's reading
    from history without checking anything. `Last Reported` is the earlier
    turn's timestamp, stated as the current status.
  * T60834CCF — "What's 17 times 23?", answered by a model that then said no
    model was needed.
"""

from __future__ import annotations

B851AA91 = (
    "The models run on a machine called **`hub`**, which is currently **ready and active**. "
    "Here's the breakdown:\n"
    "\n"
    "### 🏗️ **Machine Status**\n"
    "- **Name**: `hub`  \n"
    "- **Serving**: ✅ **On** (always on)  \n"
    "- **Compute**: Uses GPU `cuda:GPU-<uuid>`  \n"
    "- **Runtime**: Containerized (Docker/OCI-compatible)  \n"
    "- **Last Reported**: `2026-09-19T05:15:39+00:00`  \n"
    "\n"
    "### 🧠 **Installed Models** (on `hub`)\n"
    "- `gemma4:12b` (7.0 GB)  \n"
    "- `gemma4:31b` (18.5 GB)  \n"
    "- `hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:latest` (14.6 GB)  \n"
    "- `muse-glimmer:latest` (16.9 GB)  \n"
    "- `nomic-embed-text:latest` (0.3 GB)  \n"
    "- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use**  \n"
    "- `qwen3:8b` (4.9 GB)  \n"
    "\n"
    "### 🚨 **Critical Check**\n"
    "- The **memory service** (`memory`) is currently unreachable (`ConnectError`), but this "
    "is unrelated to the model-running machine (`hub`). It might affect long-term memory "
    "operations but not model execution.  \n"
    "\n"
    "Would you like to check if a specific model (e.g., `qwen3.8:27b`) is fully loaded or "
    "needs restarting?"
)

B02A5694 = (
    "The models run on a machine called **`hub`**, and its current status is:  \n"
    "\n"
    "### 🏗️ **Machine Status**  \n"
    "- **Name**: `hub`  \n"
    "- **Serving**: ✅ **On** (always on)  \n"
    "- **Compute**: Uses GPU `cuda:GPU-<uuid>`  \n"
    "- **Runtime**: Containerized (Docker/OCI-compatible)  \n"
    "- **Last Reported**: `2026-09-19T05:15:39+00:00`  \n"
    "\n"
    "### 🧠 **Installed Models** (on `hub`)  \n"
    "- `gemma4:12b` (7.0 GB)  \n"
    "- `gemma4:31b` (18.5 GB)  \n"
    "- `hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:latest` (14.6 GB)  \n"
    "- `muse-glimmer:latest` (16.9 GB)  \n"
    "- `nomic-embed-text:latest` (0.3 GB)  \n"
    "- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use**  \n"
    "- `qwen3:8b` (4.9 GB)  \n"
    "\n"
    "### ⚠️ **Critical Check**  \n"
    "- The **memory service** (`memory`) is currently unreachable (`ConnectError`), but this "
    "is unrelated to the model-running machine (`hub`). It might affect long-term memory "
    "operations but not model execution.  \n"
    "\n"
    "Would you like to check if a specific model (e.g., `qwen3.8:27b`) is fully loaded or "
    "needs restarting?"
)

T60834CCF = (
    "17 multiplied by 23 is **391**. \n"
    "\n"
    "No model was needed for this calculation. Let me know if you need help with anything else!"
)
