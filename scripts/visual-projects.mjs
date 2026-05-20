import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultVisualProjectId = 'visual-test-sample';
export const defaultVisualProjectName = 'Visual Test Sample';
export const defaultVisualProjectTargetUrl = 'https://visual-test-sample.vercel.app/';

const registryPath = path.join(rootDir, 'tests', 'visual-projects.json');
const legacyVisualPagesPath = path.join(rootDir, 'tests', 'visual-pages.json');
const legacySnapshotDir = path.join(rootDir, 'tests', 'visual-test-sample.spec.ts-snapshots');
const legacyResultsDir = path.join(rootDir, 'public', 'visual-results');

export function visualProjectPaths(projectId) {
  const projectDir = path.join(rootDir, 'tests', 'visual-projects', projectId);
  const resultsDir = path.join(rootDir, 'public', 'visual-results', projectId);

  return {
    projectDir,
    visualPagesPath: path.join(projectDir, 'visual-pages.json'),
    snapshotDir: path.join(projectDir, 'snapshots'),
    resultsDir,
    revisionsDir: path.join(resultsDir, 'revisions'),
    latestManifestPath: path.join(resultsDir, 'manifest.json'),
    historyPath: path.join(resultsDir, 'history.json'),
  };
}

export function projectBaselineImageUrl(projectId, fileName) {
  return `/assets/baselines/${projectId}/${fileName}`;
}

export function projectSnapshotPath(projectId, fileName) {
  return `tests/visual-projects/${projectId}/snapshots/${fileName}`;
}

export function projectRevisionManifestUrl(projectId, revisionId) {
  return `/visual-results/${projectId}/revisions/${revisionId}/manifest.json`;
}

export function sanitizeProjectId(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || 'visual-project';
}

export function uniqueProjectId(value, projects) {
  const baseId = sanitizeProjectId(value);
  const usedIds = new Set(projects.map((project) => project.id));

  if (!usedIds.has(baseId)) {
    return baseId;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
}

export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rm(filePath, { force: true });
  await cp(temporaryPath, filePath);
  await rm(temporaryPath, { force: true });
}

export async function ensureVisualProjects() {
  let registry = await readJson(registryPath, null);
  const now = new Date().toISOString();
  let shouldWriteRegistry = false;

  if (!registry || !Array.isArray(registry.projects)) {
    const legacyManifest = await readJson(legacyVisualPagesPath, null);
    registry = {
      version: 1,
      defaultProjectId: defaultVisualProjectId,
      projects: [
        {
          id: defaultVisualProjectId,
          name: defaultVisualProjectName,
          targetUrl: legacyManifest?.targetUrl ?? defaultVisualProjectTargetUrl,
          createdAt: legacyManifest?.generatedAt ?? now,
          updatedAt: legacyManifest?.generatedAt ?? now,
        },
      ],
    };
    shouldWriteRegistry = true;
  }

  if (!registry.version) {
    registry.version = 1;
    shouldWriteRegistry = true;
  }

  if (!registry.defaultProjectId && registry.projects.length > 0) {
    registry.defaultProjectId = registry.projects[0].id;
    shouldWriteRegistry = true;
  }

  if (!registry.projects.some((project) => project.id === defaultVisualProjectId)) {
    const legacyManifest = await readJson(legacyVisualPagesPath, null);
    registry.projects.unshift({
      id: defaultVisualProjectId,
      name: defaultVisualProjectName,
      targetUrl: legacyManifest?.targetUrl ?? defaultVisualProjectTargetUrl,
      createdAt: legacyManifest?.generatedAt ?? now,
      updatedAt: legacyManifest?.generatedAt ?? now,
    });
    registry.defaultProjectId ||= defaultVisualProjectId;
    shouldWriteRegistry = true;
  }

  for (const project of registry.projects) {
    project.name ||= project.id;
    project.targetUrl ||= defaultVisualProjectTargetUrl;
    project.createdAt ||= now;
    project.updatedAt ||= project.createdAt;
  }

  if (shouldWriteRegistry) {
    await writeJson(registryPath, registry);
  }

  for (const project of registry.projects) {
    await ensureProjectStorage(project);
  }

  return registry;
}

export async function resolveVisualProject(projectId = null) {
  const registry = await ensureVisualProjects();
  const resolvedProjectId = projectId || registry.defaultProjectId || defaultVisualProjectId;
  const project = registry.projects.find((candidate) => candidate.id === resolvedProjectId);

  if (!project) {
    throw new Error(`Unknown visual project: ${resolvedProjectId}`);
  }

  await ensureProjectStorage(project);

  return {
    registry,
    project,
    paths: visualProjectPaths(project.id),
  };
}

async function ensureProjectStorage(project) {
  const paths = visualProjectPaths(project.id);
  await Promise.all([
    mkdir(paths.snapshotDir, { recursive: true }),
    mkdir(paths.resultsDir, { recursive: true }),
  ]);

  if (project.id === defaultVisualProjectId) {
    await migrateLegacyDefaultProject(project);
  } else if (!(await fileExists(paths.visualPagesPath))) {
    await writeJson(paths.visualPagesPath, {
      version: 1,
      targetUrl: project.targetUrl,
      generatedAt: project.updatedAt ?? new Date().toISOString(),
      pages: [],
    });
  }
}

async function migrateLegacyDefaultProject(project) {
  const paths = visualProjectPaths(project.id);

  if (!(await fileExists(paths.visualPagesPath))) {
    const legacyManifest = await readJson(legacyVisualPagesPath, null);
    await writeJson(paths.visualPagesPath, rewriteVisualPagesManifest(legacyManifest, project));
  }

  if (await fileExists(legacySnapshotDir)) {
    const entries = await readdir(legacySnapshotDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const sourcePath = path.join(legacySnapshotDir, entry.name);
        const destinationPath = path.join(paths.snapshotDir, entry.name);
        if (!(await fileExists(destinationPath))) {
          await cp(sourcePath, destinationPath);
        }
      }));
  }

  if (!(await fileExists(paths.historyPath)) && await fileExists(legacyResultsDir)) {
    await copyLegacyResults(paths.resultsDir, project.id);
  }
}

function rewriteVisualPagesManifest(manifest, project) {
  const generatedAt = manifest?.generatedAt ?? project.updatedAt ?? new Date().toISOString();
  const pages = Array.isArray(manifest?.pages) ? manifest.pages : [];

  return {
    version: manifest?.version || 1,
    targetUrl: manifest?.targetUrl ?? project.targetUrl ?? defaultVisualProjectTargetUrl,
    generatedAt,
    pages: pages.map((page) => {
      const baselineFileName = page.baselineFileName || `${page.id}-chromium-${process.platform}.png`;
      return {
        ...page,
        baselineFileName,
        baselineImageUrl: projectBaselineImageUrl(project.id, baselineFileName),
        snapshotPath: projectSnapshotPath(project.id, baselineFileName),
      };
    }),
  };
}

async function copyLegacyResults(destinationDir, projectId) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(legacyResultsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === projectId) {
      continue;
    }

    const sourcePath = path.join(legacyResultsDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyRewriteTree(sourcePath, destinationPath, projectId);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const value = await readJson(sourcePath, null);
      if (value !== null) {
        await writeJson(destinationPath, rewriteProjectReferences(value, projectId));
      }
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath);
    }
  }
}

async function copyRewriteTree(sourceDir, destinationDir, projectId) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyRewriteTree(sourcePath, destinationPath, projectId);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const value = await readJson(sourcePath, null);
      if (value !== null) {
        await writeJson(destinationPath, rewriteProjectReferences(value, projectId));
      }
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath);
    }
  }
}

function rewriteProjectReferences(value, projectId) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteProjectReferences(item, projectId));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object
      .entries(value)
      .map(([key, item]) => [key, rewriteProjectReferences(item, projectId)]));
  }

  if (typeof value !== 'string') {
    return value;
  }

  return rewriteProjectString(value, projectId);
}

function rewriteProjectString(value, projectId) {
  const escapedProjectId = escapeRegExp(projectId);

  return value
    .replace(/\/assets\/baselines\/visual-test-sample\//g, `/assets/baselines/${projectId}/`)
    .replace(/tests\/visual-test-sample\.spec\.ts-snapshots\//g, `tests/visual-projects/${projectId}/snapshots/`)
    .replace(new RegExp(`^/visual-results/(?!${escapedProjectId}/)`), `/visual-results/${projectId}/`)
    .replace(new RegExp(`^public/visual-results/(?!${escapedProjectId}/)`), `public/visual-results/${projectId}/`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
