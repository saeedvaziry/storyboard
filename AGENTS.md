# Storyboard — notes for coding agents

This file is for AI coding agents working on this repository (Claude Code reads it through `CLAUDE.md`). People: start with [README.md](README.md); the details are in [docs/](docs/).

If you are editing a **video project** under `projects/`, follow `projects/CLAUDE.md` or `projects/AGENTS.md` instead (the app writes it when it starts); this file is about developing the Storyboard app itself.

## Safety rules (always)

- **Install dependencies with `./storyboard setup` (which runs `npm ci --ignore-scripts`) or `npm ci --ignore-scripts` only.** Never run `npm install` to set up or repair the project, and never run `npm ci`/`npm install` without `--ignore-scripts`: package install scripts execute arbitrary code on the user's machine, and `npm install` can pull versions that aren't in `package-lock.json`. The repo's `.npmrc` sets `ignore-scripts=true` as a backstop, not as a replacement for the flag.
- Add or upgrade a dependency only when the user asks, with `npm install --ignore-scripts <package>@<version>`, and show them the `package-lock.json` diff.
- Don't use `npx` to fetch packages that aren't already in `node_modules`; run project tools through the `npm run` scripts.
- Never stop or restart processes you didn't start. The user may have their own Storyboard running. `./storyboard stop` and `restart` stop the user's services too when they started them with `./storyboard start`, so run those only when the user asks.

## Set up a fresh clone

```bash
./storyboard setup --yes   # npm ci --ignore-scripts, headless Chromium (into .storyboard/), checks; asks nothing
./storyboard doctor        # checks Node, ffmpeg, Chromium, a Claude Code or Codex login and the port; exits 1 while something is missing
./storyboard start         # the app in the background → http://127.0.0.1:5199 (or `npm run dev` in the background while developing)
```

- `./storyboard setup` without `--yes` is interactive (arrow-key questions); that's for the user. With `--yes` it keeps the user's current choices and never deletes anything.
- `./storyboard doctor` prints the fix for each problem. System tools (Node.js 22.12+, ffmpeg, Claude Code or Codex) are the user's machine: tell them what's missing and install it only if they ask you to.
- Only the user can log in to the agent. If doctor reports "not logged in", ask them to run `claude auth login` or `codex login` in a terminal. Setup accepts `--provider=claude-code|codex`; either agent is enough.
- If port 5199 is taken, doctor says whether Storyboard is already running there; run yours with `PORT=5299 npm run dev`.
- It works when `curl -s http://127.0.0.1:5199/api/projects` lists the "Example: Storyboard teaser" project.
- The music and sound-effects engines are optional and large (music: about 20 GB of models and 9–16 GB of memory while running; sound effects: a 5 GB model gated on Hugging Face). Turn them on only when the user asks: `./storyboard setup --yes --music=on` / `--sfx=on` (sound effects also need `HF_TOKEN` from the user, or the interactive setup, which walks them through Hugging Face). The synth sound effects need neither.
- Everything setup installs stays in the app folder: `.storyboard/` (settings, pinned uv and its Python, Chromium, logs, PID files, engine keys) and `engines/` (git-ignored installs). Nothing goes to `~/.cache`, `~/.config` or `~/Tools`.

## Run & check

- `npm run dev` starts one process in the foreground: Vite (editor + scene frames) in middleware mode, the REST API (`/api`), SSE (`/api/events`) and the MCP server (`/mcp`). `./storyboard start` runs the same process in the background (log: `./storyboard logs`). Server code isn't hot-reloaded; restart after editing `server/`.
- `npm run typecheck` (TypeScript 7, covers `src/`, `server/` and project scenes), `npm test` (node:test) and `npm run format` (Prettier, width 130; CI runs `npm run format:check`).
- `npm run analyze -- <audio>` runs the music analyzer on a file.

## Map

- `src/runtime/` — the `storyboard` module scenes import (easing, interpolate, spring, color, random, music grid, components). Keep it deterministic: frames are rendered out of order.
- `src/frame/main.tsx` — `frame.html`: loads a project's scenes, renders any time, exposes `window.__sb` (`src/shared/frameApi.ts`). Used by the editor, thumbnails, agent captures and renders alike.
- `src/editor/` — React UI; state in `store.ts` (zustand), server events in `events.ts`, preview audio (soundtrack + sound cues on one Web Audio clock) in `audio.ts`.
- `src/shared/types.ts` — shapes shared by server, editor and runtime; `cues.ts` validates the cues of a scene's `sounds` export.
- `server/index.ts` wires everything; `projects.ts` (files on disk, code generations), `vite.ts`, `capture.ts` (Playwright), `render.ts` (ffmpeg), `seams.ts`, `mcp.ts` (tools + scope enforcement), `chat.ts` (turns, undo, streaming to the UI), `agents/` (provider registry, Claude Code and Codex headless providers, scoped file tools, prompts), `music/` (beat/bar/phrase analysis; `engine.ts` watches the ACE-Step engine and is its REST client, `library.ts` stores takes, `service.ts` runs generation jobs and describes takes for the agent), `sound/` (sound effects: `library.ts` keeps `sounds/` — synth recipes and generated sounds in `sounds.json` plus the user's audio files — rendered to cached 48 kHz WAVs and measured; `synth.ts`/`dsp.ts` are the presets; `mix.ts` places cues and mixes them with the soundtrack for renders and `check_audio`; `analysis.ts` measures how each cue cuts through the mix; `service.ts` backs the tools; `engine.ts` watches the Stable Audio engine and is its client; the engine itself is the uv-locked Python project in `engines/sfx/`), `templates.ts` (starter scene, art direction, and the scene guide written to `projects/CLAUDE.md` and `projects/AGENTS.md`), `doctor.ts` (`./storyboard doctor`), `settings.ts` (the choices made in setup), `cli/` (the `./storyboard` command: `main.ts` routes the commands, `setup.ts` is the interactive setup, `services.ts` starts/stops/watches the app and the engines through PID files, `music.ts`/`sfx.ts` install the engines, `uv.ts` fetches the pinned, checksum-verified uv, `chromium.ts` does the same for the headless Chromium pinned in `server/chromium.ts`; the look is `ui.ts` (the rail, spinners, progress bars) and `prompt.ts` (questions), `tasks.ts` runs programs as one-line steps with their output in `.storyboard/logs/setup.log`, `input.ts` holds the keyboard so stray keys can't break the redrawn lines). `storyboard` in the repo root is the bash launcher: it checks Node.js, runs `npm ci --ignore-scripts` on a fresh clone and hands over to `server/cli/main.ts`.

## Conventions

- Scene code changes reach frames through `ProjectStore.syncCode` → Vite module invalidation → a bumped `codeGeneration` → frames re-import. Don't rely on Vite HMR for files under `projects/`.
- The in-app agents skip instruction-file discovery (Claude: `--restricted`; Codex: `project_doc_max_bytes=0`), so the scene guide is inlined in their system prompts (`agents/prompts.ts`). Keep `SCENE_GUIDE` in `templates.ts` the single source.
- Providers normalize tool events to `mcp__storyboard__<tool>` (Codex may discover them through `tool_search`); scene chats may only use the tools in `SCENE_TOOLS` (`agents/tools.ts`) plus Codex’s scoped `FILE_TOOLS` and the MCP server re-checks scope from the `X-Storyboard-*` headers.
- Both in-app agents can research public websites (Claude: `WebSearch`/`WebFetch`; Codex: live web search). Codex runs with a read-only sandbox from an app-owned root, with shell tools, hooks, plugins and sub-agents disabled. Writes go through `agents/files.ts`; keep scene/project scope, traversal and symlink checks. Never use approval or sandbox bypass flags. Chat sessions are tagged with their provider and must never be resumed by another provider.
- Music tools are registered in `mcp.ts` only while `MusicEngine.isReady()` and never for scene chats; the per-turn context says whether the engine runs, or that the user turned it off in setup (then the agent shouldn't offer it). The app never starts or stops the engines; `./storyboard start|stop` does.
- Everything the CLI installs goes inside the app folder (paths in `server/config.ts`); engine processes get `XDG_CACHE_HOME`/`HF_HOME` in their own folder (`engineEnv` in `cli/services.ts`). Keep it that way: nothing in `~/.cache`, `~/.config` or elsewhere in the home folder. The ACE-Step commit (`cli/music.ts`), the uv release and its SHA-256 (`cli/uv.ts`) and the headless Chromium build and its SHA-256s (`chromium.ts`) are pinned; bump them deliberately. Chromium is Google's stable Chrome for Testing, not the browser Playwright installs, because Playwright's builds miss stable security fixes; launch it only with `chromiumLaunchOptions()`.
- Sound cues come from each scene's `sounds` export, evaluated by the frame (`window.__sb.sounds()`). The preview (`src/editor/audio.ts`) and the server mixer (`server/sound/mix.ts`) must place cues the same way (align/peak, pitch as playback rate, the StereoPannerNode pan law), so change them together. Bump `SYNTH_VERSION` whenever a preset's output changes (cached renders are keyed by it). `generate_sound` exists only while `SfxEngine.isReady()`; scene chats may add sounds but never replace them. `sounds/sounds.json` is tracked by undo, and synth audio follows it.
- `/api` and `/mcp` accept only loopback/bound-IP Host headers and same-origin browser requests (`server/network.ts`, applied in `server/index.ts`); requests from other websites could otherwise start agent turns. Keep new endpoints behind that guard. Setup can opt into a network bind (`--host`/`--ip`, `--port`); there is no authentication, so keep the network-exposure warning. Internal capture/MCP URLs must use a connectable address, not a wildcard.
- Only `projects/example/` is tracked by git; every other project folder is the user's own and ignored.
