import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectId = process.env['VISUAL_PROJECT_ID'] ?? 'visual-test-sample';
const manifestPath = path.join(__dirname, 'visual-projects', projectId, 'visual-pages.json');

type VisualPage = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly snapshotName: string;
  readonly actions?: readonly VisualAction[];
};

type VisualAction = {
  readonly type: 'click';
  readonly selector: string;
  readonly index?: number;
  readonly text?: string;
};

type VisualPagesManifest = {
  readonly targetUrl: string;
  readonly pages: readonly VisualPage[];
};

const manifest = JSON.parse(
  readFileSync(manifestPath, 'utf8'),
) as VisualPagesManifest;

const TARGET_URL = manifest.targetUrl;
const sectionId = process.env['VISUAL_SECTION_ID'];
const VISUAL_PAGES = sectionId
  ? manifest.pages.filter((visualPage) => visualPage.id === sectionId)
  : manifest.pages;

if (sectionId && VISUAL_PAGES.length === 0) {
  throw new Error(`Unknown visual section: ${sectionId}`);
}

test.describe(projectId, () => {
  test.describe.configure({ mode: 'parallel' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'Visual snapshot baseline is captured for Chromium.');

  test.use({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  for (const visualPage of VISUAL_PAGES) {
    test(`matches the ${visualPage.name} visual baseline`, async ({ page }) => {
      await openVisualPageState(page, new URL(visualPage.url, TARGET_URL).toString(), visualPage.actions);

      await expect(page).toHaveScreenshot(visualPage.snapshotName, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: 0,
        threshold: 0,
      });
    });
  }
});

async function openVisualPageState(page: Page, url: string, actions: readonly VisualAction[] = []): Promise<void> {
  await gotoWithRetry(page, url);
  await waitForPageReady(page);

  for (const action of actions) {
    await replayVisualAction(page, action);
  }
}

async function gotoWithRetry(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    await page.waitForTimeout(1000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
}

async function replayVisualAction(page: Page, action: VisualAction): Promise<void> {
  const locator = action.text
    ? page.locator(action.selector).filter({ hasText: action.text }).first()
    : page.locator(action.selector).nth(action.index ?? 0);

  await locator.waitFor({ state: 'visible', timeout: 5000 });
  await locator.click({ timeout: 5000 });
  await waitForPageReady(page);
}

async function waitForPageReady(page: Page): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => null);
  await page.evaluate(() => document.fonts.ready).catch(() => null);
  await page.waitForFunction(() => {
    const visualWindow = window as Window & {
      __ratchetVisualStableState?: { signature: string; count: number };
    };
    const body = document.body;
    const root = document.documentElement;
    const signature = [
      body?.innerText?.length ?? 0,
      body?.querySelectorAll('*')?.length ?? 0,
      root?.scrollWidth ?? 0,
      root?.scrollHeight ?? 0,
    ].join(':');
    const state = visualWindow.__ratchetVisualStableState ?? { signature: '', count: 0 };

    if (state.signature === signature) {
      state.count += 1;
    } else {
      state.signature = signature;
      state.count = 0;
    }

    visualWindow.__ratchetVisualStableState = state;
    return state.count >= 2;
  }, null, { polling: 200, timeout: 3000 }).catch(() => null);
}
