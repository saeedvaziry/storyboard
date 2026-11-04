// The headless Chromium behind previews, captures and renders. It is Google's stable Chrome for Testing, not the
// browser Playwright installs: Playwright's builds can miss stable security fixes (Playwright 1.64.1 ships
// 156.0.8078.4, which is older than the critical fix for CVE-2026-118306 in 156.0.8078.73).
import path from 'node:path';
import { BROWSERS_DIR } from './config';

/** A stable build from googlechromelabs.github.io/chrome-for-testing; bump it with the SHA-256s below. */
export const CHROMIUM_VERSION = '156.0.8078.80';
/** The first version with the fix for CVE-2026-118306; chromium.test.ts stops the pin going below it. */
export const CHROMIUM_MINIMUM = '156.0.8078.73';
/** chrome-headless-shell archives of this version and their SHA-256. */
export const CHROMIUM_BUILDS: Record<string, { platform: string; sha256: string }> = {
  'darwin-arm64': { platform: 'mac-arm64', sha256: 'ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac' },
  'darwin-x64': { platform: 'mac-x64', sha256: '535d417d9034cbd11e7dacd1a71aa3d6e1b525e6d5dcd2671eb2532f01481228' },
  'linux-x64': { platform: 'linux64', sha256: '547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4' },
  'linux-arm64': { platform: 'linux-arm64', sha256: '5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607' },
};

export const CHROMIUM_DIR = path.join(BROWSERS_DIR, `chrome-headless-shell-${CHROMIUM_VERSION}`);

export function chromiumBuild(): { platform: string; sha256: string } {
  const build = CHROMIUM_BUILDS[`${process.platform}-${process.arch}`];
  if (!build) throw new Error(`not available for ${process.platform}-${process.arch}`);
  return build;
}

/** The version is in the path, so bumping it makes setup download the new build and stops the old one being used. */
export function chromiumExecutable(): string {
  const { platform } = chromiumBuild();
  return path.join(CHROMIUM_DIR, `chrome-headless-shell-${platform}`, 'chrome-headless-shell');
}

/**
 * Options for every launch. Playwright turns Chromium's sandbox off unless told otherwise. It stays off on Linux,
 * where it depends on the host (containers and AppArmor rules commonly block it). On macOS it can't nest inside
 * another sandbox, such as a sandboxed agent shell: pages crash there, so STORYBOARD_CHROMIUM_SANDBOX=off opts out.
 */
export function chromiumLaunchOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    executablePath: chromiumExecutable(),
    chromiumSandbox: process.platform === 'darwin' && env.STORYBOARD_CHROMIUM_SANDBOX !== 'off',
  };
}
