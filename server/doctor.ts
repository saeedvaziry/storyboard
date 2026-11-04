// Checks that everything Storyboard needs is in place:  ./storyboard doctor  (or npm run doctor)
// Exits with 1 while something required is missing, so agents can use it as a setup gate.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromiumLaunchOptions } from './chromium';
import { BASE_URL, CLAUDE_BIN, FFMPEG, HOST, MUSIC_URL, PORT, PROJECTS_DIR, ROOT, SFX_URL } from './config';
import { engineHealth, engineInstalled, isLocalUrl } from './music/engine';
import { preferredProvider, readSettings } from './settings';
import { CodexProvider } from './agents/codex';
import { rail, Task } from './cli/ui';
import { sfxEngineHealth, sfxEngineInstalled, sfxModelDownloaded } from './sound/engine';

const execFileAsync = promisify(execFile);

export interface Check {
  /** fail: Storyboard can't work until it's fixed · warn: works, with a caveat · info: optional extras. */
  level: 'ok' | 'fail' | 'warn' | 'info';
  label: string;
  fix?: string;
}

let alreadyRunning = false;

export function checkNode(): Check {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12)
    ? { level: 'ok', label: `Node.js ${process.versions.node}` }
    : {
        level: 'fail',
        label: `Node.js ${process.versions.node} is too old`,
        fix: 'Install Node.js 22.12 or newer (nvm install reads .nvmrc)',
      };
}

export async function checkFfmpeg(): Promise<Check> {
  let version: string;
  try {
    const { stdout } = await execFileAsync(FFMPEG, ['-version']);
    version = stdout.match(/ffmpeg version (\S+)/)?.[1] ?? '';
  } catch {
    return {
      level: 'fail',
      label: `ffmpeg not found (${FFMPEG})`,
      fix: './storyboard setup installs it (or: brew install ffmpeg · sudo apt install ffmpeg)',
    };
  }
  // Renders are H.264 with AAC audio.
  const { stdout: encoders } = await execFileAsync(FFMPEG, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 });
  const missing = ['libx264', 'aac'].filter((name) => !new RegExp(`\\s${name}\\s`).test(encoders));
  return missing.length
    ? {
        level: 'fail',
        label: `ffmpeg ${version} has no ${missing.join(' or ')} encoder`,
        fix: 'Install an ffmpeg build that includes libx264 (e.g. brew install ffmpeg)',
      }
    : { level: 'ok', label: `ffmpeg ${version}` };
}

export async function checkChromium(): Promise<Check> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      // Open a page too: with the sandbox nested inside another one, Chromium starts but every page crashes.
      await browser.newPage();
      return { level: 'ok', label: `Headless Chromium ${browser.version()}` };
    } finally {
      await browser.close();
    }
  } catch (e) {
    const message = (e as Error).message;
    if (/Executable doesn't exist/i.test(message)) {
      return { level: 'fail', label: 'Headless Chromium is not installed', fix: './storyboard setup' };
    }
    if (/Target crashed/i.test(message)) {
      return {
        level: 'fail',
        label: 'Headless Chromium crashes when it opens a page',
        fix: 'If this shell is itself sandboxed, set STORYBOARD_CHROMIUM_SANDBOX=off',
      };
    }
    return {
      level: 'fail',
      label: `Headless Chromium does not start: ${message.split('\n')[0]}`,
      fix: './storyboard setup',
    };
  }
}

/** Claude Code's status: `installed` false when it isn't found, `loggedIn` null when the login couldn't be checked. */
export async function claudeStatus(): Promise<{
  installed: boolean;
  version?: string;
  loggedIn: boolean | null;
  method?: string;
}> {
  let version: string;
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { timeout: 15000 });
    version = stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? stdout.trim();
  } catch {
    return { installed: false, loggedIn: false };
  }
  // The same environment the in-app agent gets (agents/claudeCode.ts): your login, not ANTHROPIC_API_KEY.
  const env = { ...process.env };
  if (!process.env.STORYBOARD_USE_API_KEY) delete env.ANTHROPIC_API_KEY;
  let output = '';
  try {
    output = (await execFileAsync(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 15000, env })).stdout;
  } catch (e) {
    // Exits with 1 when logged out, still printing the status.
    output = (e as { stdout?: string }).stdout ?? '';
  }
  try {
    const status = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string };
    return { installed: true, version, loggedIn: Boolean(status.loggedIn), method: status.authMethod };
  } catch {
    return { installed: true, version, loggedIn: null };
  }
}

export async function checkClaude(): Promise<Check> {
  const status = await claudeStatus();
  if (!status.installed) {
    return {
      level: 'fail',
      label: `Claude Code not found (${CLAUDE_BIN})`,
      fix: './storyboard setup installs it (or see https://code.claude.com), then: claude auth login',
    };
  }
  if (status.loggedIn === null) {
    return {
      level: 'warn',
      label: `Claude Code ${status.version} (could not check the login)`,
      fix: 'If the chat says "Not logged in", run: claude auth login',
    };
  }
  return status.loggedIn
    ? { level: 'ok', label: `Claude Code ${status.version}, logged in${status.method ? ` (${status.method})` : ''}` }
    : { level: 'fail', label: `Claude Code ${status.version} is not logged in`, fix: 'Run: claude auth login' };
}

export async function checkCodex(): Promise<Check> {
  const status = await new CodexProvider().status();
  return status.ok
    ? {
        level: status.detail ? 'warn' : 'ok',
        label: `${status.version ?? 'Codex'}${status.detail ? '' : ', logged in'}`,
        fix: status.detail,
      }
    : { level: 'fail', label: 'Codex is not ready', fix: status.detail };
}

/** Only one agent is required; an unused provider must not block a Codex-only or Claude-only setup. */
export async function checkAgents(): Promise<Check> {
  const preferred = preferredProvider();
  if (preferred) return preferred === 'codex' ? checkCodex() : checkClaude();
  const [claude, codex] = await Promise.all([checkClaude(), checkCodex()]);
  if (claude.level === 'ok') return claude;
  if (codex.level === 'ok') return codex;
  if (claude.level === 'warn') return claude;
  if (codex.level === 'warn') return codex;
  return { level: 'fail', label: 'No agent is ready (Claude Code or Codex)', fix: `${claude.fix}\n${codex.fix}` };
}

async function checkPort(): Promise<Check> {
  const free = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(PORT, HOST, () => server.close(() => resolve(true)));
  });
  if (free) return { level: 'ok', label: `Port ${PORT} is free` };
  alreadyRunning = await fetch(`${BASE_URL}/api/info`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => res.ok && 'projectsDir' in ((await res.json()) as object))
    .catch(() => false);
  return alreadyRunning
    ? { level: 'info', label: `Storyboard is already running at ${BASE_URL}` }
    : {
        level: 'warn',
        label: `Port ${PORT} is used by another program`,
        fix: 'Start on another port: PORT=5299 ./storyboard start',
      };
}

function checkProjects(): Check {
  const rel = path.relative(ROOT, PROJECTS_DIR);
  const shown = rel.startsWith('..') || path.isAbsolute(rel) ? PROJECTS_DIR : `./${rel}`;
  try {
    const count = fs.readdirSync(PROJECTS_DIR).filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, 'project.json'))).length;
    return { level: 'info', label: `Projects in ${shown} (${count})` };
  } catch {
    return { level: 'info', label: `Projects in ${shown} (created on first start)` };
  }
}

/** An optional engine: off, on but not installed, stopped or running. */
async function checkEngine(
  name: string,
  on: boolean | undefined,
  url: string,
  installed: boolean,
  health: () => Promise<string | null>,
  service: string,
): Promise<Check> {
  const state = await health();
  if (state) return { level: 'info', label: `${name}: ${state} at ${url}` };
  if (!isLocalUrl(url)) return { level: 'info', label: `${name}: not answering at ${url}` };
  if (on === undefined)
    return { level: 'info', label: `${name} (optional): not set up`, fix: './storyboard setup asks about it' };
  if (!on) return { level: 'info', label: `${name} (optional): off`, fix: './storyboard setup turns it on' };
  if (!installed)
    return { level: 'warn', label: `${name}: on, but not installed`, fix: './storyboard setup finishes installing it' };
  return { level: 'info', label: `${name}: installed, stopped`, fix: `./storyboard start ${service}` };
}

const checkMusic = () =>
  checkEngine(
    'Music generation',
    readSettings()?.music,
    MUSIC_URL,
    engineInstalled(),
    async () => {
      const h = await engineHealth();
      return h ? (h.initialized ? 'running' : 'loading models') : null;
    },
    'music',
  );

const checkSfx = () =>
  checkEngine(
    'Sound-effects generation',
    readSettings()?.sfx,
    SFX_URL,
    sfxEngineInstalled() && sfxModelDownloaded(),
    async () => {
      const h = await sfxEngineHealth();
      return h ? (h.ready ? 'running' : h.loading ? 'loading the model' : `not usable (${h.error ?? 'unknown'})`) : null;
    },
    'sfx',
  );

/** Print every check; resolves to the exit code (1 while something required is missing). */
export async function doctor(): Promise<number> {
  rail.open('Storyboard doctor');
  rail.gap();
  const checking = new Task('Checking');
  const checks = await Promise.all([
    checkNode(),
    checkFfmpeg(),
    checkChromium(),
    checkAgents(),
    checkPort(),
    checkProjects(),
    checkMusic(),
    checkSfx(),
  ]);
  checking.clear();
  for (const check of checks) {
    rail.mark(check.level, check.label);
    if (check.fix) rail.hint(check.fix);
  }
  const failed = checks.filter((c) => c.level === 'fail').length;
  if (failed) {
    rail.close(`${failed} problem${failed === 1 ? '' : 's'} to fix · ./storyboard setup fixes most of them`, 'fail');
    return 1;
  }
  rail.close(alreadyRunning ? `Ready · running at ${BASE_URL}` : 'Ready · start it with ./storyboard start');
  return 0;
}
