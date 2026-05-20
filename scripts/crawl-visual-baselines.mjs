import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'tests', 'visual-pages.json');
const snapshotDir = path.join(rootDir, 'tests', 'visual-test-sample.spec.ts-snapshots');
const defaultTargetUrl = 'https://visual-test-sample.vercel.app/';
const defaultMaxPages = 25;
const browserName = 'chromium';
const platformName = process.platform;

function getArgValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function toTitle(value) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugFromUrl(url) {
  const parsedUrl = new URL(url);
  const pathParts = parsedUrl.pathname
    .split('/')
    .filter(Boolean)
    .filter((part) => part !== 'index.html')
    .map((part) => part.replace(/\.html$/, ''));
  const pathSlug = pathParts.at(-1) ?? pathParts.join('-');

  return pathSlug ? `${pathSlug}-page` : 'home-page';
}

function canonicalizeUrl(url) {
  const parsedUrl = new URL(url);

  if (parsedUrl.pathname.endsWith('/index.html')) {
    parsedUrl.pathname = parsedUrl.pathname.replace(/index\.html$/, '');
  }

  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function normalizeInternalUrl(href, origin) {
  try {
    const parsedUrl = new URL(href);

    if (parsedUrl.origin !== origin) {
      return null;
    }

    return canonicalizeUrl(parsedUrl.toString());
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readExistingManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function collectPageName(page, url) {
  const heading = await page.locator('h1').first().textContent().catch(() => null);
  const cleanedHeading = heading?.replace(/\s+/g, ' ').trim();

  if (cleanedHeading) {
    return cleanedHeading;
  }

  const slug = slugFromUrl(url).replace(/-page$/, '');
  return toTitle(slug || 'Home');
}

async function discoverPages(page, targetUrl, maxPages) {
  const rootUrl = canonicalizeUrl(targetUrl);
  const origin = new URL(rootUrl).origin;
  const queue = [rootUrl];
  const seen = new Set();
  const discoveredPages = [];

  while (queue.length > 0 && discoveredPages.length < maxPages) {
    const currentUrl = queue.shift();

    if (!currentUrl || seen.has(currentUrl)) {
      continue;
    }

    seen.add(currentUrl);

    await page.goto(currentUrl, { waitUntil: 'networkidle' });
    await page.locator('body').waitFor({ state: 'visible' });

    const pageName = await collectPageName(page, currentUrl);
    const slug = slugFromUrl(currentUrl);
    const parsedUrl = new URL(currentUrl);

    discoveredPages.push({
      id: slug,
      name: pageName,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      url: currentUrl,
      snapshotName: `${slug}.png`,
      baselineFileName: `${slug}-${browserName}-${platformName}.png`,
      baselineImageUrl: `/assets/baselines/visual-test-sample/${slug}-${browserName}-${platformName}.png`,
      snapshotPath: `tests/visual-test-sample.spec.ts-snapshots/${slug}-${browserName}-${platformName}.png`,
    });

    const links = await page.locator('a[href]').evaluateAll((anchors) => {
      return anchors
        .map((anchor) => anchor.href)
        .filter(Boolean);
    });

    for (const href of links) {
      const normalizedUrl = normalizeInternalUrl(href, origin);

      if (normalizedUrl && !seen.has(normalizedUrl) && !queue.includes(normalizedUrl)) {
        queue.push(normalizedUrl);
      }
    }
  }

  return discoveredPages;
}

async function captureBaselines(page, pages, update) {
  await mkdir(snapshotDir, { recursive: true });

  for (const visualPage of pages) {
    const snapshotPath = path.join(snapshotDir, visualPage.baselineFileName);
    const shouldCapture = update || !(await fileExists(snapshotPath));

    if (!shouldCapture) {
      continue;
    }

    await page.goto(visualPage.url, { waitUntil: 'networkidle' });
    await page.locator('body').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: snapshotPath,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  }
}

export async function crawlVisualBaselines(options = {}) {
  const targetUrl = options.targetUrl ?? defaultTargetUrl;
  const maxPages = options.maxPages ?? defaultMaxPages;
  const update = options.update ?? false;
  const existingManifest = await readExistingManifest();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });

    const discoveredPages = await discoverPages(page, targetUrl, maxPages);
    const manifestPages = discoveredPages.length > 0 ? discoveredPages : existingManifest?.pages ?? [];

    await captureBaselines(page, manifestPages, update);

    const manifest = {
      version: 1,
      targetUrl,
      generatedAt: new Date().toISOString(),
      pages: manifestPages,
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await crawlVisualBaselines({
    targetUrl: getArgValue('target', defaultTargetUrl),
    maxPages: Number(getArgValue('max-pages', String(defaultMaxPages))),
    update: hasArg('update'),
  });
}
