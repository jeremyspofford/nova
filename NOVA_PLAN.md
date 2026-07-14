# Nova Project Roadmap (Greenfield Rewrite)

## Overview

This document outlines the plan for the greenfield rewrite of the Nova AI agent harness. The goal is to create a simple, intuitive chat application similar to ChatGPT or Claude, featuring model selection and an engaging UI.

## Phase 1: Repository Cleanup

- [ ] Remove all existing files from the repository to ensure a clean slate.

## Phase 2: Core Functionality & UI

- [ ] **Basic Chat Interface**: Implement a clean, minimal chat UI.
- [ ] **Model Selection**: Add functionality to allow users to switch between different AI models.
- [ ] **Messaging System**:
  - [ ] Implement message sending capability.
  - [ ] Implement receiving responses from the selected model.
- [ ] **UI/UX Polish**:
  - [ ] Implement "chat bubble" animations.
  - [ ] Add visual indicators (e.g., bouncing bubbles) to signal the AI is responding.

## Phase 3: Future Enhancements (TBD)

### Agent Capabilities

- [ ] **Device Control Agent** — investigate letting a Nova agent control the user's devices.
  - Targets: Android, iPhone, macOS, Linux desktop, Windows desktop, and WSL instances on Windows.
  - Likely shape: a common "computer use" loop (screenshot → reason → click/type/keypress) with per-platform drivers:
    - Android: ADB over USB or Wi-Fi — mature tooling, easiest mobile target.
    - iPhone: hardest — Appium/WebDriverAgent requires a developer certificate; Apple Shortcuts can cover narrow automations. Needs dedicated research.
    - macOS: AppleScript/JXA for app-level control, screen-based control (e.g. cliclick) for everything else.
    - Linux: xdotool (X11) / ydotool (Wayland) plus screenshots.
    - Windows: UI Automation (pywinauto) or screen-based control. WSL is the easy case — plain SSH/shell access, no GUI layer needed.
  - Prior art to evaluate: Anthropic computer-use reference implementation, mobile-control MCP servers, Appium.
  - Must route through the consent/approval gate — this is the highest-risk capability on the roadmap.

- [ ] **YouTube Comprehension** — let an agent read/view and learn from YouTube videos (research needed).
  - Transcript-first: pull captions (yt-dlp or a transcript API) — cheap and covers most videos.
  - Fallback ASR: local Whisper when captions are missing (fits the local-first principle).
  - Visual track: keyframe extraction + a vision model for demos/slides where the transcript isn't enough.
  - Decide the learning/storage model: summarize into memory vs. index the full transcript for retrieval.
  - Check YouTube ToS implications of downloading vs. streaming.

- [ ] **Coding Agent(s)** — plan for coding capability.
  - Open question: one general coding agent vs. specialized agents (implementer, code reviewer, software architect) vs. a fleet.
  - Recommended starting point: one general coding agent with strong tools (repo access, shell, file editing, test runner), then layer specializations as roles/personas on the same harness instead of building many bespoke agents.
  - Needs a sandboxing story (containerized workspaces) and git discipline (work on branches/PRs, never direct-to-main).

- [ ] **Diagramming Agent** — generate and iterate on diagrams.
  - Output formats: Mermaid as the workhorse (flowchart, sequence, ER, state, gantt); raw SVG for freeform drawings; consider Graphviz/DOT and D2 for graph layouts, and Excalidraw/draw.io formats when the user wants hand-editable output.
  - Skills: architecture diagrams from a codebase, ER diagrams from a database schema, sequence diagrams from logs or traces.
  - Needs a render–verify loop: render the diagram, inspect the result with vision, self-correct — text-only generation fails silently on layout (overlaps, unreadable labels).
  - Chat integration: render to SVG/PNG inline in the chat UI.
