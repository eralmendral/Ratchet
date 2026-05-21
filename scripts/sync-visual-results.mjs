import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  defaultVisualProjectName,
  defaultVisualProjectTargetUrl,
  projectBaselineImageUrl,
  projectRevisionManifestUrl,
  projectSnapshotPath,
  resolveVisualProject,
} from './visual-projects.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testResultsDir = path.join(rootDir, 'test-results');
const revisionRetention = 20;
const currentScreenshotConcurrency = 4;
const chromeExecutablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scanPreviewOutputPrefix = '[ratchet-preview] ';

function defaultVisualPage(project) {
  const baselineFileName = `home-page-chromium-${process.platform}.png`;

  return {
    id: 'home-page',
    name: 'Home Page',
    source: project.name ?? defaultVisualProjectName,
    targetUrl: project.targetUrl ?? defaultVisualProjectTargetUrl,
    browser: 'Chromium',
    viewport: '1440 x 900',
    snapshotName: 'home-page.png',
    baselineFileName,
    baselineImageUrl: projectBaselineImageUrl(project.id, baselineFileName),
    snapshotPath: projectSnapshotPath(project.id, baselineFileName),
  };
}

function revisionIdFromDate(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function statusLabel(status) {
  if (status === 'changed') {
    return 'Difference detected';
  }

  if (status === 'clean') {
    return 'Matches baseline';
  }

  return 'Baseline';
}

function revisionLabel(createdAt, status) {
  const timestamp = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt));

  return `${timestamp} - ${statusLabel(status)}`;
}

function pageSummary(visualPage, status) {
  if (status === 'changed') {
    return `${visualPage.name} changed from the approved baseline.`;
  }

  if (status === 'clean') {
    return `${visualPage.name} matches the approved baseline.`;
  }

  return `${visualPage.name} baseline is ready.`;
}

function pageDescription(status) {
  if (status === 'changed') {
    return 'The current page does not look like the original screenshot. Review the current image and highlighted diff.';
  }

  if (status === 'clean') {
    return 'The latest visual check did not find layout, color, spacing, or text rendering changes for this page.';
  }

  return 'This screenshot is the original approved image used for future comparisons.';
}

function emitScanPreview(projectId, kind, visualPage, imageUrl) {
  if (!visualPage?.id || !imageUrl) {
    return;
  }

  console.log(`${scanPreviewOutputPrefix}${JSON.stringify({
    id: visualPage.id,
    projectId,
    name: visualPage.name,
    kind,
    imageUrl,
    capturedAt: new Date().toISOString(),
  })}`);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findLatestFile(startDir, fileName) {
  if (!(await fileExists(startDir))) {
    return null;
  }

  const matches = [];
  const pending = [startDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === fileName) {
        const stats = await stat(entryPath);
        matches.push({ path: entryPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] ?? null;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rm(filePath, { force: true });
  await cp(`${filePath}.tmp`, filePath);
  await rm(`${filePath}.tmp`, { force: true });
}

async function readLastRunStatus() {
  const lastRun = await readJson(path.join(testResultsDir, '.last-run.json'), null);
  return typeof lastRun?.status === 'string' ? lastRun.status : null;
}

async function readVisualPages(project, paths, sectionId = null) {
  const fallbackPage = defaultVisualPage(project);
  const manifest = await readJson(paths.visualPagesPath, null);

  if (Array.isArray(manifest?.pages) && manifest.pages.length > 0) {
    const pages = sectionId
      ? manifest.pages.filter((page) => page.id === sectionId)
      : manifest.pages;

    if (sectionId && pages.length === 0) {
      throw new Error(`Unknown visual section: ${sectionId}`);
    }

    return pages.map((page) => ({
      ...fallbackPage,
      ...page,
      source: project.name ?? defaultVisualProjectName,
      targetUrl: page.url ?? project.targetUrl ?? fallbackPage.targetUrl,
      browser: 'Chromium',
      viewport: '1440 x 900',
    }));
  }

  return [fallbackPage];
}

async function captureCurrentScreenshot(browser, visualPage, outputPath) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  try {
    await openVisualPageState(page, visualPage.targetUrl, visualPage.actions);
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  } finally {
    await page.close();
  }
}

async function openVisualPageState(page, targetUrl, actions = []) {
  await gotoWithRetry(page, targetUrl);
  await waitForPageReady(page);

  for (const action of actions) {
    await replayVisualAction(page, action);
  }
}

async function gotoWithRetry(page, targetUrl) {
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    await page.waitForTimeout(1000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
}

async function replayVisualAction(page, action) {
  if (action.type !== 'click' || !action.selector) {
    return;
  }

  const locator = action.text
    ? page.locator(action.selector).filter({ hasText: action.text }).first()
    : page.locator(action.selector).nth(action.index ?? 0);

  await locator.waitFor({ state: 'visible', timeout: 5000 });
  await locator.click({ timeout: 5000 });
  await waitForPageReady(page);
}

async function waitForPageReady(page) {
  await page.locator('body').waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => null);
  await page.evaluate(() => document.fonts?.ready).catch(() => null);
  await page.waitForFunction(() => {
    const body = document.body;
    const root = document.documentElement;
    const signature = [
      body?.innerText?.length ?? 0,
      body?.querySelectorAll('*')?.length ?? 0,
      root?.scrollWidth ?? 0,
      root?.scrollHeight ?? 0,
    ].join(':');
    const state = window.__ratchetVisualStableState ?? { signature: '', count: 0 };

    if (state.signature === signature) {
      state.count += 1;
    } else {
      state.signature = signature;
      state.count = 0;
    }

    window.__ratchetVisualStableState = state;
    return state.count >= 2;
  }, null, { polling: 200, timeout: 3000 }).catch(() => null);
}

async function captureCleanPageArtifacts(items, projectId) {
  const pendingItems = items.filter((item) => item.status === 'clean' && !item.actualImageUrl);

  if (pendingItems.length === 0) {
    return;
  }

  const browser = await chromium.launch({ executablePath: chromeExecutablePath });

  try {
    await runWithConcurrency(pendingItems, currentScreenshotConcurrency, async (item) => {
      try {
        await captureCurrentScreenshot(browser, item, path.join(rootDir, item.actualPath));
        item.actualImageUrl = item.pendingActualImageUrl;
        emitScanPreview(projectId, 'current', item, `${item.actualImageUrl}?v=${Date.now()}`);
      } catch (error) {
        console.warn(`Could not capture current screenshot for ${item.name}:`, error.message);
        item.actualPath = null;
      } finally {
        delete item.pendingActualImageUrl;
      }
    });
  } finally {
    await browser.close();
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      await worker(items[index]);
    }
  }));
}

async function readHistory(paths) {
  const history = await readJson(paths.historyPath, null);

  if (Array.isArray(history?.revisions)) {
    return history.revisions;
  }

  return [];
}

async function pruneOldRevisions(revisions, paths) {
  const retainedIds = new Set(revisions.map((revision) => revision.id));

  if (!(await fileExists(paths.revisionsDir))) {
    return;
  }

  const entries = await readdir(paths.revisionsDir, { withFileTypes: true });

  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !retainedIds.has(entry.name))
    .map((entry) => rm(path.join(paths.revisionsDir, entry.name), { recursive: true, force: true })));
}

export async function syncVisualResults(options = {}) {
  const { project, paths } = await resolveVisualProject(options.projectId ?? null);
  const visualPages = await readVisualPages(project, paths, options.sectionId ?? null);
  const lastRunStatus = await readLastRunStatus();
  const testWasRun = typeof options.exitCode === 'number' || lastRunStatus !== null;
  const createdAt = new Date();
  const revisionId = options.revisionId ?? revisionIdFromDate(createdAt);
  const revisionUUID = options.uuid ?? randomUUID();
  const createdAtIso = createdAt.toISOString();
  const revisionDir = path.join(paths.revisionsDir, revisionId);
  const items = [];

  await mkdir(revisionDir, { recursive: true });

  for (const visualPage of visualPages) {
    const pageDir = path.join(revisionDir, visualPage.id);
    const screenshotName = visualPage.snapshotName.replace(/\.png$/, '');
    const actualFileName = `${screenshotName}-actual.png`;
    const diffFileName = `${screenshotName}-diff.png`;

    await mkdir(pageDir, { recursive: true });

    const [actual, diff] = await Promise.all([
      findLatestFile(testResultsDir, actualFileName),
      findLatestFile(testResultsDir, diffFileName),
    ]);

    const hasDifferenceArtifacts = Boolean(actual && diff);
    const status = hasDifferenceArtifacts ? 'changed' : testWasRun ? 'clean' : 'baseline';
    const actualPath = path.join(pageDir, actualFileName);
    const actualImageUrl = `/visual-results/${project.id}/revisions/${revisionId}/${visualPage.id}/${actualFileName}`;
    const diffPath = path.join(pageDir, diffFileName);
    const diffImageUrl = `/visual-results/${project.id}/revisions/${revisionId}/${visualPage.id}/${diffFileName}`;
    const item = {
      ...visualPage,
      status,
      generatedAt: createdAtIso,
      revisionId,
      actualImageUrl: null,
      diffImageUrl: null,
      actualPath: null,
      diffPath: null,
      errorContextPath: null,
      summary: pageSummary(visualPage, status),
      description: pageDescription(status),
    };

    if (status === 'changed' && actual && diff) {
      await Promise.all([
        cp(actual.path, actualPath),
        cp(diff.path, diffPath),
      ]);

      item.actualImageUrl = actualImageUrl;
      item.diffImageUrl = diffImageUrl;
      item.actualPath = path.relative(rootDir, actualPath);
      item.diffPath = path.relative(rootDir, diffPath);
      emitScanPreview(project.id, 'current', item, `${actualImageUrl}?v=${Date.now()}`);

      const errorContextPath = path.join(path.dirname(actual.path), 'error-context.md');

      if (await fileExists(errorContextPath)) {
        item.errorContextPath = path.relative(rootDir, errorContextPath);
      }
    } else if (status === 'clean') {
      item.actualPath = path.relative(rootDir, actualPath);
      item.pendingActualImageUrl = actualImageUrl;
    }

    items.push(item);
  }

  await captureCleanPageArtifacts(items, project.id);

  const changedPages = items.filter((item) => item.status === 'changed').length;
  const cleanPages = items.filter((item) => item.status === 'clean').length;
  const revisionStatus = changedPages > 0 ? 'changed' : testWasRun ? 'clean' : 'baseline';
  const revisionManifestUrl = projectRevisionManifestUrl(project.id, revisionId);
  const revisionManifest = {
    version: 1,
    revisionId,
    uuid: revisionUUID,
    status: revisionStatus,
    createdAt: createdAtIso,
    generatedAt: createdAtIso,
    label: revisionLabel(createdAtIso, revisionStatus),
    targetUrl: visualPages[0]?.targetUrl ?? project.targetUrl ?? defaultVisualProjectTargetUrl,
    totalPages: items.length,
    changedPages,
    cleanPages,
    items,
  };
  const revisionSummary = {
    id: revisionId,
    uuid: revisionUUID,
    label: revisionManifest.label,
    status: revisionStatus,
    createdAt: createdAtIso,
    targetUrl: revisionManifest.targetUrl,
    totalPages: items.length,
    changedPages,
    cleanPages,
    manifestUrl: revisionManifestUrl,
  };
  const priorRevisions = await readHistory(paths);
  const revisions = [
    revisionSummary,
    ...priorRevisions.filter((revision) => revision.id !== revisionId),
  ].slice(0, revisionRetention);
  const history = {
    version: 1,
    generatedAt: createdAtIso,
    latestRevisionId: revisionId,
    latestManifestUrl: revisionManifestUrl,
    revisions,
  };
  const latestManifest = {
    ...revisionManifest,
    latestRevisionId: revisionId,
    latestManifestUrl: revisionManifestUrl,
  };

  await writeJson(path.join(revisionDir, 'manifest.json'), revisionManifest);
  await writeJson(paths.historyPath, history);
  await writeJson(paths.latestManifestPath, latestManifest);
  await pruneOldRevisions(revisions, paths);

  return latestManifest;
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await syncVisualResults({
    projectId: getArgValue('project') ?? process.env.VISUAL_PROJECT_ID ?? null,
    sectionId: getArgValue('section') ?? process.env.VISUAL_SECTION_ID ?? null,
  });
}
