// ./storyboard start | stop | restart | status | logs: Storyboard itself and the optional engines, run in the background.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromiumExecutable } from '../chromium';
import {
  BASE_URL,
  HOST,
  LOG_DIR,
  MUSIC_DIR,
  MUSIC_URL,
  PORT,
  PROJECTS_DIR,
  ROOT,
  RUN_DIR,
  SFX_DIR,
  SFX_PYTHON,
  SFX_URL,
} from '../config';
import { engineHealth, engineInstalled, isLocalUrl, musicApiKey } from '../music/engine';
import { readSettings } from '../settings';
import { sfxApiKey, sfxEngineHealth, sfxEngineInstalled, sfxModelDownloaded } from '../sound/engine';
import {
  commandMatches,
  readPid,
  showLogs,
  stopGroup,
  tail,
  treeMemoryMb,
  waitFor,
  writePid,
  type PidInfo,
  type Probe,
} from './process';
import { shown } from './term';
import { BAR, bold, cyan, dim, formatDuration, gray, green, LiveRows, rail, red, yellow } from './ui';

export type ServiceId = 'app' | 'music' | 'sfx';
export const SERVICES: ServiceId[] = ['app', 'music', 'sfx'];
export const NAMES: Record<ServiceId, string> = { app: 'Storyboard', music: 'Music engine', sfx: 'Sound-effects engine' };
const URLS: Record<ServiceId, string> = {
  get app() {
    return BASE_URL;
  },
  music: MUSIC_URL,
  sfx: SFX_URL,
};

/** Before ./storyboard existed, `npm run music|sfx start` kept the engines' PID files and logs here. */
export const LEGACY_STATE_DIR = path.join(os.homedir(), '.config', 'storyboard');

const pidFiles = (id: ServiceId) => [
  path.join(RUN_DIR, `${id}.pid`),
  ...(id === 'app' ? [] : [path.join(LEGACY_STATE_DIR, `${id}-engine.pid`)]),
];
const logFiles = (id: ServiceId) => [
  path.join(LOG_DIR, `${id}.log`),
  ...(id === 'app' ? [] : [path.join(LEGACY_STATE_DIR, `${id}-engine.log`)]),
];

/** What each service looks like in `ps`, so a reused PID is never mistaken for it. */
const COMMAND: Record<ServiceId, RegExp> = {
  app: /server\/index\.ts/,
  music: /acestep-api|acestep\.api_server/,
  sfx: /server\.py/,
};

export interface Running extends PidInfo {
  pidFile: string;
  logFile: string;
}

/** The process of a service that ./storyboard started (or the npm scripts before it), if it's still running. */
export async function runningProcess(id: ServiceId): Promise<Running | null> {
  for (const [i, file] of pidFiles(id).entries()) {
    const info = readPid(file);
    if (!info) continue;
    if (await commandMatches(info.pid, COMMAND[id])) return { ...info, pidFile: file, logFile: logFiles(id)[i] };
    fs.rmSync(file, { force: true });
  }
  return null;
}

async function appInfo(): Promise<{ projectsDir: string } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/info`, { signal: AbortSignal.timeout(2000) });
    const body = res.ok ? ((await res.json()) as { projectsDir?: unknown }) : null;
    return typeof body?.projectsDir === 'string' ? { projectsDir: body.projectsDir } : null;
  } catch {
    return null;
  }
}

/** How a service answers right now (null: it doesn't). */
export async function probe(id: ServiceId): Promise<Probe | null> {
  if (id === 'app') return (await appInfo()) ? { phase: 'ready', ready: true } : null;
  if (id === 'music') {
    const h = await engineHealth();
    return h ? { phase: h.initialized ? 'ready' : 'loading models', ready: h.initialized } : null;
  }
  const h = await sfxEngineHealth();
  if (!h) return null;
  if (h.ready) return { phase: 'ready', ready: true };
  return { phase: 'loading the model', ready: false, fatal: !h.loading && h.error ? h.error : undefined };
}

/** Is Storyboard answering on PORT, and is it this copy of it? */
export async function appRunning(): Promise<'here' | 'elsewhere' | null> {
  const info = await appInfo();
  return !info ? null : path.resolve(info.projectsDir) === PROJECTS_DIR ? 'here' : 'elsewhere';
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, HOST, () => server.close(() => resolve(true)));
  });
}

/** The engines keep their caches (Hugging Face, matplotlib…) in their own folder instead of ~/.cache. */
export function engineEnv(dir: string): NodeJS.ProcessEnv {
  const cache = path.join(dir, '.cache');
  return {
    ...process.env,
    VIRTUAL_ENV: path.join(dir, '.venv'),
    PATH: `${path.join(dir, '.venv', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    XDG_CACHE_HOME: cache,
    HF_HOME: path.join(cache, 'huggingface'),
    MPLCONFIGDIR: path.join(cache, 'matplotlib'),
    HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTHONUNBUFFERED: '1',
  };
}

const portOf = (url: string, fallback: string) => new URL(url).port || fallback;

function spawnService(id: ServiceId): number | null {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = logFiles(id)[0];
  const log = fs.openSync(logFile, 'w');
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const [command, args, cwd, env]: [string, string[], string, NodeJS.ProcessEnv] =
    id === 'app'
      ? [process.execPath, ['--import', 'tsx', 'server/index.ts'], ROOT, process.env]
      : id === 'music'
        ? [
            path.join(MUSIC_DIR, '.venv', 'bin', 'acestep-api'),
            ['--host', '127.0.0.1', '--port', portOf(MUSIC_URL, '8001')],
            MUSIC_DIR,
            {
              ...engineEnv(MUSIC_DIR),
              ACESTEP_API_KEY: musicApiKey(),
              ...(appleSilicon ? { ACESTEP_LM_BACKEND: 'mlx' } : {}),
              ACESTEP_INIT_LLM: 'auto',
              // Load the models at startup, so "ready" really means ready.
              ACESTEP_NO_INIT: 'false',
            },
          ]
        : [
            SFX_PYTHON,
            ['server.py', '--host', '127.0.0.1', '--port', portOf(SFX_URL, '8002')],
            SFX_DIR,
            { ...engineEnv(SFX_DIR), SFX_API_KEY: sfxApiKey() },
          ];
  // Own process group, so `stop` ends the service and everything it started.
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  child.on('error', (e) => fs.appendFileSync(logFile, `\nCould not start ${command}: ${e.message}\n`));
  child.unref();
  fs.closeSync(log);
  if (!child.pid) return null;
  writePid(pidFiles(id)[0], { pid: child.pid, startedAt: Date.now(), url: URLS[id], ...(id === 'app' ? { host: HOST } : {}) });
  return child.pid;
}

/** Old PID files predate the explicit bind address; their URL is the best available fallback. */
export function appNeedsRestart(info: PidInfo): boolean {
  const host = info.host ?? new URL(info.url).hostname.replace(/^\[|\]$/g, '');
  return info.url !== BASE_URL || host !== HOST;
}

type Launch =
  | { state: 'running'; note: string }
  | { state: 'waiting'; pid: number | null }
  | { state: 'failed'; reason: string; hint: string };

/** Start one service in the background, or say why it isn't starting. */
async function launch(id: ServiceId): Promise<Launch> {
  if (id !== 'app' && !isLocalUrl(URLS[id])) return { state: 'running', note: `on another machine (${URLS[id]})` };
  const mine = await runningProcess(id);
  if (id === 'app' && mine && appNeedsRestart(mine)) {
    return {
      state: 'failed',
      reason: `already running at ${mine.url} with different network settings`,
      hint: 'Apply the saved address and port with ./storyboard restart app',
    };
  }
  const answer = await probe(id);
  if (id === 'app' && answer && (await appRunning()) === 'elsewhere') {
    return {
      state: 'failed',
      reason: `port ${PORT} is taken by a Storyboard in another folder`,
      hint: 'Stop that one, or start this one on another port: PORT=5299 ./storyboard start',
    };
  }
  if (answer?.ready)
    return { state: 'running', note: mine ? 'already running' : 'already running (not started by ./storyboard)' };
  if (answer || mine) return { state: 'waiting', pid: mine?.pid ?? null };
  if (id !== 'app' && !(id === 'music' ? engineInstalled() : sfxEngineInstalled() && sfxModelDownloaded())) {
    return readSettings()?.[id]
      ? { state: 'failed', reason: 'on, but not installed yet', hint: 'Run ./storyboard setup to finish installing it' }
      : { state: 'failed', reason: 'turned off', hint: 'Turn it on with ./storyboard setup' };
  }
  if (id === 'app' && !(await portFree(PORT))) {
    return {
      state: 'failed',
      reason: `port ${PORT} is used by another program`,
      hint: 'Try another port: PORT=5299 ./storyboard start',
    };
  }
  const pid = spawnService(id);
  return pid ? { state: 'waiting', pid } : { state: 'failed', reason: "couldn't be started", hint: `./storyboard logs ${id}` };
}

function hasChromium(): boolean {
  try {
    return fs.existsSync(chromiumExecutable());
  } catch {
    return false;
  }
}

/**
 * Start services in the background, all at once, and wait until each is ready (one live line each).
 * `embedded`: inside another command's output (setup), so no ┌ … └ of its own.
 */
export async function start(ids: ServiceId[], opts: { embedded?: boolean } = {}): Promise<boolean> {
  if (!opts.embedded) {
    rail.open('Starting Storyboard');
    rail.gap();
  }
  if (ids.includes('app') && !hasChromium()) {
    rail.warn('Headless Chromium is missing, so previews and renders will fail');
    rail.hint('./storyboard setup installs it');
  }
  const launched: Launch[] = [];
  for (const id of ids) launched.push(await launch(id));
  const rows = new LiveRows(ids.map((id) => NAMES[id]));
  const afterwards: { tail?: string[]; hint: string }[] = [];
  await Promise.all(
    ids.map(async (id, i) => {
      const l = launched[i];
      if (l.state === 'running') return rows.set(i, 'ok', l.note);
      if (l.state === 'failed') {
        rows.set(i, 'fail', l.reason);
        afterwards.push({ hint: l.hint });
        return;
      }
      rows.set(i, 'spin', 'starting');
      const result = await waitFor({
        pid: l.pid,
        // The app is up in seconds; an engine loads its models first (ACE-Step may fetch one on its first start).
        timeoutMs: (id === 'app' ? 2 : 10) * 60 * 1000,
        probe: async () => (await probe(id)) ?? { phase: 'starting', ready: false },
        onPhase: (phase, seconds) => rows.set(i, 'spin', `${phase} · ${formatDuration(seconds)}`),
      });
      if (result.outcome === 'ready') return rows.set(i, 'ok', `ready in ${formatDuration(result.seconds)}`);
      if (result.outcome === 'timeout') {
        rows.set(i, 'warn', `still starting after ${formatDuration(result.seconds)}`);
        afterwards.push({ hint: `It keeps going in the background; check with ./storyboard status` });
        return;
      }
      if (result.outcome === 'failed') {
        // Running but unusable (e.g. the model can't load): no use keeping it.
        const mine = await runningProcess(id);
        if (mine) await stopGroup(mine.pid);
      }
      rows.set(i, 'fail', result.outcome === 'failed' ? `can't run: ${result.fatal}` : 'stopped while starting');
      afterwards.push({ tail: tail(logFiles(id)[0], 8).split('\n').filter(Boolean), hint: `./storyboard logs ${id}` });
    }),
  );
  rows.stop();
  for (const { tail: lines, hint } of afterwards) {
    if (lines) rail.output(lines);
    rail.hint(hint);
  }
  const ok = afterwards.length === 0;
  if (!opts.embedded) await closeStart(ids, ok);
  return ok;
}

async function closeStart(ids: ServiceId[], ok: boolean) {
  if (ids.includes('app') && (await probe('app'))) {
    rail.close(
      `${ok ? '' : 'Partly started · '}Open ${cyan(BASE_URL)}  ${dim('· stop it with ./storyboard stop')}`,
      ok ? 'ok' : 'warn',
    );
  } else {
    rail.close(ok ? 'Started' : 'Not everything started', ok ? 'ok' : 'fail');
  }
}

/** Stop, then start again, as one block. */
export async function restart(stopIds: ServiceId[], startIds: ServiceId[]): Promise<boolean> {
  rail.open('Restarting Storyboard');
  rail.gap();
  await stop(stopIds, { embedded: true, quiet: true });
  const ok = await start(startIds, { embedded: true });
  await closeStart(startIds, ok);
  return ok;
}

/** Stop what ./storyboard started; anything else is left alone. */
export async function stop(ids: ServiceId[], opts: { embedded?: boolean; quiet?: boolean } = {}): Promise<void> {
  if (!opts.embedded) {
    rail.open('Stopping Storyboard');
    rail.gap();
  }
  const targets = await Promise.all(ids.map(async (id) => ({ id, mine: await runningProcess(id) })));
  const ours = targets.filter((t) => t.mine);
  if (ours.length) {
    const rows = new LiveRows(ours.map((t) => NAMES[t.id]));
    await Promise.all(
      ours.map(async ({ mine }, i) => {
        rows.set(i, 'spin', 'stopping');
        await stopGroup(mine!.pid);
        fs.rmSync(mine!.pidFile, { force: true });
        rows.set(i, 'ok', 'stopped');
      }),
    );
    rows.stop();
  }
  for (const { id } of targets.filter((t) => !t.mine)) {
    if (id !== 'app' && !isLocalUrl(URLS[id])) continue;
    if (await probe(id)) rail.warn(`${NAMES[id]} wasn't started by ./storyboard, so it's still running`);
    else if (!opts.quiet) rail.info(`${NAMES[id]} wasn't running`);
  }
  if (!opts.embedded) rail.close(ours.length ? 'Stopped' : 'Nothing was running');
}

const uptime = (since: number) => formatDuration((Date.now() - since) / 1000);

export async function status(): Promise<void> {
  const settings = readSettings();
  rail.open('Storyboard status');
  rail.gap();
  const rows: [label: string, dot: string, state: string, detail: string][] = [];
  const app = await appRunning();
  const appMine = await runningProcess('app');
  rows.push(
    appMine && appNeedsRestart(appMine)
      ? ['Storyboard', yellow('◒'), 'restart needed', `${cyan(appMine.url)} · ./storyboard restart app`]
      : app === 'here'
        ? [
            'Storyboard',
            green('●'),
            'running',
            `${cyan(BASE_URL)}${appMine ? dim(` · up ${uptime(appMine.startedAt)}`) : dim(' · not started by ./storyboard')}`,
          ]
        : app === 'elsewhere'
          ? ['Storyboard', gray('○'), 'stopped', dim(`port ${PORT} is used by a Storyboard in another folder`)]
          : ['Storyboard', gray('○'), 'stopped', ''],
  );
  for (const id of ['music', 'sfx'] as const) {
    const label = id === 'music' ? 'Music' : 'Sound effects';
    const on = settings?.[id];
    const installed = id === 'music' ? engineInstalled() : sfxEngineInstalled() && sfxModelDownloaded();
    const answer = await probe(id);
    const mine = await runningProcess(id);
    const mb = mine ? await treeMemoryMb(mine.pid) : null;
    const memory = mb !== null ? ` · ${(mb / 1024).toFixed(1)} GB memory` : '';
    if (answer?.ready) {
      const detail =
        id === 'music'
          ? await engineHealth().then((h) => (h?.model ? `${h.model}${h.lmModel ? ` + ${h.lmModel}` : ''}` : ''))
          : await sfxEngineHealth().then((h) => (h?.device ? `on ${h.device}` : ''));
      rows.push([label, green('●'), 'running', dim(`${detail}${mine ? ` · up ${uptime(mine.startedAt)}${memory}` : ''}`)]);
    } else if (answer) {
      rows.push([label, yellow('◒'), answer.fatal ? 'not usable' : 'starting', dim(answer.fatal ?? answer.phase)]);
    } else if (mine) {
      rows.push([label, yellow('◒'), 'starting', dim(`not answering yet · up ${uptime(mine.startedAt)}${memory}`)]);
    } else if (!isLocalUrl(URLS[id])) {
      rows.push([label, gray('○'), 'stopped', dim(`at ${URLS[id]}`)]);
    } else if (on === undefined) {
      rows.push([label, gray('○'), 'not set up', '']);
    } else if (!on) {
      rows.push([label, gray('○'), 'off', dim('./storyboard setup turns it on')]);
    } else if (!installed) {
      rows.push([label, red('●'), 'not installed', dim('./storyboard setup finishes it')]);
    } else {
      rows.push([label, gray('○'), 'stopped', dim(`./storyboard start ${id}`)]);
    }
  }
  const width = Math.max(...rows.map((r) => r[0].length)) + 3;
  for (const [label, dot, state, detail] of rows) {
    console.log(`${BAR}  ${bold(label.padEnd(width))}${dot} ${state.padEnd(14)}${detail}`);
  }
  rail.close(settings ? dim('./storyboard start · stop · logs · setup') : `Not set up yet: ${cyan('./storyboard setup')}`);
}

/** Print (or follow) a service's log, or setup's. */
export async function logs(id: ServiceId | 'setup', follow: boolean): Promise<void> {
  const file =
    id === 'setup'
      ? path.join(LOG_DIR, 'setup.log')
      : ((await runningProcess(id))?.logFile ?? logFiles(id).find((f) => fs.existsSync(f)) ?? logFiles(id)[0]);
  const title = id === 'setup' ? 'Setup log' : `${NAMES[id]} log`;
  if (!fs.existsSync(file)) {
    rail.open(title);
    rail.close(dim('Nothing logged yet'));
    return;
  }
  console.log(
    `${gray('┌')}  ${bold(title)}  ${dim(`${shown(file)} · ${follow ? 'following (Ctrl+C to stop)' : 'last 60 lines'}`)}\n`,
  );
  showLogs(file, follow);
}

/** The services `./storyboard start` runs by default: the app and the engines turned on in setup. */
export function defaultServices(): ServiceId[] | null {
  const settings = readSettings();
  if (!settings) return null;
  return ['app', ...(settings.music ? (['music'] as const) : []), ...(settings.sfx ? (['sfx'] as const) : [])];
}
