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

async function captureCurrentScreenshot(visualPage, outputPath) {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });

    await page.goto(visualPage.targetUrl, { waitUntil: 'networkidle' });
    await page.locator('body').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  } finally {
    await browser.close();
  }
}

async function captureCleanPageArtifacts(items) {
  for (const item of items) {
    if (item.status !== 'clean' || item.actualImageUrl) {
      continue;
    }

    try {
      await captureCurrentScreenshot(item, path.join(rootDir, item.actualPath));
      item.actualImageUrl = item.pendingActualImageUrl;
    } catch (error) {
      console.warn(`Could not capture current screenshot for ${item.name}:`, error.message);
      item.actualPath = null;
    } finally {
      delete item.pendingActualImageUrl;
    }
  }
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

  await captureCleanPageArtifacts(items);

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
