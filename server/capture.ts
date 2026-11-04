import pixelmatch from 'pixelmatch';
import type { Browser, BrowserContext, Page } from 'playwright';
import { PNG } from 'pngjs';
import type { FrameRenderResult } from '../src/shared/frameApi';
import type { SoundReport } from '../src/shared/types';
import { chromiumLaunchOptions } from './chromium';
import { AGENT_FRAME_QUALITY, AGENT_FRAME_SCALE, BASE_URL } from './config';
import type { ProjectStore } from './projects';
import { KeyedMutex } from './util';

export interface CapturedFrame {
  /** Requested time (scene-local in scene mode, video time in whole mode). */
  t: number;
  sceneId: string | null;
  localTime: number;
  image: Buffer;
  errors: string[];
}

export interface SeamCapture {
  diffPercent: number;
  fromImage: Buffer;
  toImage: Buffer;
  diffImage: Buffer;
  errors: string[];
}

interface Slot {
  context: BrowserContext;
  page: Page;
  size: string;
  uses: number;
}

const RENDER_TIMEOUT_MS = 20000;

export class FrameTimeoutError extends Error {}

/** Headless Chromium that renders frame.html pages and screenshots them. */
export class Capturer {
  private browserPromise: Promise<Browser> | null = null;
  private slots = new Map<string, Slot>();
  private locks = new KeyedMutex();

  constructor(private store: ProjectStore) {}

  browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = import('playwright')
        .then(({ chromium }) =>
          chromium.launch({
            ...chromiumLaunchOptions(),
            args: [
              '--force-color-profile=srgb',
              '--disable-lcd-text',
              '--hide-scrollbars',
              '--mute-audio',
              '--disable-background-timer-throttling',
              '--disable-renderer-backgrounding',
              '--disable-backgrounding-occluded-windows',
            ],
          }),
        )
        .catch((e: Error) => {
          this.browserPromise = null;
          throw new Error(`Could not start headless Chromium. Run "./storyboard setup". (${e.message})`);
        });
    }
    return this.browserPromise;
  }

  /** Open a frame page in its own context (own viewport and pixel ratio). Caller owns closing it. */
  async openFramePage(opts: {
    projectId: string;
    sceneId: string | null;
    scale: number;
    width: number;
    height: number;
  }): Promise<Slot> {
    const browser = await this.browser();
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: opts.scale,
    });
    const page = await context.newPage();
    const params = new URLSearchParams({ project: opts.projectId, mode: 'capture' });
    if (opts.sceneId) params.set('scene', opts.sceneId);
    try {
      await page.goto(`${BASE_URL}/frame.html?${params}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => Boolean(window.__sb), undefined, { timeout: 60000 });
      await withTimeout(
        page.evaluate(() => window.__sb!.ready),
        60000,
        'Loading the scene timed out',
      );
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
    return { context, page, size: `${opts.width}x${opts.height}`, uses: 0 };
  }

  private async withPage<T>(projectId: string, whole: boolean, scale: number, fn: (page: Page) => Promise<T>): Promise<T> {
    const key = `${projectId}|${whole ? 'whole' : 'scene'}|${scale}`;
    return this.locks.run(key, async () => {
      await this.store.syncCode(projectId);
      const project = await this.store.get(projectId);
      const size = `${project.width}x${project.height}`;
      let slot = this.slots.get(key);
      if (slot && (slot.size !== size || slot.uses >= 150 || slot.page.isClosed())) {
        await slot.context.close().catch(() => undefined);
        this.slots.delete(key);
        slot = undefined;
      }
      if (!slot) {
        slot = await this.openFramePage({
          projectId,
          sceneId: whole ? null : (project.scenes[0]?.id ?? null),
          scale,
          width: project.width,
          height: project.height,
        });
        this.slots.set(key, slot);
      } else {
        await withTimeout(
          slot.page.evaluate(() => window.__sb!.reload()),
          RENDER_TIMEOUT_MS,
          'Reloading the scene timed out',
        );
      }
      slot.uses++;
      try {
        return await fn(slot.page);
      } catch (e) {
        if (e instanceof FrameTimeoutError) {
          // A scene stuck in an infinite loop leaves the page unusable.
          await slot.context.close().catch(() => undefined);
          this.slots.delete(key);
        }
        throw e;
      }
    });
  }

  /**
   * Render and screenshot frames. With sceneId, `times` are scene-local; without, they are video times.
   */
  async frames(
    projectId: string,
    sceneId: string | null,
    times: number[],
    opts: { scale?: number; format?: 'jpeg' | 'png'; quality?: number } = {},
  ): Promise<CapturedFrame[]> {
    const scale = opts.scale ?? AGENT_FRAME_SCALE;
    const format = opts.format ?? 'jpeg';
    return this.withPage(projectId, !sceneId, scale, async (page) => {
      if (sceneId) {
        await withTimeout(
          page.evaluate((id) => window.__sb!.setScene(id), sceneId),
          RENDER_TIMEOUT_MS,
          'Loading the scene timed out',
        );
      }
      const out: CapturedFrame[] = [];
      for (const t of times) {
        const result = await captureOne(page, t);
        const image = await page.screenshot({
          type: format,
          quality: format === 'jpeg' ? (opts.quality ?? AGENT_FRAME_QUALITY) : undefined,
          animations: 'disabled',
          caret: 'hide',
        });
        out.push({ t, sceneId: result.sceneId, localTime: result.localTime, image, errors: result.errors });
      }
      return out;
    });
  }

  /** Every scene's sound cues in video time, evaluated by a whole-video frame from the scene code as it is now. */
  async sounds(projectId: string): Promise<SoundReport> {
    return this.withPage(projectId, true, AGENT_FRAME_SCALE, (page) =>
      withTimeout(
        page.evaluate(() => window.__sb!.sounds()),
        RENDER_TIMEOUT_MS,
        'Collecting the sound cues timed out',
      ),
    );
  }

  /** Last frame of `fromId` (t = duration) against the first frame of `toId` (t = 0). */
  async seam(projectId: string, fromId: string, toId: string): Promise<SeamCapture> {
    const project = await this.store.get(projectId);
    const from = project.scenes.find((s) => s.id === fromId);
    if (!from) throw new Error(`Scene "${fromId}" not found`);
    const [a] = await this.frames(projectId, fromId, [from.duration], { scale: 0.5, format: 'png' });
    const [b] = await this.frames(projectId, toId, [0], { scale: 0.5, format: 'png' });
    const pa = PNG.sync.read(a.image);
    const pb = PNG.sync.read(b.image);
    const width = Math.min(pa.width, pb.width);
    const height = Math.min(pa.height, pb.height);
    const diff = new PNG({ width, height });
    const differing = pixelmatch(pa.data, pb.data, diff.data, width, height, {
      threshold: 0.1,
      alpha: 0.25,
      diffColor: [255, 40, 110],
    });
    return {
      diffPercent: (differing / (width * height)) * 100,
      fromImage: a.image,
      toImage: b.image,
      diffImage: PNG.sync.write(diff),
      errors: [...a.errors, ...b.errors],
    };
  }

  async close() {
    for (const slot of this.slots.values()) await slot.context.close().catch(() => undefined);
    this.slots.clear();
    const browser = await this.browserPromise?.catch(() => null);
    await browser?.close().catch(() => undefined);
    this.browserPromise = null;
  }
}

export async function captureOne(page: Page, t: number): Promise<FrameRenderResult> {
  return withTimeout(
    page.evaluate((time) => window.__sb!.seek(time), t),
    RENDER_TIMEOUT_MS,
    `Rendering t=${t}s took longer than ${RENDER_TIMEOUT_MS / 1000}s (infinite loop?)`,
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FrameTimeoutError(message)), ms);
    }),
  ]);
}
