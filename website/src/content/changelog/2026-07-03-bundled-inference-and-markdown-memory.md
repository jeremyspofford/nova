---
title: "Bundled inference containers return; memory goes all-in on markdown"
date: 2026-07-03
---

Two structural changes land together: Nova can run local inference itself again, and the legacy engram memory backend is gone.

**Bundled local inference (hybrid).** Four inference servers now ship as opt-in Docker Compose profiles — **Ollama**, **vLLM**, **SGLang**, and **llama.cpp** — started and stopped from Settings → Local Inference (or `COMPOSE_PROFILES` in `.env`). External servers keep working exactly as before; LM Studio and Custom endpoints stay external-only.

- Several containers can be warm at once; the active backend selection switches instantly between them (the gateway just swaps its routing URL).
- Model storage is configurable: point `OLLAMA_MODELS_DIR` at an existing `~/.ollama`, `HF_CACHE_DIR` at your HuggingFace cache, or `LLAMACPP_MODELS_DIR` at a GGUF folder — no re-downloading.
- GPU acceleration comes from a `docker-compose.gpu.yml` overlay that the installer activates only after positive NVIDIA detection. vLLM/SGLang starts are refused on CPU-only hosts with an actionable message; Ollama and llama.cpp run fine on CPU.
- The recovery service owns the container lifecycle and writes/clears the in-network routing URL on start/stop — which also fixes the long-standing stale-`inference.url` bug after backend switches.
- The `./install` wizard's "All-in-one" mode now actually works: it enables the bundled Ollama profile, prompts for the model directory, detects GPUs, warns about port 11434 collisions with a host-run Ollama, and pulls the default model.

**Engram memory backend removed.** The OKF markdown bundle — a folder of markdown files with OKF frontmatter, BM25 retrieval, no embeddings, no Postgres — is now Nova's only built-in memory backend (external providers can still plug in via `memory.provider_url`). Removing the frozen pgvector graph deleted ~14k lines: the engram engine, its 20+ Postgres tables' worth of schema, the 3D Brain visualization, and the engram-only dashboard surfaces (Sources domain summary, User Profile, Memory Health, Consolidation/Self-Model settings). Backups now capture the memory folder itself — memory lives in files, and `pg_dump` alone would miss it. Your memory is a directory you can `cat`, `grep`, and `git`.
