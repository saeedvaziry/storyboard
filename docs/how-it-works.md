# How it works

```
Editor (React, Vite)  ── SSE ──┐
Scene frames (iframes) ─ HMR ──┤
                               │
Node server ── Vite (dev) ─────┤  /api  REST           server/api.ts
            ├─ ProjectStore     │  /mcp  MCP tools      server/mcp.ts
            ├─ Capturer (headless Chromium: frames, seams)      server/capture.ts
            ├─ Renderer (parallel pages → ffmpeg H.264 + mixed audio) server/render.ts
            ├─ Music analysis (beats, bars, phrases, sections)  server/music/
            ├─ Sound effects (library, synth, mixer, check_audio) server/sound/
            └─ ChatManager → AgentProvider (Claude Code or Codex headless) server/chat.ts, server/agents/
```

- **Scenes** (`projects/<id>/scenes/*.tsx`) import helpers from `storyboard` (`src/runtime/`): `progress`, `interpolate`, `keyframes`, `spring`, easings, colors, seeded `random`/`noise`, `SplitText`, and the `music` beat grid. Every frame is a pure function of `t`, so scrubbing, rendering and seam checks are exact.
- **`frame.html`** (`src/frame/main.tsx`) loads a project's scenes and renders any time on demand. The editor preview, the thumbnails, the agent's `render_frames` and the MP4 renderer all use this same page, so what you see is what renders. It also evaluates each scene's `sounds` export into cues in video time, which the preview, `check_audio` and the renderer mix the same way (`server/sound/mix.ts`, `src/editor/audio.ts`).
- **The agents** are your local Claude Code (`claude -p --output-format stream-json --restricted --permission-mode dontAsk --allowedTools …`) or Codex (`codex exec --json --ignore-user-config --ignore-rules`), using their saved logins and the same Storyboard MCP tools. Both can research public websites in project and scene chats: Claude uses `WebSearch` and `WebFetch`; Codex uses live web search. Claude uses per-file permission rules. Codex runs in a read-only sandbox, without shell tools, and edits through scoped MCP file tools. Each chat keeps a provider-tagged session; switching providers starts fresh with recent chat context. **Clear chat** forgets the session.
- **Undo**: before each turn the project's code is snapshotted to `.storyboard/undo/`; Undo restores the files that turn changed.

## Security

Storyboard is a single-user tool. It listens on `127.0.0.1` by default; setup can explicitly save a different bind address and port. `/api` and `/mcp` accept loopback or the bound IP address in `Host` (preventing DNS rebinding), and reject browser requests from other websites or other ports (CSRF), since those could start agent turns. **There is no authentication:** a network bind gives anyone who can connect access to projects and agent execution using your login. Use only a trusted network/firewall, never the public internet; the request guards are not access control for direct network clients. The in-app agents can only write project code in their allowed scope, and a scene chat only that scene's file. Codex runs from an app-owned root in `.storyboard/agents/codex` to avoid discovering a project's `.codex` configuration. Its shell, apps, hooks, plugins and sub-agents are disabled; direct file changes are blocked by the read-only sandbox. Web access uses the providers' built-in research tools. Its MCP file tools reject traversal, symlinks, hidden files, internal state and `project.json` writes. Both providers' MCP requests carry project/scene headers, checked again by the server. Terminal sessions use the permissions you configure in the CLI instead of the in-app restrictions.
