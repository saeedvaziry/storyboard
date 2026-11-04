// uv installs the engines' Python environments. Storyboard keeps its own copy in .storyboard/bin, pinned to one
// release and checked against the SHA-256 below, and keeps uv's Python and download cache in .storyboard/uv too.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LOCAL_DIR } from '../config';
import { output, run } from './term';
import { Task } from './ui';

const UV_VERSION = '0.12.21';
/** Release archives of uv 0.12.21 (github.com/astral-sh/uv/releases) and their SHA-256. */
const UV_BUILDS: Record<string, { target: string; sha256: string }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', sha256: 'b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447' },
  'darwin-x64': { target: 'x86_64-apple-darwin', sha256: '2b336763b396ec6afa20c5a8b083538ca7402445b868311979d740a4344c17d8' },
  'linux-x64': {
    target: 'x86_64-unknown-linux-musl',
    sha256: 'd69d543a55ec9cdf9d3d9f2648b0a161847e3dbddc477e3be6b5813a6d46f639',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-musl',
    sha256: '67389a674e62adffa5a395d9a3b80688731c4aa7b33a6def3e62d00f7fec821f',
  },
};

export const UV_BIN = path.join(LOCAL_DIR, 'bin', 'uv');
export const UV_DIR = path.join(LOCAL_DIR, 'uv');
export const UV_PYTHON_DIR = path.join(UV_DIR, 'python');
export const UV_CACHE_DIR = path.join(UV_DIR, 'cache');

/** uv's environment: its Python and cache in the app folder, and only Python builds uv manages itself. */
export function uvEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_CACHE_DIR,
    UV_PYTHON_INSTALL_DIR: UV_PYTHON_DIR,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_INSTALL_BIN: '0',
    PYTHONUNBUFFERED: '1',
  };
}

async function installedVersion(): Promise<string | null> {
  if (!fs.existsSync(UV_BIN)) return null;
  return (await output(UV_BIN, ['--version']))?.split(' ')[1] ?? null;
}

/** Make sure the pinned uv is in .storyboard/bin; downloads and verifies it when needed. False when that fails. */
export async function ensureUv(): Promise<boolean> {
  if ((await installedVersion()) === UV_VERSION) return true;
  const task = new Task(`uv ${UV_VERSION}`);
  try {
    await downloadUv(task);
    task.done('checksum verified');
    return true;
  } catch (e) {
    task.fail((e as Error).message);
    return false;
  }
}

/**
 * Download `url` to `file`, showing progress on `task`. Throws unless the file matches `sha256`.
 * It gives up when no data arrives for `idleMs`, so a slow connection can still finish a large download.
 */
export async function downloadVerified(url: string, sha256: string, file: string, task: Task, idleMs = 60_000): Promise<void> {
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const alive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('the download stalled')), idleMs);
  };
  alive();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || null;
    const hash = createHash('sha256');
    let received = 0;
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          alive();
          hash.update(chunk);
          received += chunk.length;
          task.progress(received, total);
          yield chunk;
        }
      },
      fs.createWriteStream(file),
    );
    if (hash.digest('hex') !== sha256) throw new Error("the download didn't match its checksum, so it wasn't installed");
  } finally {
    clearTimeout(idle);
  }
}

async function downloadUv(task: Task): Promise<void> {
  const build = UV_BUILDS[`${process.platform}-${process.arch}`];
  if (!build) throw new Error(`not available for ${process.platform}-${process.arch}`);
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${build.target}.tar.gz`;
  const tmp = path.join(LOCAL_DIR, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, `uv-${build.target}.tar.gz`);
  try {
    await downloadVerified(url, build.sha256, archive, task);
    const unpacked = path.join(tmp, `uv-${build.target}`);
    fs.rmSync(unpacked, { recursive: true, force: true });
    if ((await run('tar', ['-xzf', archive, '-C', tmp], { stdio: 'ignore' })) !== 0) throw new Error('unpacking failed');
    fs.mkdirSync(path.dirname(UV_BIN), { recursive: true });
    for (const name of ['uv', 'uvx']) {
      fs.rmSync(path.join(path.dirname(UV_BIN), name), { force: true });
      fs.renameSync(path.join(unpacked, name), path.join(path.dirname(UV_BIN), name));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if ((await installedVersion()) !== UV_VERSION) throw new Error("it was downloaded but doesn't run");
}

/** Whether a Python environment was made with uv's Python in the app folder (not a system Python elsewhere). */
export function venvIsOurs(venv: string): boolean {
  try {
    const home = /^home\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8'))?.[1].trim();
    if (!home) return false;
    const within = (dir: string, parent: string) => dir === parent || dir.startsWith(parent + path.sep);
    const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
    return within(home, UV_PYTHON_DIR) || within(real(home), real(UV_PYTHON_DIR));
  } catch {
    return false;
  }
}
