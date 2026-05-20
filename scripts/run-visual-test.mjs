import { spawn } from 'node:child_process';
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
const passthroughArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--section='));

await crawlVisualBaselines({ update: updateSnapshots, sectionId });

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
    ...(sectionId ? { VISUAL_SECTION_ID: sectionId } : {}),
  },
});

testProcess.on('close', async (exitCode) => {
  const normalizedExitCode = exitCode ?? 1;

  try {
    await syncVisualResults({ exitCode: normalizedExitCode, sectionId });
  } catch (error) {
    console.error('Failed to sync visual result artifacts:', error);
    process.exit(1);
  }

  process.exit(normalizedExitCode);
});
