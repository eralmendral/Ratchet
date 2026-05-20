import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  defaultVisualProjectTargetUrl,
  projectBaselineImageUrl,
  projectSnapshotPath,
  resolveVisualProject,
} from './visual-projects.mjs';

const defaultTargetUrl = defaultVisualProjectTargetUrl;
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

function uniqueVisualPageId(baseId, reservedIds) {
  if (!reservedIds.has(baseId)) {
    return baseId;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}-${index}`;

    if (!reservedIds.has(candidate)) {
      return candidate;
    }
  }
}

function withVisualPageId(projectId, visualPage, id) {
  const baselineFileName = `${id}-${browserName}-${platformName}.png`;

  return {
    ...visualPage,
    id,
    snapshotName: `${id}.png`,
    baselineFileName,
    baselineImageUrl: projectBaselineImageUrl(projectId, baselineFileName),
    snapshotPath: projectSnapshotPath(projectId, baselineFileName),
  };
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

async function readExistingManifest(manifestPath) {
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

async function discoverPages(page, targetUrl, maxPages, projectId) {
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

    discoveredPages.push(withVisualPageId(projectId, {
      name: pageName,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      url: currentUrl,
    }, slug));

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

async function captureBaselines(page, pages, update, snapshotDir) {
  await mkdir(snapshotDir, { recursive: true });

  for (const visualPage of pages) {
    if (visualPage.manualBaseline) {
      continue;
    }

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
  const { project, paths } = await resolveVisualProject(options.projectId ?? null);
  const existingManifest = await readExistingManifest(paths.visualPagesPath);
  const targetUrl = options.targetUrl ?? existingManifest?.targetUrl ?? defaultTargetUrl;
  const maxPages = options.maxPages ?? defaultMaxPages;
  const update = options.update ?? false;
  const sectionId = options.sectionId ?? null;
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });

    if (sectionId) {
      const sectionPages = Array.isArray(existingManifest?.pages)
        ? existingManifest.pages.filter((visualPage) => visualPage.id === sectionId)
        : [];

      if (sectionPages.length === 0) {
        throw new Error(`Unknown visual section: ${sectionId}`);
      }

      await captureBaselines(page, sectionPages, update, paths.snapshotDir);
      return existingManifest;
    }

    const discoveredPages = await discoverPages(page, targetUrl, maxPages, project.id);
    const manualPages = Array.isArray(existingManifest?.pages)
      ? existingManifest.pages.filter((manifestPage) => manifestPage.manualBaseline)
      : [];
    const reservedIds = new Set(manualPages.map((visualPage) => visualPage.id));
    const reconciledDiscoveredPages = discoveredPages.map((visualPage) => {
      const pageId = uniqueVisualPageId(visualPage.id, reservedIds);
      reservedIds.add(pageId);

      return pageId === visualPage.id ? visualPage : withVisualPageId(project.id, visualPage, pageId);
    });
    const manifestPages = discoveredPages.length > 0
      ? [...reconciledDiscoveredPages, ...manualPages]
      : existingManifest?.pages ?? [];

    await captureBaselines(page, manifestPages, update, paths.snapshotDir);

    const manifest = {
      version: 1,
      targetUrl,
      generatedAt: new Date().toISOString(),
      pages: manifestPages,
    };

    await writeFile(paths.visualPagesPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await crawlVisualBaselines({
    targetUrl: getArgValue('target', null),
    projectId: getArgValue('project', process.env.VISUAL_PROJECT_ID ?? null),
    maxPages: Number(getArgValue('max-pages', String(defaultMaxPages))),
    sectionId: getArgValue('section', null),
    update: hasArg('update'),
  });
}
