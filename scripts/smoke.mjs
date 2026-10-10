import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exercisePanelLogos, exercisePopupLogos } from './browser-logos.mjs';
import { chromiumExplorerDriver, exerciseExplorer } from './browser-explorer.mjs';
import { exerciseNativePopup } from './browser-native-popup.mjs';
import { bundledExpectations, exerciseBundledPanel, exerciseBundledPopup, problemFixture, exerciseInlineLayout, exerciseInlineNavigation, exercisePopupFeatures, exercisePopupContext, archiveFixture, browserArchiveCheck, assertArchiveResult } from './browser-first-install.mjs';

// Optional browser verification: uses an existing Playwright installation, never
// downloads a runtime or adds a production dependency. See output/playwright.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
for (const modulePath of [process.env.PLAYWRIGHT_MODULE, 'playwright',
  path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(modulePath); break; } catch { /* Try the next installed runtime. */ }
}
if (!playwright) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright Node module.');

const output = path.join(root, 'output', 'playwright');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), chromium: null };
const commit = '1234567890abcdef1234567890abcdef12345678';
const sourceUrl = (name) => `https://github.com/liquidslr/leetcode-company-wise-problems/blob/${commit}/${name}/5.%20All.csv`;
const now = new Date().toISOString();
const core = require(path.join(root, 'dist', 'chrome', 'core.js'));
const companyNames = ['Amazon', 'Apple', 'Bloomberg', 'Google', 'Meta', 'Microsoft', 'Spotify'];
const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const allFrequency = { Amazon: 100, Apple: 91, Bloomberg: 50, Google: 91, Meta: 0, Microsoft: null, Spotify: 65 };
const secondFrequency = { Amazon: 180, Apple: 100, Bloomberg: 40, Google: 200, Meta: 150, Microsoft: 90, Spotify: 50 };
const acceptanceSource = { 'two-sum': 0.5, 'add-two-numbers': 0.456, 'merge-two-sorted-lists': 0,
  'binary-tree-level-order-traversal': '', 'valid-parentheses': 1,
  'longest-substring-without-repeating-characters': 'not-a-rate', 'maximum-depth-of-binary-tree': 0.74123 };
const windowFrequency = {
  all: allFrequency,
  '30d': { Amazon: 40, Apple: 0, Bloomberg: null, Google: 99, Meta: 88, Microsoft: null, Spotify: null },
  '3m': { ...allFrequency, Spotify: 200 },
  '6m': { ...allFrequency, Meta: 160 },
  older: { ...allFrequency, Bloomberg: 120 },
};
const fileDescriptors = [];
const parsedFiles = {};
for (const [window, filename] of Object.entries(core.WINDOW_FILES)) {
  for (const name of companyNames) {
    const records = [
      ['EASY', 'Two Sum', windowFrequency[window][name], 'https://leetcode.com/problems/two-sum/', 'Array, Hash Table'],
      ['MEDIUM', 'Add Two Numbers', secondFrequency[name], 'https://leetcode.com/problems/add-two-numbers/', 'Linked List, Math'],
    ];
    if (name === 'Amazon') records.push(
      ['EASY', 'Merge Two Sorted Lists', 85, 'https://leetcode.com/problems/merge-two-sorted-lists/', 'Linked List, Recursion'],
      ['MEDIUM', 'Binary Tree Level Order Traversal', 75, 'https://leetcode.com/problems/binary-tree-level-order-traversal/', 'Tree, Breadth-First Search'],
      ['EASY', 'Valid Parentheses', 70, 'https://leetcode.com/problems/valid-parentheses/', 'String, Stack'],
      ['MEDIUM', 'Longest Substring Without Repeating Characters', 65, 'https://leetcode.com/problems/longest-substring-without-repeating-characters/', 'Hash Table, Sliding Window'],
      ['EASY', 'Maximum Depth of Binary Tree', 50, 'https://leetcode.com/problems/maximum-depth-of-binary-tree/', 'Tree, Depth-First Search'],
    );
    const relativePath = `${name}/${filename}`;
    const sha = (fileDescriptors.length + 1).toString(16).padStart(40, '0');
    const csv = 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\n' + records.map(([difficulty, title, frequency, link, topics]) =>
      [difficulty, title, frequency, acceptanceSource[core.getProblemSlug(link)], link, topics].map(csvCell).join(',')).join('\n');
    fileDescriptors.push({ path: relativePath, name, window, sha });
    parsedFiles[relativePath] = { sha, records: core.parseCompanyRecords(csv) };
  }
}
const fixtureData = core.buildData(fileDescriptors, parsedFiles, commit, now, now);
const seed = {
  lctData: fixtureData,
  lctStatus: { phase: 'idle', completed: 35, total: 35, message: 'Up to date.',
    lastCheckedAt: now, lastSyncedAt: now, sourceUpdatedAt: now,
    commit, companyCount: fixtureData.companyCount, problemCount: fixtureData.problemCount, hasData: true },
  lctSettings: { enabled: true, collapsed: true },
  lctStage: null,
  lctCache: null,
};
const fixture = problemFixture();

async function installedExecutable(kind) {
  const explicit = process.env[kind === 'chromium' ? 'CHROMIUM_EXECUTABLE' : 'FIREFOX_EXECUTABLE'];
  if (explicit) return explicit;
  const candidates = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    const dirs = (await readdir(candidates)).filter((name) => new RegExp(`^${kind}-\\d+$`).test(name))
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    if (dirs.length) return path.join(candidates, dirs[0], kind === 'chromium' ? 'chrome-win64/chrome.exe' : 'firefox/firefox.exe');
  } catch { /* Fall back to Playwright's configured browser. */ }
  return undefined;
}

async function prepare(context, blockGitHub = true) {
  await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await context.route(/https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//, (route) => route.fulfill({ contentType: 'text/html', body: problemFixture({ anchor: !new URL(route.request().url()).searchParams.has('late') }) }));
  // Supplemental routing for page requests. Service-worker requests bypass these
  // routes, so deterministic browser launches also block these hosts in Chromium's
  // resolver before the extension starts.
  if (blockGitHub) await context.route(/https:\/\/(?:api\.github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\//, (route) => route.abort());
}

async function seedFromPopup(popup) {
  // After first-install offline snapshot checks, let background refresh settle.
  // Then seed deterministic edge cases and restart the browser.
  // The worker intentionally retains a memory snapshot until its next startup.
  let settled = false;
  let initialStatus;
  for (let attempt = 0; attempt < 180; attempt++) {
    const status = await popup.evaluate(async () => {
      const api = globalThis.browser || globalThis.chrome;
      return (await api.runtime.sendMessage({ type: 'LCT_STATUS' })).status;
    });
    if (status && status.phase !== 'syncing') { initialStatus = status; settled = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(settled, 'First-install sync must settle before seeding the UI fixture.');
  assert.equal(initialStatus.hasData, true, 'The bundled snapshot must remain available after blocked background refresh.');
  assert.equal(initialStatus.dataSource, 'bundled', 'Blocked GitHub access must not produce live data.');
  await popup.evaluate(async (data) => {
    const api = globalThis.browser || globalThis.chrome;
    await api.alarms.clearAll();
    await api.storage.local.set(data);
  }, seed);
}

async function expectTexts(locator, expected) {
  let observed;
  for (let attempt = 0; attempt < 60; attempt++) {
    observed = await locator.allTextContents();
    if (JSON.stringify(observed) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(observed, expected);
}

async function exercise(context, extensionUrl, browserName) {
  const results = [], errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto('https://leetcode.com/problems/two-sum/description/');
  const host = page.locator('#company-lens-root');
  const inline = await exerciseInlineLayout(page, { core, data: fixtureData, output, browserName });
  results.push(...inline.checks);
  const nativePopup = process.argv.includes('--skip-native-popup')
    ? { skipped: true, reason: 'Explicit --skip-native-popup; native-toolbar target discovery is not part of this run.', checks: [] }
    : await exerciseNativePopup(context, page, { core, data: fixtureData, extensionUrl, output, browserName });
  results.push(...nativePopup.checks);
  const popup = await context.newPage();
  await page.bringToFront(); await popup.goto(`${extensionUrl}/popup.html`);
  const ui = chromiumExplorerDriver(popup);
  const toolbar = await exercisePopupFeatures(ui, page, { data: fixtureData, core, output, browserName,
    getStatus: () => popup.evaluate(async () => (await chrome.storage.local.get('lctStatus')).lctStatus),
    setStorage: data => popup.evaluate(data => chrome.storage.local.set(data), data),
    removeStorage: key => popup.evaluate(key => chrome.storage.local.remove(key), key),
  });
  results.push(...toolbar.checks);
  await popup.screenshot({ path: path.join(output, `${browserName}-popup.png`), animations: 'disabled' });
  const navigation = await exerciseInlineNavigation(page, { data: fixtureData, core, context,
    onSPA: async () => { await page.bringToFront(); await popup.reload(); return exercisePopupContext(ui, { data: fixtureData, core, slug: 'add-two-numbers' }); },
  });
  results.push(...navigation.checks);
  return { results, errors, page, popup, host, inline, nativePopup };
}

async function chromiumRun() {
  const directory = path.join(root, 'dist', 'chrome');
  await readFile(path.join(directory, 'manifest.json'));
  const profile = path.join(output, `chromium-profile-${Date.now()}`);
  const options = {
    headless: true, channel: 'chromium', executablePath: await installedExecutable('chromium'),
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    viewport: { width: 1440, height: 1000 },
  };
  const deterministicOptions = { ...options, args: [...options.args,
    '--no-proxy-server',
    '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND',
  ] };
  const expectedBundle = await bundledExpectations(directory, core);
  const startupStartedAt = Date.now();
  let context = await playwright.chromium.launchPersistentContext(profile, deterministicOptions);
  try {
    await prepare(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const workerUrl = new URL(worker.url());
    const extensionUrl = `${workerUrl.protocol}//${workerUrl.host}`;
    const firstPage = await context.newPage();
    const navigationStartedAt = Date.now();
    await firstPage.goto('https://leetcode.com/problems/two-sum/description/');
    const firstInstall = await exerciseBundledPanel(firstPage, expectedBundle, { startupStartedAt, navigationStartedAt, output, browserName: 'chromium' });
    firstInstall.inline = await exerciseInlineLayout(firstPage, { core, data: expectedBundle.data, output, browserName: 'chromium-bundled' });
    firstInstall.logos = await exercisePanelLogos(firstPage, expectedBundle.windows.all);
    await firstPage.screenshot({ path: path.join(output, 'chromium-first-install.png'), fullPage: true, animations: 'disabled' });
    const blockedHosts = await worker.evaluate(async () => Promise.all(
      ['https://api.github.com/', 'https://raw.githubusercontent.com/', 'https://codeload.github.com/'].map(async (url) => {
        try { await fetch(url); return { url, blocked: false }; }
        catch { return { url, blocked: true }; }
      })
    ));
    assert.ok(blockedHosts.every(({ blocked }) => blocked), 'Deterministic extension workers must have no GitHub network access.');
    const localArchive = await archiveFixture(root, core);
    const archive = await worker.evaluate(browserArchiveCheck, localArchive.payload);
    assertArchiveResult(archive, localArchive);
    const setupPopup = await context.newPage();
    await firstPage.bringToFront();
    await setupPopup.goto(`${extensionUrl}/popup.html`);
    await setupPopup.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
    assert.equal(await setupPopup.locator('#window-select').inputValue(), 'all');
    assert.match(await setupPopup.locator('#window-note').textContent(), /Bundled snapshot/i);
    assert.deepEqual(await setupPopup.locator('.company-name').allTextContents(), expectedBundle.windows.all.slice(0, 5).map(({ name }) => name));
    const offlineStatus = await setupPopup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'LCT_STATUS' })).status);
    assert.equal(offlineStatus.hasData, true);
    assert.equal(offlineStatus.dataSource, 'bundled');
    assert.equal(offlineStatus.commit, expectedBundle.data.commit);
    firstInstall.bundledPopup = await exerciseBundledPopup(chromiumExplorerDriver(setupPopup), firstPage, expectedBundle, core);
    firstInstall.windowNote = firstInstall.bundledPopup.windowNote;
    firstInstall.popupLogos = await exercisePopupLogos(chromiumExplorerDriver(setupPopup), expectedBundle.windows.all.slice(0, 5).map(company => company.name));
    firstInstall.popup = 'Actual packaged popup displays the same bundled all-time tags and source date.';
    const unrelatedPage = await context.newPage();
    await unrelatedPage.goto('https://example.com/');
    await unrelatedPage.bringToFront();
    assert.equal(await unrelatedPage.locator('#company-lens-root').count(), 0);
    await setupPopup.reload();
    await setupPopup.locator('#explore-dataset').waitFor({ state: 'visible' });
    const openedExplorer = context.waitForEvent('page');
    await setupPopup.getByRole('button', { name: 'Explore dataset', exact: true }).click();
    const explorerPage = await openedExplorer;
    await explorerPage.waitForURL((url) => url.pathname === '/explore.html');
    const explorer = await exerciseExplorer(chromiumExplorerDriver(explorerPage),
      { data: expectedBundle.data, core, output, browserName: 'chromium' });
    explorer.openedFrom = 'Actual toolbar popup while example.com was active, using bundled data with GitHub hosts blocked.';
    await explorerPage.close();
    await unrelatedPage.close();
    await seedFromPopup(setupPopup);
    await context.close();
    context = await playwright.chromium.launchPersistentContext(profile, deterministicOptions);
    await prepare(context);
    const { results, errors, popup, nativePopup } = await exercise(context, extensionUrl, 'chromium');
    results.unshift(firstInstall.check, firstInstall.popup, firstInstall.bundledPopup.check, firstInstall.logos.check, firstInstall.popupLogos.check, ...explorer.checks,
      'Native browser deflate-raw decoder extracts every real source archive CSV with CRC and Git blob validation.',
      'GitHub API, raw-file and codeload hosts are blocked in the browser resolver, including extension service-worker requests.');
    assert.deepEqual(errors, [], 'Unexpected page errors');
    let live;
    if (process.argv.includes('--live')) {
      const liveSeed = JSON.parse(await readFile(path.join(root, 'output', 'live-source', 'storage.json'), 'utf8'));
      assert.ok(core.companiesForSlug(liveSeed.lctData, 'two-sum').length, 'Live source check must have saved a valid storage fixture first.');
      await popup.evaluate(async (data) => {
        const api = globalThis.browser || globalThis.chrome;
        await api.alarms.clearAll();
        await api.storage.local.set({ ...data, lctStage: null, lctSettings: { enabled: true, collapsed: false } });
      }, liveSeed);
      await context.close();
      context = await playwright.chromium.launchPersistentContext(profile, options);
      await prepare(context, false);
      const network = [];
      context.on('response', (response) => {
        if (response.url().startsWith('https://api.github.com/repos/liquidslr/leetcode-company-wise-problems/'))
          network.push({ url: response.url(), status: response.status() });
      });
      const livePopup = await context.newPage();
      await livePopup.goto(`${extensionUrl}/popup.html`);
      const started = Date.now();
      const refreshResult = await livePopup.evaluate(() => chrome.runtime.sendMessage({ type: 'LCT_REFRESH' }));
      let observed;
      const history = [];
      for (let attempt = 0; attempt < 180; attempt++) {
        observed = await livePopup.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({ type: 'LCT_STATUS' });
          return { ...response, browserTime: new Date().toISOString() };
        });
        if (history.at(-1)?.status?.phase !== observed.status?.phase) history.push(observed);
        if (observed.status?.phase === 'error') break;
        if (observed.status?.phase === 'idle' && Date.parse(observed.status.lastCheckedAt) >= started) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await writeFile(path.join(output, 'live-browser-debug.json'), JSON.stringify({ started, refreshResult, history, observed, network }, null, 2));
      assert.notEqual(observed.status?.phase, 'error', observed.status?.message);
      live = await livePopup.evaluate(async () => {
        const { lctStatus } = await chrome.storage.local.get('lctStatus');
        const tags = await chrome.runtime.sendMessage({ type: 'LCT_GET', slug: 'two-sum' });
        return { commit: lctStatus.commit, lastCheckedAt: lctStatus.lastCheckedAt,
          companyCount: lctStatus.companyCount, problemCount: lctStatus.problemCount,
          twoSumCompanies: tags.companies.length };
      });
      assert.ok(Date.parse(live.lastCheckedAt) >= started, `Live refresh timestamp ${live.lastCheckedAt} did not advance past ${new Date(started).toISOString()}`);
      // Extension worker responses are not consistently emitted as context
      // response events. Confirm the network operation through the real worker's
      // syncing -> idle state and its newly published successful-check timestamp.
      assert.equal(refreshResult.status.phase, 'syncing');
      assert.equal(observed.status.phase, 'idle');
      live.refresh = { before: liveSeed.lctStatus.lastCheckedAt, after: live.lastCheckedAt,
        phases: [refreshResult.status.phase, observed.status.phase] };
      const livePage = await context.newPage();
      await livePage.goto('https://leetcode.com/problems/two-sum/description/');
      await livePage.locator('#company-lens-root .companies a').first().waitFor();
      await livePage.evaluate(() => document.documentElement.classList.add('dark'));
      await livePage.locator('#company-lens-root[data-dark]').waitFor();
      await livePage.screenshot({ path: path.join(output, 'chromium-live-data.png'), fullPage: true, animations: 'disabled' });
      results.push('Actual extension background fetched current GitHub metadata using declared permissions and displayed live-source Two Sum tags.');
    }
    return { status: 'passed', mode: 'actual unpacked extension', firstInstall, archive, explorer, nativePopup, results, live };
  } finally { await context.close(); }
}

// Firefox uses a real temporary add-on installation through its debug protocol;
// that separate check is scripts/firefox-smoke.mjs, not Chrome-style sideloading.
for (const [name, run] of [['chromium', chromiumRun]]) {
  try { report[name] = await run(); }
  catch (error) { report[name] = { status: 'failed', error: error.stack }; process.exitCode = 1; }
  console.log(`${name}: ${report[name].status}${report[name].error ? `\n${report[name].error}` : ''}`);
}
report.finishedAt = new Date().toISOString();
await writeFile(path.join(output, 'smoke-results.json'), JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--live')) await writeFile(path.join(output, 'chromium-live-results.json'), JSON.stringify(report, null, 2) + '\n');
