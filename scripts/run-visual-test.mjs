import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlVisualBaselines } from './crawl-visual-baselines.mjs';
import { syncVisualResults } from './sync-visual-results.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = path.join(rootDir, 'node_modules', 'playwright', 'cli.js');
const updateSnapshots = process.argv.includes('--update-snapshots');

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const sectionId = getArgValue('section') ?? process.env.VISUAL_SECTION_ID ?? null;
const projectId = getArgValue('project') ?? process.env.VISUAL_PROJECT_ID ?? null;
const effectiveProjectId = projectId ?? 'visual-test-sample';
const progressDir = path.join(rootDir, 'public', 'visual-results', effectiveProjectId, 'progress');
const progressUrlBase = `/visual-results/${effectiveProjectId}/progress`;
const scanPreviewOutputPrefix = '[ratchet-preview] ';
const passthroughArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--section=') && !arg.startsWith('--project='));

function emitScanPreview(kind, visualPage, imageUrl) {
  if (!visualPage?.id || !imageUrl) {
    return;
  }

  console.log(`${scanPreviewOutputPrefix}${JSON.stringify({
    id: visualPage.id,
    projectId: effectiveProjectId,
    name: visualPage.name,
    kind,
    imageUrl,
    capturedAt: new Date().toISOString(),
  })}`);
}

console.log('[ratchet] Preparing visual baselines.');
const visualPagesManifest = await crawlVisualBaselines({ update: updateSnapshots, sectionId, projectId, discover: false });
await rm(progressDir, { recursive: true, force: true });
console.log('[ratchet] Running Playwright visual comparisons.');

const progressPageByFileName = new Map((visualPagesManifest?.pages ?? [])
  .filter((visualPage) => !sectionId || visualPage.id === sectionId)
  .map((visualPage) => [`${visualPage.id}-current.png`, visualPage]));
const emittedProgressFiles = new Map();

async function emitProgressScreenshots() {
  let entries;
  try {
    entries = await readdir(progressDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-current.png'))
    .map(async (entry) => {
      const visualPage = progressPageByFileName.get(entry.name);
      if (!visualPage) {
        return;
      }

      const filePath = path.join(progressDir, entry.name);
      const stats = await stat(filePath).catch(() => null);
      if (!stats) {
        return;
      }

      const version = `${stats.size}:${stats.mtimeMs}`;
      if (emittedProgressFiles.get(entry.name) === version) {
        return;
      }

      emittedProgressFiles.set(entry.name, version);
      emitScanPreview('current', visualPage, `${progressUrlBase}/${entry.name}?v=${Math.round(stats.mtimeMs)}`);
    }));
}

const args = [
  playwrightCli,
  'test',
  'tests/visual-test-sample.spec.ts',
  '--project=chromium',
  ...passthroughArgs,
];

const testProcess = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VISUAL_PROJECT_ID: effectiveProjectId,
    RATCHET_PROGRESS_DIR: progressDir,
    RATCHET_PROGRESS_URL_BASE: progressUrlBase,
    ...(sectionId ? { VISUAL_SECTION_ID: sectionId } : {}),
  },
});
const progressTimer = setInterval(() => {
  void emitProgressScreenshots();
}, 300);

testProcess.on('close', async (exitCode) => {
  const normalizedExitCode = exitCode ?? 1;
  clearInterval(progressTimer);
  await emitProgressScreenshots();

  try {
    console.log('[ratchet] Syncing visual result artifacts.');
    await syncVisualResults({ exitCode: normalizedExitCode, sectionId, projectId });
  } catch (error) {
    console.error('Failed to sync visual result artifacts:', error);
    process.exit(1);
  }

  process.exit(normalizedExitCode);
});
