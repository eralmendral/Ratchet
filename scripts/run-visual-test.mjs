import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlVisualBaselines } from './crawl-visual-baselines.mjs';
import { syncVisualResults } from './sync-visual-results.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = path.join(rootDir, 'node_modules', 'playwright', 'cli.js');
const updateSnapshots = process.argv.includes('--update-snapshots');

await crawlVisualBaselines({ update: updateSnapshots });

const args = [
  playwrightCli,
  'test',
  'tests/visual-test-sample.spec.ts',
  '--project=chromium',
  ...process.argv.slice(2),
];

const testProcess = spawn(process.execPath, args, {
  stdio: 'inherit',
});

testProcess.on('close', async (exitCode) => {
  const normalizedExitCode = exitCode ?? 1;

  try {
    await syncVisualResults({ exitCode: normalizedExitCode });
  } catch (error) {
    console.error('Failed to sync visual result artifacts:', error);
    process.exit(1);
  }

  process.exit(normalizedExitCode);
});
