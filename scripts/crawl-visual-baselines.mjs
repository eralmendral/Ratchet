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
const defaultMaxPages = 250;
const defaultMaxActionDepth = 3;
const defaultCaptureConcurrency = 6;
const chromeExecutablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browserName = 'chromium';
const platformName = process.platform;
const componentClassPrefixes = ['tile', 'card', 'tab', 'grid', 'modal'];
const componentClassSelectors = componentClassPrefixes.flatMap((prefix) => [
  `[class~="${prefix}" i]`,
  `[class^="${prefix}-" i]`,
  `[class*=" ${prefix}-" i]`,
  `[class^="${prefix}_" i]`,
  `[class*=" ${prefix}_" i]`,
  `[class^="${prefix}:" i]`,
  `[class*=" ${prefix}:" i]`,
]);
const interactiveSelector = [
  'a[href]',
  'button:not([disabled])',
  'summary',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="tab"]:not([aria-disabled="true"])',
  '[role="link"]:not([aria-disabled="true"])',
  '[role="gridcell"]:not([aria-disabled="true"])',
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="option"]:not([aria-disabled="true"])',
  '[role="switch"]:not([aria-disabled="true"])',
  '[role="checkbox"]:not([aria-disabled="true"])',
  '[aria-controls]:not([aria-disabled="true"])',
  '[aria-expanded]:not([aria-disabled="true"])',
  '[aria-haspopup]:not([aria-disabled="true"])',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  ...componentClassSelectors,
  ...componentClassSelectors.map((selector) => `${selector} > *`),
].join(', ');

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

function slugify(value, fallback = 'section') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || fallback;
}

function truncateSlug(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).replace(/-+$/g, '');
}

function slugFromUrl(url) {
  const parsedUrl = new URL(url);
  const pathParts = parsedUrl.pathname
    .split('/')
    .filter(Boolean)
    .filter((part) => part !== 'index.html')
    .map((part) => part.replace(/\.html$/, ''));
  const pathSlug = pathParts.at(-1) ?? pathParts.join('-');
  const searchSlug = parsedUrl.search
    ? slugify(parsedUrl.search.replace(/^\?/, ''), '')
    : '';
  const hashSlug = parsedUrl.hash
    ? slugify(parsedUrl.hash.replace(/^#\/?/, ''), '')
    : '';
  const baseSlug = [pathSlug || 'home', searchSlug, hashSlug]
    .filter(Boolean)
    .join('-');

  return `${truncateSlug(baseSlug, 100)}-page`;
}

function slugFromVisualState(url, actions = []) {
  const baseSlug = slugFromUrl(url).replace(/-page$/, '');
  const actionSlug = actions
    .map((action) => truncateSlug(slugify(action.label || action.text || 'interaction', 'interaction'), 60))
    .filter(Boolean)
    .join('-');

  return actionSlug ? `${truncateSlug(`${baseSlug}-${actionSlug}`, 140)}-page` : `${baseSlug}-page`;
}

function pathFromUrl(url) {
  const parsedUrl = new URL(url);
  return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
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

async function openVisualPageState(page, visualPage) {
  await gotoWithRetry(page, visualPage.url);
  await waitForPageReady(page);
  await replayVisualActions(page, visualPage.actions);
}

async function gotoWithRetry(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    await page.waitForTimeout(1000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
}

async function replayVisualActions(page, actions = []) {
  for (const action of actions) {
    await replayVisualAction(page, action);
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

async function visualStateSignature(page) {
  return page.evaluate(() => {
    const body = document.body;
    const root = document.documentElement;
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join('|');

    return [
      window.location.href,
      document.title,
      body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 2000) ?? '',
      activeTab?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      dialogs,
      root?.scrollWidth ?? 0,
      root?.scrollHeight ?? 0,
    ].join('\n');
  });
}

async function collectInternalLinks(page, origin) {
  const links = await page.locator('a[href]').evaluateAll((anchors) => {
    return anchors
      .map((anchor) => anchor.href)
      .filter(Boolean);
  });

  return links
    .map((href) => normalizeInternalUrl(href, origin))
    .filter(Boolean);
}

async function collectClickActions(page, origin) {
  return page.locator(interactiveSelector).evaluateAll((elements, selector) => {
    const unsafeLabelPattern = /\b(delete|remove|destroy|accept|approve|save|create|update|upload|submit|reset|clear|cancel|close|logout|log out|sign out)\b/i;

    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }

    function interactive(element) {
      const role = element.getAttribute('role') ?? '';
      const style = window.getComputedStyle(element);
      return style.cursor === 'pointer'
        || element.matches('a[href], button, summary, [onclick], [tabindex]:not([tabindex="-1"])')
        || ['button', 'tab', 'link', 'gridcell', 'menuitem', 'option', 'switch', 'checkbox'].includes(role)
        || element.hasAttribute('aria-controls')
        || element.hasAttribute('aria-expanded')
        || element.hasAttribute('aria-haspopup')
        || Boolean(componentClassToken(element));
    }

    function componentClassToken(element) {
      const className = typeof element.className === 'string' ? element.className : '';
      return className
        .split(/\s+/)
        .find((item) => /^(tile|card|tab|grid|modal)(?:$|[-_:])/i.test(item));
    }

    function visibleTextFor(element) {
      return element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    }

    function labelFor(element, visibleText, index) {
      return [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        visibleText,
        element.getAttribute('data-testid'),
        element.getAttribute('data-test-id'),
        componentClassToken(element) ? `${componentClassToken(element)} ${index + 1}` : '',
      ]
        .find((value) => value && value.replace(/\s+/g, ' ').trim())
        ?.replace(/\s+/g, ' ')
        .trim() ?? '';
    }

    function selectorFor(element) {
      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }

      const testId = element.getAttribute('data-testid') ?? element.getAttribute('data-test-id');
      if (testId) {
        return `[data-testid="${CSS.escape(testId)}"], [data-test-id="${CSS.escape(testId)}"]`;
      }

      const role = element.getAttribute('role');
      if (role) {
        return `[role="${CSS.escape(role)}"]`;
      }

      if (element.matches('a[href]')) {
        return 'a[href]';
      }

      if (element.matches('button')) {
        return 'button';
      }

      if (element.hasAttribute('onclick')) {
        return '[onclick]';
      }

      const componentClass = componentClassToken(element);
      if (componentClass) {
        return `.${CSS.escape(componentClass)}`;
      }

      return selector;
    }

    return elements
      .map((element) => {
        const tagName = element.tagName.toLowerCase();
        const anchor = element.closest('a[href]');
        const href = anchor?.href ?? '';
        const target = anchor?.target ?? '';
        const buttonType = tagName === 'button' ? (element.getAttribute('type') ?? 'button').toLowerCase() : '';
        const selectorValue = selectorFor(element);
        const index = Array.from(document.querySelectorAll(selectorValue)).indexOf(element);
        const visibleText = visibleTextFor(element);
        const label = labelFor(element, visibleText, index);

        return {
          type: 'click',
          selector: selectorValue,
          index,
          text: visibleText,
          label,
          tagName,
          href,
          target,
          buttonType,
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          inForm: Boolean(element.closest('form')),
          interactive: interactive(element),
          visible: visible(element),
        };
      })
      .filter((action) => {
        if (!action.visible || !action.interactive || action.disabled || action.index < 0 || !action.label) {
          return false;
        }

        if (unsafeLabelPattern.test(action.label)) {
          return false;
        }

        if (action.inForm && (action.buttonType === 'submit' || action.buttonType === 'reset')) {
          return false;
        }

        if (action.href) {
          try {
            const parsedHref = new URL(action.href);
            if (parsedHref.origin !== origin || action.target === '_blank') {
              return false;
            }
          } catch {
            return false;
          }
        }

        return true;
      })
      .map(({ tagName, href, target, buttonType, disabled, inForm, interactive, visible, ...action }) => action);
  }, interactiveSelector);
}

async function discoverPages(page, targetUrl, maxPages, projectId, maxActionDepth = defaultMaxActionDepth) {
  const rootUrl = canonicalizeUrl(targetUrl);
  const origin = new URL(rootUrl).origin;
  const queue = [{ url: rootUrl, actions: [] }];
  const seen = new Set();
  const discoveredPages = [];

  while (queue.length > 0 && discoveredPages.length < maxPages) {
    const currentState = queue.shift();
    const currentUrl = currentState?.url;
    const currentActions = currentState?.actions ?? [];
    const currentKey = JSON.stringify({ url: currentUrl, actions: currentActions });

    if (!currentUrl || seen.has(currentKey)) {
      continue;
    }

    seen.add(currentKey);

    await openVisualPageState(page, currentState);

    const baseName = await collectPageName(page, currentUrl);
    const lastAction = currentActions.at(-1);
    const pageName = lastAction?.label ? `${baseName} - ${lastAction.label}` : baseName;
    const slug = slugFromVisualState(currentUrl, currentActions);

    console.log(`[ratchet] Discovered ${discoveredPages.length + 1}/${maxPages}: ${pageName}`);
    discoveredPages.push(withVisualPageId(projectId, {
      name: pageName,
      path: pathFromUrl(currentUrl),
      url: currentUrl,
      ...(currentActions.length ? { actions: currentActions } : {}),
    }, slug));

    for (const normalizedUrl of await collectInternalLinks(page, origin)) {
      const nextState = { url: normalizedUrl, actions: [] };
      const nextKey = JSON.stringify(nextState);

      if (!seen.has(nextKey) && !queue.some((state) => JSON.stringify(state) === nextKey)) {
        queue.push(nextState);
      }
    }

    if (currentActions.length >= maxActionDepth) {
      continue;
    }

    const actions = await collectClickActions(page, origin);

    for (const action of actions) {
      await openVisualPageState(page, currentState);
      const beforeSignature = await visualStateSignature(page);

      try {
        await replayVisualAction(page, action);
      } catch {
        continue;
      }

      const afterUrl = normalizeInternalUrl(page.url(), origin);
      const afterSignature = await visualStateSignature(page);

      if (!afterUrl || afterSignature === beforeSignature) {
        continue;
      }

      const nextState = afterUrl === currentUrl
        ? { url: currentUrl, actions: [...currentActions, action] }
        : { url: afterUrl, actions: [] };
      const nextKey = JSON.stringify(nextState);

      if (!seen.has(nextKey) && !queue.some((state) => JSON.stringify(state) === nextKey)) {
        queue.push(nextState);
      }
    }
  }

  return discoveredPages;
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

async function captureBaselines(browser, pages, update, snapshotDir, concurrency) {
  await mkdir(snapshotDir, { recursive: true });
  const captures = [];

  for (const visualPage of pages) {
    if (visualPage.manualBaseline) {
      continue;
    }

    const snapshotPath = path.join(snapshotDir, visualPage.baselineFileName);
    const shouldCapture = update || !(await fileExists(snapshotPath));

    if (!shouldCapture) {
      continue;
    }

    captures.push({ visualPage, snapshotPath });
  }

  if (captures.length > 0) {
    console.log(`[ratchet] Capturing ${captures.length} baseline screenshot(s) with concurrency ${concurrency}.`);
  }

  let capturedCount = 0;
  await runWithConcurrency(captures, concurrency, async ({ visualPage, snapshotPath }) => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });

    try {
      await openVisualPageState(page, visualPage);
      await page.screenshot({
        path: snapshotPath,
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      });
    } finally {
      await page.close();
    }
    capturedCount += 1;
    console.log(`[ratchet] Captured baseline ${capturedCount}/${captures.length}: ${visualPage.name}`);
  });
}

export async function crawlVisualBaselines(options = {}) {
  const { project, paths } = await resolveVisualProject(options.projectId ?? null);
  const existingManifest = await readExistingManifest(paths.visualPagesPath);
  const targetUrl = options.targetUrl ?? existingManifest?.targetUrl ?? defaultTargetUrl;
  const maxPages = options.maxPages ?? defaultMaxPages;
  const maxActionDepth = options.maxActionDepth ?? defaultMaxActionDepth;
  const captureConcurrency = options.captureConcurrency ?? defaultCaptureConcurrency;
  const discover = options.discover ?? true;
  const update = options.update ?? false;
  const sectionId = options.sectionId ?? null;
  const existingPages = Array.isArray(existingManifest?.pages) ? existingManifest.pages : [];
  const browser = await chromium.launch({ executablePath: chromeExecutablePath });

  try {
    console.log(`[ratchet] Starting crawl for ${targetUrl} (max ${maxPages}, depth ${maxActionDepth}).`);
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

      await captureBaselines(browser, sectionPages, update, paths.snapshotDir, captureConcurrency);
      return existingManifest;
    }

    if (!discover && existingPages.length > 0) {
      console.log(`[ratchet] Reusing ${existingPages.length} registered section(s). Run Refresh Sections to discover new routes or components.`);
      await captureBaselines(browser, existingPages, update, paths.snapshotDir, captureConcurrency);
      return existingManifest;
    }

    const discoveredPages = await discoverPages(page, targetUrl, maxPages, project.id, maxActionDepth);
    console.log(`[ratchet] Discovery complete: ${discoveredPages.length} section(s).`);
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

    await captureBaselines(browser, manifestPages, update, paths.snapshotDir, captureConcurrency);

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
  const maxPagesArg = getArgValue('max-pages', null);

  await crawlVisualBaselines({
    targetUrl: getArgValue('target', null),
    projectId: getArgValue('project', process.env.VISUAL_PROJECT_ID ?? null),
    maxPages: maxPagesArg ? Number(maxPagesArg) : undefined,
    sectionId: getArgValue('section', null),
    update: hasArg('update'),
  });
}
