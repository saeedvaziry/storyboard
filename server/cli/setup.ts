// ./storyboard setup: checks the basics, installs Storyboard's packages and headless Chromium, and asks which
// optional engines to use (music, sound effects). Run it again any time: the current choices are the defaults, and
// turning something off offers to remove its files. Everything it installs stays in the app folder.
import fs from 'node:fs';
import path from 'node:path';
import { chromiumExecutable } from '../chromium';
import { BASE_URL, CLAUDE_BIN, CODEX_BIN, HOST, MUSIC_DIR, PORT, reloadNetworkConfig, ROOT, SFX_DIR } from '../config';
import { networkConfig, NETWORK_WARNING, networkExposed } from '../network';
import { checkChromium, checkFfmpeg, claudeStatus } from '../doctor';
import { codexStatus } from '../agents/codex';
import type { AgentProviderId } from '../../src/shared/agents';
import { engineInstalled } from '../music/engine';
import { preferredProvider, readSettings, writeSettings, type Settings } from '../settings';
import { sfxEngineInstalled, sfxModelDownloaded } from '../sound/engine';
import { installChromium } from './chromium';
import { installMusic, legacyMusic, musicNeeds, musicUnsupported, removeMusic } from './music';
import { holdInput, releaseInput, setCancelHandler, withTerminal } from './input';
import { isInteractive, multiselect, secret, select, type Choice } from './prompt';
import { appRunning, defaultServices, LEGACY_STATE_DIR, probe, runningProcess, start, stop, type ServiceId } from './services';
import {
  checkHfAccess,
  existingHfToken,
  installSfx,
  JOIN_PAGE,
  legacySfxModel,
  MODEL_PAGE,
  removeSfx,
  SFX_INSTALLED_PATHS,
  sfxNeeds,
  sfxUnsupported,
  TOKEN_PAGE,
  type HfAccess,
} from './sfx';
import { runStep, startSetupLog, stepFailed, stopCurrentStep } from './tasks';
import { diskUsage, freeSpace, hasCommand, memoryGb, openUrl, run, shown } from './term';
import { BAR, cyan, dim, formatSize, rail, railText, stopLive, Task, yellow } from './ui';
import { UV_CACHE_DIR, UV_DIR } from './uv';

export interface SetupOptions {
  /** Don't ask anything: keep the current choices (or the ones below) and never delete anything. */
  yes: boolean;
  provider?: AgentProviderId;
  host?: string;
  port?: number;
  music?: boolean;
  sfx?: boolean;
}

interface EngineChoice {
  on: boolean;
  /** An older install's models to move into the app folder instead of downloading them again. */
  moveFrom: string | null;
  /** Turned off: remove its files too. */
  remove: boolean;
}

// ---------------------------------------------------------------------------
// Basics: system tools, with a fix to offer while one is missing

interface Fix {
  label: string;
  hint?: string;
  run: () => Promise<unknown>;
}

interface Status {
  ok: boolean;
  /** ok: `✓ label · detail`; not ok: the question's title. */
  label: string;
  detail?: string;
  /** Why it matters, under the question. */
  why?: string;
  /** Without questions: what to do about it. */
  fix?: string;
  fixes?: Fix[];
}

function open(url: string) {
  rail.quiet(openUrl(url) ? `Opened ${url}` : `Open ${url}`);
}

/** Show a status; while it's not ok, ask what to do (its fixes, check again, skip) until it is or the user skips. */
async function fixUntilOk(check: () => Promise<Status>, ask: boolean): Promise<boolean> {
  for (;;) {
    const status = await check();
    if (status.ok) {
      rail.done(status.label, status.detail);
      return true;
    }
    if (!ask) {
      rail.fail(status.label);
      if (status.fix) rail.hint(status.fix);
      return false;
    }
    const fixes = status.fixes ?? [];
    const choice = await select({ title: status.label, lines: status.why ? railText(status.why, dim) : [] }, [
      ...fixes.map((f, i) => ({ value: i, label: f.label, hint: f.hint })),
      { value: -1, label: 'Check again' },
      { value: -2, label: 'Skip for now', warn: true },
    ]);
    if (choice === -2) return false;
    if (choice >= 0) await fixes[choice].run();
  }
}

/** Run an installer as one step (Homebrew, say). */
async function installStep(label: string, command: string, args: string[]) {
  const task = new Task(label);
  const step = await runStep(task, command, args);
  if (step.code === 0) task.done();
  else stepFailed(task, 'failed', step.tail);
}

async function ensureFfmpeg(ask: boolean): Promise<boolean> {
  const brew = process.platform === 'darwin' && (await hasCommand('brew'));
  const apt = process.platform === 'linux' && (await hasCommand('apt-get'));
  const fixes: Fix[] = [];
  if (brew) {
    fixes.push({
      label: 'Install it with Homebrew',
      hint: 'brew install ffmpeg',
      run: () => installStep('Installing ffmpeg', 'brew', ['install', 'ffmpeg']),
    });
  }
  if (apt) {
    fixes.push({
      label: 'Install it with apt',
      hint: 'sudo apt-get install -y ffmpeg',
      run: () => withTerminal(() => run('sudo', ['apt-get', 'install', '-y', 'ffmpeg'])),
    });
  }
  fixes.push({ label: 'Open the download page', hint: 'ffmpeg.org', run: async () => open('https://ffmpeg.org/download.html') });
  return fixUntilOk(async () => {
    const check = await checkFfmpeg();
    if (check.level === 'ok') return { ok: true, label: check.label };
    return {
      ok: false,
      label: check.label.startsWith('ffmpeg not found') ? 'ffmpeg isn’t installed' : check.label,
      why: 'Storyboard renders videos with it.',
      fix: check.fix,
      fixes,
    };
  }, ask);
}

async function ensureClaude(ask: boolean): Promise<boolean> {
  const brew = process.platform === 'darwin' && (await hasCommand('brew'));
  const why = 'The chat runs on your own Claude Code and its Claude login; there are no API keys.';
  return fixUntilOk(async () => {
    const status = await claudeStatus();
    if (!status.installed) {
      const fixes: Fix[] = [];
      if (brew) {
        fixes.push({
          label: 'Install it with Homebrew',
          hint: 'brew install --cask claude-code',
          run: () => installStep('Installing Claude Code', 'brew', ['install', '--cask', 'claude-code']),
        });
      }
      fixes.push({ label: 'Open the install guide', hint: 'code.claude.com', run: async () => open('https://code.claude.com') });
      return {
        ok: false,
        label: 'Claude Code isn’t installed',
        why,
        fix: 'Install it from https://code.claude.com, then run: claude auth login',
        fixes,
      };
    }
    if (status.loggedIn === false) {
      return {
        ok: false,
        label: 'Claude Code isn’t logged in',
        why,
        fix: 'Run: claude auth login',
        fixes: [
          { label: 'Log in now', hint: 'opens your browser', run: () => withTerminal(() => run(CLAUDE_BIN, ['auth', 'login'])) },
        ],
      };
    }
    const detail =
      status.loggedIn === null ? 'couldn’t check the login' : `logged in${status.method ? ` with ${status.method}` : ''}`;
    return { ok: true, label: `Claude Code ${status.version}`, detail };
  }, ask);
}

async function ensureCodex(ask: boolean): Promise<boolean> {
  return fixUntilOk(async () => {
    const status = await codexStatus();
    if (!status.installed || !status.supported)
      return {
        ok: false,
        label: status.installed ? 'Codex CLI needs an update' : 'Codex CLI isn’t installed',
        why: 'The chat can use your Codex CLI and its existing ChatGPT or API-key login instead of Claude Code.',
        fix: 'Install a current Codex CLI (0.159.0 or newer recommended) from https://developers.openai.com/codex/cli, then run: codex login',
        fixes: [
          {
            label: 'Open the install guide',
            hint: 'developers.openai.com/codex/cli',
            run: async () => open('https://developers.openai.com/codex/cli'),
          },
        ],
      };
    if (status.loggedIn === false)
      return {
        ok: false,
        label: 'Codex isn’t logged in',
        fix: 'Run: codex login',
        fixes: [{ label: 'Log in now', hint: 'opens your browser', run: () => withTerminal(() => run(CODEX_BIN, ['login'])) }],
      };
    return { ok: true, label: status.version ?? 'Codex', detail: status.loggedIn ? 'logged in' : 'couldn’t check the login' };
  }, ask);
}

async function chooseAgent(ask: boolean, choice?: AgentProviderId): Promise<AgentProviderId> {
  const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()]);
  const preferred =
    choice ??
    preferredProvider() ??
    (claude.loggedIn ? 'claude-code' : codex.loggedIn && codex.supported ? 'codex' : 'claude-code');
  if (!ask || choice) return preferred;
  return select(
    'Which agent should Storyboard use by default?',
    [
      { value: 'claude-code' as const, label: 'Claude Code', hint: 'your Claude login · switch in the editor any time' },
      { value: 'codex' as const, label: 'Codex', hint: 'your Codex login · switch in the editor any time' },
    ],
    preferred === 'codex' ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Storyboard's own packages and headless Chromium

/** npm packages: `npm ci --ignore-scripts` whenever package-lock.json is newer than what's installed. */
async function ensurePackages(): Promise<boolean> {
  const installed = path.join(ROOT, 'node_modules', '.package-lock.json');
  const current =
    fs.existsSync(installed) && fs.statSync(installed).mtimeMs >= fs.statSync(path.join(ROOT, 'package-lock.json')).mtimeMs;
  if (current) {
    // On a fresh clone the launcher has just installed them, and says how many.
    const fresh = process.env.STORYBOARD_NPM_INSTALLED;
    rail.done('npm packages', fresh ? `${fresh} packages · exact versions, no install scripts` : 'up to date');
    return true;
  }
  // Replacing node_modules under a running Storyboard would break it.
  if ((await appRunning()) === 'here') {
    if (!(await runningProcess('app'))) {
      rail.fail('Storyboard is running, and its packages need an update');
      rail.hint('Stop it (Ctrl+C where it runs), then run ./storyboard setup again');
      return false;
    }
    await stop(['app'], { embedded: true, quiet: true });
  }
  const task = new Task('npm packages');
  let added = '';
  const step = await runStep(task, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    onLine: (line) => (added = /added (\d+) packages?/.exec(line)?.[1] ?? added),
  });
  if (step.code !== 0) {
    stepFailed(task, 'npm ci failed', step.tail);
    return false;
  }
  task.done(`${added ? `${added} packages · ` : ''}exact versions, no install scripts`);
  return true;
}

async function ensureChromium(ask: boolean): Promise<boolean> {
  const version = (label: string) => label.replace('Headless Chromium ', '');
  let check = await checkChromium();
  if (check.level === 'ok') {
    rail.done('Headless Chromium', version(check.label));
    return true;
  }
  const cli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
  const task = new Task('Headless Chromium');
  try {
    // Installed but not starting (missing system libraries, say): downloading it again wouldn't help.
    if (!fs.existsSync(chromiumExecutable())) await installChromium(task);
  } catch (e) {
    task.fail((e as Error).message);
    return false;
  }
  check = await checkChromium();
  if (check.level === 'ok') {
    task.done(version(check.label));
    return true;
  }
  task.fail(check.label);
  if (process.platform !== 'linux' || !ask) return false;
  const install = await select(
    { title: 'Chromium needs some system libraries', lines: railText('Installing them asks for your password.', dim) },
    [
      { value: true, label: 'Install them now' },
      { value: false, label: 'Skip for now', warn: true },
    ],
  );
  if (!install) return false;
  await withTerminal(() => run(process.execPath, [cli, 'install-deps', 'chromium'], { cwd: ROOT }));
  check = await checkChromium();
  if (check.level !== 'ok') return false;
  rail.done('Headless Chromium', version(check.label));
  return true;
}

// ---------------------------------------------------------------------------
// The optional engines

function facts(download: string, memory: string, needGb: number): string[] {
  const free = freeSpace(ROOT);
  const lines = railText(
    `${download} download · ${memory} memory while it runs · this machine: ${memoryGb()} GB${free !== null ? `, ${formatSize(free)} free` : ''}`,
    dim,
  );
  if (free !== null && free < needGb * 1e9) {
    lines.push(...railText(`! Only ${formatSize(free)} free on this disk; it needs about ${needGb} GB.`, yellow));
  }
  return lines;
}

/** An engine's yes/no question; without questions, the flag or the current choice, shown as a result. */
async function engineQuestion(
  ask: boolean,
  q: { title: string; lines: string[] },
  answer: { flag?: boolean; current?: boolean; suggested: boolean; installed: boolean },
): Promise<boolean> {
  if (!ask || answer.flag !== undefined) {
    const on = answer.flag ?? answer.current ?? false;
    rail.section(q.title, 'optional');
    rail.lines(q.lines);
    rail.done(on ? 'On' : 'Off', '', on ? 'ok' : 'info');
    return on;
  }
  return select(
    { title: q.title, note: 'optional', lines: q.lines },
    [
      { value: true, label: answer.installed ? 'Yes, keep it' : 'Yes, install it' },
      { value: false, label: answer.installed ? 'No, turn it off' : 'No' },
    ],
    (answer.current ?? answer.suggested) ? 0 : 1,
  );
}

/** Turned off, but its files are still here: keep them (quick to turn back on) or remove them. */
async function keepOrRemove(ask: boolean, what: string, size: number): Promise<boolean> {
  if (!ask || size === 0) return false;
  const keep = await select({ title: 'Keep its files?', lines: railText(`${what} · ${formatSize(size)}`, dim) }, [
    { value: true, label: 'Keep them', hint: 'turning it back on needs no download' },
    { value: false, label: 'Remove them', hint: `frees ${formatSize(size)}` },
  ]);
  return !keep;
}

async function chooseMusic(ask: boolean, flag: boolean | undefined, before: Settings | null): Promise<EngineChoice> {
  const off: EngineChoice = { on: false, moveFrom: null, remove: false };
  const lines = railText(
    'Your agent composes original soundtracks for your videos with ACE-Step 1.5, an open music model that runs on this machine. MIT-licensed; the music can be used commercially. Without it, you can still use your own tracks.',
  );
  const unsupported = musicUnsupported();
  if (unsupported) {
    rail.section('Music generation', 'optional');
    rail.lines(lines);
    rail.info(unsupported);
    return off;
  }
  lines.push(...facts('18 GB', '9–16 GB of', 20));
  if (memoryGb() < 16)
    lines.push(...railText(`! With ${memoryGb()} GB of memory it may be very slow or not load at all.`, yellow));
  if (process.platform === 'linux' && !(await hasCommand('nvidia-smi'))) {
    lines.push(...railText('! No NVIDIA GPU found: it will be very slow on the CPU.', yellow));
  }
  const installed = engineInstalled();
  const size = await diskUsage(MUSIC_DIR);
  if (installed) lines.push(...railText(`Installed · ${formatSize(size)} in ${shown(MUSIC_DIR)}`, dim));

  const on = await engineQuestion(
    ask,
    { title: 'Music generation', lines },
    { flag, current: before?.music ?? (installed || undefined), suggested: memoryGb() >= 16, installed },
  );
  if (!on) return { ...off, remove: await keepOrRemove(ask, shown(MUSIC_DIR), size) };

  const legacy = legacyMusic();
  if (legacy?.checkpoints && (await musicNeeds()).models) {
    const models = formatSize(await diskUsage(legacy.checkpoints));
    const move =
      !ask ||
      (await select(
        {
          title: `Move the models from ${shown(legacy.dir)}?`,
          lines: railText(
            `An earlier setup left the music engine there, with ${models} of models. Moving them takes a moment; downloading them again takes a while.`,
            dim,
          ),
        },
        [
          { value: true, label: 'Yes, move them' },
          { value: false, label: 'No, download them again' },
        ],
      ));
    if (move) return { on, moveFrom: legacy.checkpoints, remove: false };
  }
  return { on, moveFrom: null, remove: false };
}

/** A Hugging Face token whose account may download the model; null when the user skips (or, without questions, has none). */
async function huggingFaceToken(ask: boolean): Promise<string | null> {
  let token = existingHfToken();
  let access: HfAccess | null = null;
  if (token) {
    const task = new Task('Hugging Face');
    task.update('checking your login');
    access = await checkHfAccess(token);
    if (access.ok) {
      task.done(`signed in as ${access.user} · license accepted`);
      return token;
    }
    task.clear();
  }
  if (!ask) {
    rail.fail(
      !access
        ? 'Downloading Stable Audio Open needs a Hugging Face token'
        : access.problem === 'network'
          ? `Couldn’t reach Hugging Face (${access.detail ?? 'no answer'})`
          : 'Your Hugging Face token can’t download Stable Audio Open',
    );
    rail.hint(`Accept the license at ${MODEL_PAGE}, then run setup with HF_TOKEN=<a Read token> (or run it in a terminal)`);
    return null;
  }
  const noLicense = access && !access.ok && access.problem === 'license' ? access.user : null;
  if (!noLicense) token = null;

  rail.section('Hugging Face', 'for the sound model');
  rail.text(
    noLicense
      ? `Your Hugging Face login (${noLicense}) hasn’t accepted the model’s license yet.`
      : 'Stable Audio Open is free, but Stability AI asks everyone to accept its license on Hugging Face first. Three quick steps in your browser.',
  );
  if (!noLicense) {
    const account = await select('Do you have a Hugging Face account?', [
      { value: true, label: 'Yes' },
      { value: false, label: 'No', hint: 'opens the sign-up page' },
    ]);
    if (!account) {
      open(JOIN_PAGE);
      await select('Sign up (it’s free), then come back here', [{ value: true, label: 'Done, I’m signed in' }]);
    }
  }
  const accept = await select(
    {
      title: 'Accept the license',
      lines: railText('On the model page, fill in the short form and click “Agree and access repository”.', dim),
    },
    [
      { value: true, label: 'Open the model page' },
      { value: false, label: 'I’ve already accepted it' },
    ],
  );
  if (accept) {
    open(MODEL_PAGE);
    await select('Accept it there, then come back here', [{ value: true, label: 'Done' }]);
  }
  if (!token) {
    const create = await select(
      {
        title: 'Create an access token',
        lines: railText('Name it (say, “storyboard”), keep the type “Read”, click “Create token” and copy it.', dim),
      },
      [
        { value: true, label: 'Open the token page' },
        { value: false, label: 'I already have one' },
      ],
    );
    if (create) open(TOKEN_PAGE);
  }
  for (;;) {
    if (!token) token = await secret('Paste your token', 'hidden · used for this download only · never saved');
    if (!token) {
      const again = await select('No token was pasted', [
        { value: true, label: 'Paste it again' },
        { value: false, label: 'Skip sound effects for now', warn: true },
      ]);
      if (again) continue;
      return null;
    }
    const task = new Task('Hugging Face');
    task.update('checking the token');
    access = await checkHfAccess(token);
    if (access.ok) {
      task.done(`signed in as ${access.user} · license accepted`);
      return token;
    }
    const choices: Choice<string>[] = [];
    if (access.problem === 'token') {
      task.fail('the token wasn’t accepted');
      rail.hint('Copy all of it; it starts with “hf_”');
      choices.push({ value: 'paste', label: 'Paste it again' }, { value: 'tokens', label: 'Open the token page' });
    } else if (access.problem === 'license') {
      task.fail(`${access.user} hasn’t accepted the license yet`);
      rail.hint('A fine-grained token also needs “Read access to contents of all public gated repos you can access”');
      choices.push(
        { value: 'check', label: 'Check again' },
        { value: 'model', label: 'Open the model page' },
        { value: 'paste', label: 'Paste another token' },
      );
    } else {
      task.fail(`couldn’t reach Hugging Face (${access.detail ?? 'no answer'})`);
      choices.push({ value: 'check', label: 'Try again' });
    }
    choices.push({ value: 'skip', label: 'Skip sound effects for now', warn: true });
    const next = await select('What now?', choices);
    if (next === 'skip') return null;
    if (next === 'tokens') open(TOKEN_PAGE);
    if (next === 'model') open(MODEL_PAGE);
    if (next === 'paste' || next === 'tokens') token = null;
  }
}

async function chooseSfx(
  ask: boolean,
  flag: boolean | undefined,
  before: Settings | null,
): Promise<EngineChoice & { token: string | null }> {
  const off = { on: false, moveFrom: null, remove: false, token: null };
  const lines = railText(
    'The built-in synth (clicks, whooshes, pings and 19 more) always works. This adds Stable Audio Open 1.0, which makes realistic sounds from a description: a mechanical keyboard, paper, footsteps. Free under the Stability AI Community License (also commercially, under $1M a year in revenue); the download needs a free Hugging Face account.',
  );
  const unsupported = sfxUnsupported();
  if (unsupported) {
    rail.section('Sound effects', 'optional');
    rail.lines(lines);
    rail.info(unsupported);
    return off;
  }
  lines.push(...facts('6 GB', '5 GB of', 7));
  const installed = sfxEngineInstalled() && sfxModelDownloaded();
  const size = (await Promise.all(SFX_INSTALLED_PATHS.map(diskUsage))).reduce((a, b) => a + b, 0);
  if (installed) lines.push(...railText(`Installed · ${formatSize(size)} in ${shown(SFX_DIR)}`, dim));

  const on = await engineQuestion(
    ask,
    { title: 'Sound effects', lines },
    { flag, current: before?.sfx ?? (installed || undefined), suggested: memoryGb() >= 16, installed },
  );
  if (!on) return { ...off, remove: await keepOrRemove(ask, `${shown(SFX_DIR)}/.venv, models`, size) };
  if (!sfxNeeds().model) return { on, moveFrom: null, remove: false, token: null };

  const legacy = legacySfxModel();
  if (legacy) {
    const move =
      !ask ||
      (await select(
        {
          title: 'Move the model from Hugging Face’s shared cache?',
          lines: railText(
            `An earlier setup downloaded it to ${shown(legacy)} (${formatSize(await diskUsage(legacy))}). Other apps that use it from there would download it again.`,
            dim,
          ),
        },
        [
          { value: true, label: 'Yes, move it' },
          { value: false, label: 'No, download it again' },
        ],
      ));
    if (move) return { on, moveFrom: legacy, remove: false, token: null };
  }
  const token = await huggingFaceToken(ask);
  if (!token) {
    rail.info('Sound effects stay off for now; run ./storyboard setup again to turn them on');
    return off;
  }
  return { on, moveFrom: null, remove: false, token };
}

interface Removal {
  path: string;
  label: string;
}

/** Other things that can go: an older install outside the app folder, and download caches. */
async function chooseCleanup(music: EngineChoice, sfx: EngineChoice): Promise<Removal[]> {
  const candidates: Choice<Removal>[] = [];
  const add = (p: string, label: string, hint: string) => candidates.push({ value: { path: p, label }, label, hint });
  const legacy = legacyMusic();
  if (legacy) {
    const size = (await diskUsage(legacy.dir)) - (music.moveFrom ? await diskUsage(music.moveFrom) : 0);
    add(legacy.dir, 'Music engine from an earlier setup', `${shown(legacy.dir)} · ${formatSize(size)}`);
  }
  const legacyModel = legacySfxModel();
  if (legacyModel && legacyModel !== sfx.moveFrom) {
    add(
      legacyModel,
      'Sound model in Hugging Face’s shared cache',
      `${formatSize(await diskUsage(legacyModel))} · other apps may use it`,
    );
  }
  if (fs.existsSync(LEGACY_STATE_DIR)) add(LEGACY_STATE_DIR, 'Old keys and logs', shown(LEGACY_STATE_DIR));
  // With no engine left, uv's Python goes too; otherwise just its download cache (refilled only when needed).
  const noEngines =
    !music.on &&
    (music.remove || !fs.existsSync(MUSIC_DIR)) &&
    !sfx.on &&
    (sfx.remove || !fs.existsSync(path.join(SFX_DIR, '.venv')));
  const uvPath = noEngines ? UV_DIR : UV_CACHE_DIR;
  const uvSize = await diskUsage(uvPath);
  if (uvSize > 20e6) {
    add(
      uvPath,
      noEngines ? 'Python for the engines' : 'Download cache',
      `${formatSize(uvSize)}${noEngines ? '' : ' · refilled only when needed'}`,
    );
  }
  if (!candidates.length) return [];
  return multiselect(
    { title: 'Free up disk space?', note: 'optional', lines: railText('Pick anything to remove; nothing is picked yet.', dim) },
    candidates,
  );
}

// ---------------------------------------------------------------------------
// Doing it

/** Stop an engine run by ./storyboard (or the npm scripts before it) before its files change. */
async function stopIfRunning(id: ServiceId, onlyIf: (legacy: boolean) => boolean = () => true) {
  const running = await runningProcess(id);
  if (running && onlyIf(running.pidFile.startsWith(LEGACY_STATE_DIR + path.sep))) {
    await stop([id], { embedded: true, quiet: true });
  }
}

async function apply(
  music: EngineChoice,
  sfx: EngineChoice & { token: string | null },
  removals: Removal[],
): Promise<{ music: boolean; sfx: boolean }> {
  const done = { music: true, sfx: true };
  for (const [id, choice, remove, title] of [
    ['music', music, removeMusic, 'Music generation'],
    ['sfx', sfx, removeSfx, 'Sound effects'],
  ] as const) {
    if (choice.on || (!choice.remove && !(await runningProcess(id)))) continue;
    rail.section(title, 'turning it off');
    await stopIfRunning(id);
    if (choice.remove) {
      remove();
      rail.done('Removed its files');
    }
  }
  if (music.on) {
    rail.section('Music generation', 'installing');
    const needs = await musicNeeds();
    // A copy from before ./storyboard runs elsewhere and holds the port; an update changes the files it runs from.
    await stopIfRunning('music', (legacy) => legacy || needs.checkout || needs.environment || Boolean(music.moveFrom));
    done.music = await installMusic({ moveModelsFrom: music.moveFrom });
  }
  if (sfx.on) {
    rail.section('Sound effects', 'installing');
    const needs = sfxNeeds();
    await stopIfRunning('sfx', (legacy) => legacy || needs.environment || Boolean(sfx.moveFrom));
    done.sfx = await installSfx({ token: sfx.token, moveModelFrom: sfx.moveFrom });
  }
  if (removals.length) {
    rail.section('Cleanup');
    // Engines started the old way run from (and keep their PID files in) what's about to be removed.
    for (const id of ['music', 'sfx'] as const) await stopIfRunning(id, (legacy) => legacy);
    for (const { path: target, label } of removals) {
      // Never delete models that were meant to be moved here but weren't (the install stopped first).
      const unmoved = [music.moveFrom, sfx.moveFrom].find((from) => from && fs.existsSync(from) && from.startsWith(target));
      if (unmoved) {
        rail.warn(`Kept ${shown(target)}: its models weren’t moved here yet`);
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      rail.done(`Removed: ${label}`, shown(target));
    }
  }
  return done;
}

async function runSetup(opts: SetupOptions): Promise<boolean> {
  const ask = !opts.yes;
  if (ask && !isInteractive()) {
    console.error('./storyboard setup asks a few questions, so run it in a terminal.');
    console.error('In scripts: ./storyboard setup --yes [--provider=claude-code|codex] [--music=on|off] [--sfx=on|off]');
    return false;
  }
  setCancelHandler(() => {
    // First, so nothing keeps downloading in the background; the terminal may already be gone after that.
    stopCurrentStep();
    try {
      stopLive();
      releaseInput();
      console.log(
        `${BAR}\n${yellow('■')}  Setup stopped ${dim('· run ./storyboard setup again to pick up where it left off')}\n`,
      );
    } catch {
      // the terminal window was closed
    }
    process.exit(130);
  });
  if (ask) holdInput();
  startSetupLog();

  rail.open('Storyboard setup', `Everything installs inside ${shown(ROOT)}. Run this again any time to change your choices.`);
  const missing: string[] = [];

  rail.section('Basics');
  rail.done(`Node.js ${process.versions.node}`);
  if (!(await ensureFfmpeg(ask))) missing.push('ffmpeg (renders need it)');
  const provider = await chooseAgent(ask, opts.provider);
  if (!(await (provider === 'codex' ? ensureCodex(ask) : ensureClaude(ask))))
    missing.push(`${provider === 'codex' ? 'Codex' : 'Claude Code'}, logged in (the chat needs it)`);

  rail.section('Storyboard');
  if (!(await ensurePackages())) {
    rail.close('Setup stopped: Storyboard’s packages couldn’t be installed', 'fail');
    return false;
  }
  if (!(await ensureChromium(ask))) missing.push('headless Chromium (previews and renders need it)');

  const before = readSettings();
  const network = networkConfig({ host: opts.host ?? before?.host, port: opts.port ?? before?.port }, {});
  const wasRunning = (await runningProcess('app')) || (await appRunning()) === 'here';
  const previousHost = HOST;
  const previousPort = PORT;
  const music = await chooseMusic(ask, opts.music, before);
  const sfx = await chooseSfx(ask, opts.sfx, before);
  const removals = ask ? await chooseCleanup(music, sfx) : [];
  writeSettings({ music: music.on, sfx: sfx.on, provider, host: network.host, port: network.port });
  reloadNetworkConfig();
  rail.section('Network');
  rail.done('Saved bind address', `${network.host} · port ${network.port}`);
  if (HOST !== network.host || PORT !== network.port)
    rail.warn(`HOST/PORT environment overrides are active: ${HOST} · port ${PORT}. Unset them to use the saved choices.`);
  if (networkExposed(network.host) || networkExposed(HOST)) rail.warn(NETWORK_WARNING);

  const done = await apply(music, sfx, removals);
  const problems = [
    ...missing.map((m) => `Still missing: ${m}`),
    ...(music.on && !done.music ? ['Music generation isn’t installed yet'] : []),
    ...(sfx.on && !done.sfx ? ['Sound effects aren’t installed yet'] : []),
  ];
  if (problems.length) {
    rail.section('Almost there');
    problems.forEach((p) => rail.warn(p));
    rail.hint('Run ./storyboard setup again to finish');
  }
  const outcome = problems.length ? 'Setup finished with problems' : 'Setup done';
  const tone = problems.length ? 'warn' : 'ok';

  if (wasRunning && (previousHost !== HOST || previousPort !== PORT)) {
    rail.gap();
    rail.warn('Network settings saved; the running app still uses its old address and port');
    rail.hint('Apply them with ./storyboard restart app, or Ctrl+C and restart if you use npm run dev');
    rail.close(outcome, tone);
    return true;
  }
  if ((await appRunning()) === 'here' && !(await runningProcess('app'))) {
    rail.gap();
    rail.warn('Storyboard is running, but wasn’t started by ./storyboard');
    rail.hint('Restart it to pick up these changes: stop it (Ctrl+C where it runs), then ./storyboard start');
    rail.close(outcome, tone);
    return true;
  }
  const startNow =
    ask &&
    (await select('Start Storyboard now?', [
      { value: true, label: 'Yes', hint: 'opens it in your browser' },
      { value: false, label: 'Not now' },
    ]));
  if (!startNow) {
    rail.close(`${outcome} · start it with ${cyan('./storyboard start')}`, tone);
    return true;
  }
  rail.section('Starting');
  await start(defaultServices() ?? ['app'], { embedded: true });
  if (await probe('app')) {
    openUrl(BASE_URL);
    rail.close(`Storyboard is running at ${cyan(BASE_URL)}  ${dim('· stop it with ./storyboard stop')}`);
  } else {
    rail.close('Storyboard didn’t start (see above)', 'fail');
  }
  return true;
}

export async function setup(opts: SetupOptions): Promise<boolean> {
  try {
    return await runSetup(opts);
  } finally {
    releaseInput();
  }
}
