# Configuration

## Bind address and port

Setup saves the app's address and port in `.storyboard/settings.json`:

```bash
./storyboard setup --yes --host=0.0.0.0 --port=5299
./storyboard start             # if not running yet
# Or, for an already running managed app:
./storyboard restart app
```

`--ip` is an alias for `--host`; space-separated values work too (`--ip 0.0.0.0 --port 5299`). The host must be an IPv4/IPv6 address or `localhost`; the port must be 1–65535. Omitted options preserve saved choices. Existing installations without these settings still use `127.0.0.1:5199`. Interactive setup offers to start the app; `--yes` saves choices without starting it. A running app must be restarted to apply changes (Ctrl+C and restart for `npm run dev`).

With `0.0.0.0`, open `http://<server-LAN-IP>:5299` from another device, not `http://0.0.0.0:5299`. The local browser, headless captures and agent MCP calls use `http://127.0.0.1:5299`. IPv6 wildcard `--host=::` uses `[::1]` internally. Use literal IP addresses for network access; arbitrary domain names are deliberately rejected by the Host guard. Optional engines remain bound to loopback.

**There is no authentication.** Anyone who can reach the port can edit projects, read app-served files and run agents using your login. Use only a trusted network with firewall restrictions; never expose this port to the internet. Host and same-origin checks prevent DNS rebinding and cross-site browser calls, not direct access by network clients.

## Environment variables

Set these when starting, e.g. `PORT=5299 ./storyboard start`. `HOST` and `PORT` override saved setup choices for that process (including `npm run dev`); unset them to use saved choices. They are not saved by setup.

| Variable | Default | |
| --- | --- | --- |
| `HOST` | setup choice, otherwise `127.0.0.1` | App bind IP address or `localhost` |
| `PORT` | setup choice, otherwise `5199` | App port, 1–65535 |
| `STORYBOARD_PROJECTS` | `./projects` | Where projects live |
| `STORYBOARD_CHROMIUM_SANDBOX` | on (macOS) | `off` turns off headless Chromium's sandbox; only for a shell that is already sandboxed, where pages would otherwise crash |
| `STORYBOARD_PROVIDER` | setup choice, otherwise first available (Claude Code first) | `claude-code` or `codex`; the editor can switch per message |
| `STORYBOARD_MODEL` | selected provider's default | Model override for the default provider |
| `STORYBOARD_CLAUDE_MODEL` | `claude-opus-5-5` | Claude Code's default model |
| `STORYBOARD_CODEX_MODEL` | `default` | Codex's default model; `default` lets the CLI choose. An explicit model id also appears in the selector |
| `STORYBOARD_EFFORT` | `medium` | Default effort (the UI remembers your choice) |
| `CLAUDE_PATH` / `CODEX_PATH` / `FFMPEG_PATH` | `claude` / `codex` / `ffmpeg` | Binaries |
| `CODEX_HOME` | `~/.codex` | Existing Codex login, sessions and model catalog; Storyboard never copies credentials |
| `STORYBOARD_USE_API_KEY` | unset | By default inherited `ANTHROPIC_API_KEY` (Claude) and `OPENAI_API_KEY` / `CODEX_API_KEY` (Codex) are removed so the CLI uses its saved login; set this to keep them. A Codex API-key login saved by `codex login` is still used |
| `STORYBOARD_AGENT_LOG` | unset | Path of a file to append the agent's raw JSONL events to (debugging) |
| `STORYBOARD_MUSIC_URL` / `STORYBOARD_SFX_URL` | `http://127.0.0.1:8001` / `:8002` | Where the engines answer. Point one at another machine to run the engine there |
| `STORYBOARD_MUSIC_API_KEY` / `STORYBOARD_SFX_API_KEY` | a random key in `.storyboard/keys/` | The engines' API keys (set them when an engine runs elsewhere) |

## Agent choices

Setup stores the default provider in `.storyboard/settings.json`; `STORYBOARD_PROVIDER` takes precedence. The editor remembers your provider and each provider's model/effort separately in local storage. Switching providers starts a new provider session with recent chat messages as context; it never sends a Claude session id to Codex or vice versa. **Clear chat** clears that session and history.

Codex models and their supported reasoning levels come from `$CODEX_HOME/models_cache.json`, maintained by the Codex CLI. If the catalog is missing, **Codex default** still works. Run `codex` to refresh its catalog, then reload the editor. Use `STORYBOARD_CODEX_MODEL` for an explicit model not yet in the catalog. In-app Codex ignores user configuration and exec-policy rules, so set model overrides through Storyboard rather than `~/.codex/config.toml`.

## Where things live

Everything Storyboard installs stays in its folder, so deleting the folder removes all of it (after `./storyboard stop`). The only things setup puts elsewhere are system tools you agree to install (such as ffmpeg with Homebrew).

```
storyboard              the command-line tool
projects/               your projects (git ignores all but the example); set STORYBOARD_PROJECTS to keep them elsewhere
engines/music/          the music engine, if turned on: ACE-Step 1.5, its Python environment and models
engines/sfx/            the sound-effects engine; setup adds its Python environment (.venv) and model (models/)
.storyboard/            settings.json (your setup choices), uv and its Python, headless Chromium, logs, engine keys
```

Each project:

```
projects/<id>/
  project.json          name, canvas, fps, scene order + durations, soundtrack reference
  scenes/<scene>.tsx    one component per scene
  components/           optional shared components
  assets/               images and SVGs (asset('file.png'))
  art-direction.md      the look every scene follows
  music/                soundtrack takes (takes.json) with cached beat analysis
  sounds/               sound effects: your audio files, sounds.json (synth recipes and generated sounds), generated/
  renders/              exported MP4s
  .storyboard/          chats, undo snapshots, frames the agent looked at (internal)
```
