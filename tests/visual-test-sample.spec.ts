import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectId = process.env['VISUAL_PROJECT_ID'] ?? 'visual-test-sample';
const manifestPath = path.join(__dirname, 'visual-projects', projectId, 'visual-pages.json');

type VisualPage = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly snapshotName: string;
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
  test.skip(({ browserName }) => browserName !== 'chromium', 'Visual snapshot baseline is captured for Chromium.');

  test.use({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  for (const visualPage of VISUAL_PAGES) {
    test(`matches the ${visualPage.name} visual baseline`, async ({ page }) => {
      await page.goto(new URL(visualPage.url, TARGET_URL).toString(), { waitUntil: 'networkidle' });
      await expect(page.locator('body')).toBeVisible();

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
