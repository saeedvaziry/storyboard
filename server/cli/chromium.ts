// Installs the pinned headless Chromium (server/chromium.ts) into .storyboard/browsers, checked against its SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import { chromiumBuild, CHROMIUM_DIR, CHROMIUM_VERSION } from '../chromium';
import { hasCommand, run } from './term';
import type { Task } from './ui';
import { downloadVerified } from './uv';

export async function installChromium(task: Task): Promise<void> {
  const { platform, sha256 } = chromiumBuild();
  if (!(await hasCommand('unzip'))) throw new Error('the unzip command is missing: install it and run setup again');
  const name = `chrome-headless-shell-${platform}`;
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/${platform}/${name}.zip`;
  const tmp = `${CHROMIUM_DIR}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, `${name}.zip`);
    await downloadVerified(url, sha256, archive, task);
    const unpacked = path.join(tmp, 'unpacked');
    if ((await run('unzip', ['-q', archive, '-d', unpacked], { stdio: 'ignore' })) !== 0) throw new Error('unpacking failed');
    fs.rmSync(CHROMIUM_DIR, { recursive: true, force: true });
    fs.renameSync(unpacked, CHROMIUM_DIR);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
