import path from 'node:path';
import { LOCAL_DIR, ROOT } from './paths';
import { networkConfig } from './network';
import { readSettings } from './settings';

export { LOCAL_DIR, ROOT, SETTINGS_FILE } from './paths';
export const PROJECTS_DIR = path.resolve(process.env.STORYBOARD_PROJECTS ?? path.join(ROOT, 'projects'));
export let { host: HOST, port: PORT, baseUrl: BASE_URL } = networkConfig(readSettings());
export let MCP_URL = `${BASE_URL}/mcp`;

/** Setup can start the app in this same process after saving new network choices. */
export function reloadNetworkConfig() {
  ({ host: HOST, port: PORT, baseUrl: BASE_URL } = networkConfig(readSettings()));
  MCP_URL = `${BASE_URL}/mcp`;
}

/**
 * Everything `./storyboard` installs or keeps for this machine lives in the app folder (git-ignored):
 * the choices made in setup, uv and its Python, headless Chromium, the engines' API keys, PID files and logs.
 */
export const LOG_DIR = path.join(LOCAL_DIR, 'logs');
export const RUN_DIR = path.join(LOCAL_DIR, 'run');
export const KEYS_DIR = path.join(LOCAL_DIR, 'keys');
export const BROWSERS_DIR = path.join(LOCAL_DIR, 'browsers');

/** Music engine (ACE-Step's REST API). Local by default; point it at another machine later. */
export const MUSIC_URL = (process.env.STORYBOARD_MUSIC_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '');
/** The local ACE-Step install made by `./storyboard setup`: its code, Python environment and checkpoints. */
export const MUSIC_DIR = path.join(ROOT, 'engines', 'music');
export const MUSIC_PYTHON = path.join(MUSIC_DIR, '.venv', 'bin', 'python');
/** Shared secret between Storyboard and the engine; created on first use. */
export const MUSIC_KEY_FILE = path.join(KEYS_DIR, 'music');

/** Sound-effects engine (Stable Audio Open behind engines/sfx/server.py). Local by default. */
export const SFX_URL = (process.env.STORYBOARD_SFX_URL ?? 'http://127.0.0.1:8002').replace(/\/+$/, '');
/** The engine's Python project (pyproject.toml, uv.lock, server.py); setup adds its .venv and the model. */
export const SFX_DIR = path.join(ROOT, 'engines', 'sfx');
export const SFX_PYTHON = path.join(SFX_DIR, '.venv', 'bin', 'python');
/** The Hugging Face cache holding Stable Audio Open (server.py points HF_HUB_CACHE here). */
export const SFX_MODELS_DIR = path.join(SFX_DIR, 'models');
/** Shared secret between Storyboard and the sound-effects engine; created on first use. */
export const SFX_KEY_FILE = path.join(KEYS_DIR, 'sfx');

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const CLAUDE_BIN = process.env.CLAUDE_PATH ?? 'claude';
export const CODEX_BIN = process.env.CODEX_PATH ?? 'codex';

/** Provider-specific defaults; STORYBOARD_MODEL overrides the default provider's model. */
export const DEFAULT_CLAUDE_MODEL = process.env.STORYBOARD_CLAUDE_MODEL ?? 'claude-opus-5-5';
export const DEFAULT_CODEX_MODEL = process.env.STORYBOARD_CODEX_MODEL ?? 'default';
export const DEFAULT_EFFORT = process.env.STORYBOARD_EFFORT ?? 'medium';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Frames sent to the agent: 960×540 JPEG keeps a batch of frames well under MCP output limits. */
export const AGENT_FRAME_SCALE = 0.5;
export const AGENT_FRAME_QUALITY = 82;
export const MAX_FRAMES_PER_CALL = 8;

/** Internal per-project folder (chats, undo snapshots, captured frames). */
export const INTERNAL_DIR = '.storyboard';
