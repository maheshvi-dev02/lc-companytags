import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledExpectations } from './browser-first-install.mjs';
import { chromiumExplorerDriver } from './browser-explorer.mjs';
import { exerciseProblemTopics } from './browser-problem-topics.mjs';
import { exerciseCompanyTopics } from './browser-company-topics.mjs';

// Run after `npm run build`. Uses an existing Playwright installation and browser;
// never downloads dependencies. Optional PLAYWRIGHT_MODULE/CHROMIUM_EXECUTABLE
// overrides follow the main browser smoke runner's convention.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright',
  path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Try the next installed runtime. */ }
}
if (!playwright) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright Node module.');
let executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath && process.platform === 'win32' && process.env.LOCALAPPDATA) {
  const browserRoot = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const versions = (await readdir(browserRoot).catch(() => []))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  if (versions[0]) executablePath = path.join(browserRoot, versions[0], 'chrome-win64/chrome.exe');
}
const output = path.join(root, 'output/playwright');
const extension = path.join(root, 'dist/chrome');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const core = require(path.join(extension, 'core.js'));
const bundle = await bundledExpectations(extension, core);
const report = { version: manifest.version, startedAt: new Date().toISOString(),
  mode: 'Actual unpacked Chromium Explorer, bundled data, GitHub blocked; controlled response delay/failure cases',
  pageErrors: [], progress: [] };
let context, page;
try {
  context = await playwright.chromium.launchPersistentContext(path.join(output, `company-topics-profile-${Date.now()}`), {
    timeout: 60000, headless: true, channel: 'chromium', ...(executablePath ? { executablePath } : {}),
    viewport: { width: 1280, height: 900 }, args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND',
    ],
  });
  context.setDefaultTimeout(15000);
  context.on('page', target => target.on('pageerror', error => report.pageErrors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = new URL(worker.url());
  page = await context.newPage();
  await page.goto(`${workerUrl.protocol}//${workerUrl.host}/explore.html?mode=companies&query=&company=DE%20Shaw&window=all&topic=Array&difficulty=&sort=frequency-desc`);
  report.companyFlow = await exerciseCompanyTopics(chromiumExplorerDriver(page), {
    core, data: bundle.data, output, browserName: 'chromium',
    onProgress: stage => { report.progress.push(stage); console.log(stage); },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('#mode-problems').click();
  report.globalFlow = await exerciseProblemTopics(chromiumExplorerDriver(page), {
    core, data: bundle.data, output, browserName: 'chromium',
    onProgress: stage => { report.progress.push(`Global regression: ${stage}`); console.log(`Global regression: ${stage}`); },
  });
  assert.deepEqual(report.pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'company-topics-chromium-failure.png'), animations: 'disabled' }).catch(() => {});
    report.dom = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 20000),
      topics: [...document.querySelectorAll('#detail-topic-groups .topic-group')].map(node => ({ topic: node.dataset.topic,
        count: node.querySelector('.topic-group-count')?.textContent, rows: node.querySelectorAll('.question-row').length })),
    })).catch(() => null);
  }
} finally {
  if (context) await context.close();
  report.contextClosed = true;
  const destination = path.join(output, 'company-topics-chromium-report.json');
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: destination, error: report.error, contextClosed: true }));
}
