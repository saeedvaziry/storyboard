import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHROMIUM_BUILDS, CHROMIUM_DIR, CHROMIUM_MINIMUM, CHROMIUM_VERSION, chromiumLaunchOptions } from './chromium';

const parts = (version: string) => version.split('.').map(Number);

describe('pinned Chromium', () => {
  it('is not older than the minimum version', () => {
    const [pinned, minimum] = [parts(CHROMIUM_VERSION), parts(CHROMIUM_MINIMUM)];
    const difference = pinned.map((n, i) => n - minimum[i]).find((n) => n !== 0) ?? 0;
    assert.ok(difference >= 0, `${CHROMIUM_VERSION} is older than ${CHROMIUM_MINIMUM}`);
  });

  it('has a SHA-256 for every build', () => {
    for (const build of Object.values(CHROMIUM_BUILDS)) assert.match(build.sha256, /^[0-9a-f]{64}$/);
  });

  it('installs each version into its own folder', () => {
    assert.ok(CHROMIUM_DIR.endsWith(`chrome-headless-shell-${CHROMIUM_VERSION}`));
  });

  it('keeps the macOS sandbox on unless it is explicitly turned off', () => {
    assert.equal(chromiumLaunchOptions({}).chromiumSandbox, process.platform === 'darwin');
    assert.equal(chromiumLaunchOptions({ STORYBOARD_CHROMIUM_SANDBOX: 'off' }).chromiumSandbox, false);
  });
});
