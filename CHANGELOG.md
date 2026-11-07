# Changelog

What changed in Nova, in plain language, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Nova's versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) on an alpha line (0.1.0-alpha.1, …).

This file is generated from docs/changelog/ by `npm run changelog`: edit the fragments there, never
this file. A change merged but not yet in a version waits at the top of docs/changelog/.

## 0.1.0-alpha.1 - 2026-11-06

### Added

- Nova is your own agent, running on your machine: you chat with it, it remembers what you let it remember, and you can see, correct, export or forget any memory. Plain files in its home folder are the source of truth.
- Setup is a short interview. After it, Nova knows your name, timezone and how you like to be spoken to, and it can tell you plainly what it is and what it is connected to.
- Schedules, helpers and skills: Nova does work at set times, hands steps to helpers, and reads skills in Claude's skill format. Everything it does is a task with its evidence, which you can look back on.
- The app works on your phone, tablet and computer, including folding phones and iPhones, with a calmer look, design systems you can switch live, and a living styleguide.
- Your devices: pair phones and computers, keep a standby copy of the hub that can take over, move the hub to another computer, and get it back from a backup.
- Other AIs and connections: OpenAI-compatible services, Claude Code, Codex and your own model command; Gmail and Home Assistant as connections; and web work in Nova's own browser that you can take over at any point.
- Capture from Screenpipe, so Nova can see what you were working on, with its status and errors said in plain words.
- Local models: Nova reads what each device can run, recommends models that fit with room to spare, and each device has a Models screen to plan, install and assign them.
- Coding, infrastructure and networking through chat, in sealed-off workspaces on this machine (Nova Computer), handing longer coding work to Relay, and a dead-man's switch that undoes a network change that cuts you off.
- A map of your computers, services and their versions, and services run and managed across your devices.
- Health shows what is working, Nova's own spending limits, and a diagnostics file for getting help that leaves out your secrets and your content.
- Settings in one list: bring them in from a file, take them out, or change them by asking Nova.
- Checkpoints, nightly backups, a restore drill and a factory reset, so a bad change or a bad day never costs you your data.

### Security

- Anything from outside (web pages, mail, imported files, captured screen text) is screened before a model reads it, and memories from outside wait for your OK.
- Keys and passwords live in a vault and are never asked for in chat; diagnostics and Nova's own answers never show them.
- A paired device can't act as you; steps that can't be undone ask first, and the riskiest ones on Nova's own screen need your passkey.
- Nova listens only on your machine and your private network, and web reading can't reach Nova itself or your private network.
