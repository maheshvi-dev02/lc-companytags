import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exercisePanelLogos, exercisePopupLogos } from './browser-logos.mjs';
import { chromiumExplorerDriver, exerciseExplorer } from './browser-explorer.mjs';
import { bundledExpectations, exerciseBundledPanel, archiveFixture, browserArchiveCheck, assertArchiveResult, exerciseCollapsedBubble } from './browser-first-install.mjs';

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
      [difficulty, title, frequency, 0.5, link, topics].map(csvCell).join(',')).join('\n');
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
  lctSettings: { enabled: true, collapsed: false },
  lctStage: null,
  lctCache: null,
};
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two Sum - LeetCode</title>
<style>body{margin:0;background:#161616;color:#eee;font:15px system-ui}header{padding:20px 30px;border-bottom:1px solid #373737;color:#ffa116}main{padding:30px;max-width:640px}h1{font-size:26px}.meta{color:#53bb91}pre{padding:18px;background:#252525;border-radius:8px;white-space:pre-wrap}aside{position:absolute;top:84px;left:56%;color:#aaa;padding:24px;border:1px solid #333;width:30%;height:500px}code{color:#75baff}</style>
</head><body><header>LeetCode &nbsp; / &nbsp; Problems</header><main><h1>1. Two Sum</h1><p class="meta">Easy &nbsp; • &nbsp; Array &nbsp; • &nbsp; Hash Table</p>
<p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.</p><h3>Example 1:</h3><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre><p>You may assume that each input would have exactly one solution.</p></main><aside>Code &nbsp; · &nbsp; JavaScript<pre><code>function twoSum(nums, target) {\n  // Your solution\n}</code></pre></aside></body></html>`;

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
  await context.route(/https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//, (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
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

async function panelGeometry(host) {
  return host.evaluate((element) => {
    const shadow = element.shadowRoot;
    const rectangle = (node) => {
      const { x, y, width, height, top, right, bottom, left } = node.getBoundingClientRect();
      return { x, y, width, height, top, right, bottom, left };
    };
    const body = shadow.querySelector('.body');
    const list = shadow.querySelector('.companies');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: rectangle(element),
      body: { ...rectangle(body), scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
      list: { ...rectangle(list), scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
      fifthRow: rectangle(list.querySelectorAll('li')[4]),
      disclosure: rectangle(shadow.querySelector('.show-companies')),
    };
  });
}

async function exercise(context, extensionUrl, browserName) {
  const results = [];
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const popup = await context.newPage();
  await popup.goto(`${extensionUrl}/popup.html`);
  const page = await context.newPage();
  await page.goto('https://leetcode.com/problems/two-sum/description/');

  // The selectors below use accessible names and the real content-script host.
  // Playwright crosses the open shadow root without injecting implementation code.
  const host = page.locator('#company-lens-root');
  await host.waitFor({ state: 'visible' });
  await host.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
  await host.getByRole('link', { name: 'Google, view source', exact: true }).waitFor();
  assert.equal(await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).count(), 0);
  assert.deepEqual(await host.locator('.company-name').allTextContents(), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']);
  assert.deepEqual(await host.locator('.frequency-score').allTextContents(), ['100', '91', '91', '65', '50']);
  assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).locator('.company-rank').textContent(), 'Company rank #2');
  assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).getAttribute('href'), sourceUrl('Amazon'));
  results.push('Actual extension defaults to five companies, ranked by frequency with alphabetical ties.');

  await host.getByRole('button', { name: 'Show all 7 companies' }).click();
  assert.deepEqual(await host.locator('.company-name').allTextContents(), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg', 'Meta', 'Microsoft']);
  assert.equal(await host.locator('.show-companies').getAttribute('aria-expanded'), 'true');
  assert.equal(await host.getByRole('link', { name: 'Meta, view source', exact: true }).locator('.frequency-score').textContent(), '0');
  assert.equal(await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).locator('.frequency-score').textContent(), '—');
  assert.equal(await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).locator('.company-rank').textContent(), 'Rank unavailable');
  await host.getByRole('button', { name: 'Show fewer' }).click();
  assert.equal(await host.locator('.companies a').count(), 5);
  results.push('Show all / Show fewer discloses the complete ranking, preserving zero and unknown scores.');

  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('micro');
  assert.equal(await host.locator('.companies a').count(), 1);
  assert.deepEqual(await host.locator('.company-name').allTextContents(), ['Microsoft']);
  assert.equal(await host.locator('.show-companies').isVisible(), false);
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('unlisted-test-company');
  assert.equal(await host.locator('.companies a').count(), 0);
  assert.match(await host.locator('.empty').textContent(), /No company names match/);
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('');
  assert.equal(await host.locator('.companies a').count(), 5);
  results.push('Search includes companies outside the initial five and gives an empty-search message.');

  // Reload the popup while the problem tab is active, matching a toolbar open.
  await page.bringToFront();
  await popup.reload();
  await popup.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
  assert.deepEqual(await popup.locator('.company-name').allTextContents(), ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']);
  await popup.getByRole('button', { name: 'Show all 7 companies' }).click();
  assert.equal(await popup.locator('#companies a').count(), 7);
  assert.equal(await popup.getByRole('link', { name: 'Meta, view source', exact: true }).locator('.frequency-score').textContent(), '0');
  assert.equal(await popup.getByRole('link', { name: 'Microsoft, view source', exact: true }).locator('.frequency-score').textContent(), '—');
  await popup.getByRole('button', { name: 'Show fewer' }).click();
  await popup.locator('#search').fill('micro');
  assert.deepEqual(await popup.locator('.company-name').allTextContents(), ['Microsoft']);
  assert.equal(await popup.locator('#show-companies').isVisible(), false);
  await popup.locator('#search').fill('');
  assert.equal(await popup.locator('#companies a').count(), 5);
  results.push('Toolbar popup uses the same five-company ranking, disclosure, scores and full-list search.');

  const windowOrders = [
    ['30d', ['Google', 'Meta', 'Amazon', 'Apple', 'Bloomberg']],
    ['3m', ['Spotify', 'Amazon', 'Apple', 'Google', 'Bloomberg']],
    ['6m', ['Meta', 'Amazon', 'Apple', 'Google', 'Spotify']],
    ['older', ['Bloomberg', 'Amazon', 'Apple', 'Google', 'Spotify']],
    ['all', ['Amazon', 'Apple', 'Google', 'Spotify', 'Bloomberg']],
  ];
  for (const [window, names] of windowOrders) {
    await host.locator('.window-select').selectOption(window);
    await expectTexts(host.locator('.company-name'), names);
    await expectTexts(popup.locator('.company-name'), names);
    assert.equal(await popup.locator('#window-select').inputValue(), window);
    if (window === '30d') {
      assert.equal(await host.getByRole('link', { name: 'Amazon, view source', exact: true }).locator('.company-rank').textContent(), 'Company rank #7');
      assert.ok((await host.getByRole('link', { name: 'Amazon, view source', exact: true }).getAttribute('href')).endsWith('/Amazon/1.%20Thirty%20Days.csv'));
    }
  }
  await popup.locator('#window-select').selectOption('30d');
  await expectTexts(host.locator('.company-name'), windowOrders[0][1]);
  await popup.locator('#window-select').selectOption('all');
  await expectTexts(host.locator('.company-name'), windowOrders[4][1]);
  await expectTexts(popup.locator('.company-name'), windowOrders[4][1]);
  results.push('All five time windows rerank companies, source links and per-company ranks; selection synchronizes between panel and popup.');

  const amazonPractice = ['Add Two Numbers', 'Merge Two Sorted Lists', 'Binary Tree Level Order Traversal',
    'Valid Parentheses', 'Longest Substring Without Repeating Characters', 'Maximum Depth of Binary Tree'];
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await host.locator('.practice-view').waitFor({ state: 'visible' });
  await expectTexts(host.locator('.practice-questions .question-title'), amazonPractice);
  assert.equal(await host.locator('.practice-title').textContent(), 'Amazon');
  assert.equal(await host.locator('.practice-questions a').first().getAttribute('href'), 'https://leetcode.com/problems/add-two-numbers/');
  assert.match(await host.locator('.practice-questions .question-meta').first().textContent(), /Medium.*score 180.*company rank #1/);
  await host.locator('.difficulty-select').selectOption('Medium');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Add Two Numbers', 'Binary Tree Level Order Traversal', 'Longest Substring Without Repeating Characters']);
  await host.locator('.topic-input').fill('Tree');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Binary Tree Level Order Traversal']);
  await host.locator('.topic-input').fill('not-a-fixture-topic');
  await host.locator('.practice-summary').filter({ hasText: 'No questions match these filters' }).waitFor();
  await expectTexts(host.locator('.practice-questions .question-title'), []);
  assert.match(await host.locator('.practice-summary').textContent(), /No questions match/);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  await host.locator('.practice-view').waitFor({ state: 'hidden' });

  await popup.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(popup.locator('#practice-questions .question-title'), amazonPractice);
  await popup.locator('#difficulty-select').selectOption('Easy');
  await expectTexts(popup.locator('#practice-questions .question-title'), ['Merge Two Sorted Lists', 'Valid Parentheses', 'Maximum Depth of Binary Tree']);
  await popup.locator('#topic-input').fill('Tree');
  await expectTexts(popup.locator('#practice-questions .question-title'), ['Maximum Depth of Binary Tree']);
  await popup.getByRole('button', { name: 'Back to companies', exact: false }).click();
  results.push('Company practice lists exclude the current problem and support difficulty/topic filtering in both panel and popup.');

  // Progress events and pending-file checkpoints must not disrupt cached results.
  await page.bringToFront();
  await page.waitForTimeout(200);
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await popup.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), amazonPractice);
  await expectTexts(popup.locator('#practice-questions .question-title'), amazonPractice);
  const retainedPanelCompany = await host.locator('.companies a').first().elementHandle();
  const retainedPopupCompany = await popup.locator('#companies a').first().elementHandle();
  const retainedPanelQuestion = await host.locator('.practice-questions a').first().elementHandle();
  const retainedPopupQuestion = await popup.locator('#practice-questions a').first().elementHandle();
  await host.locator('.practice-questions a').first().focus();
  const statusBeforeProgress = await popup.evaluate(async () => (await chrome.storage.local.get('lctStatus')).lctStatus);
  await popup.evaluate(async (status) => {
    await chrome.storage.local.set({ lctStatus: { ...status, phase: 'syncing', completed: 3, total: 35 },
      lctStage: { auditCheckpoint: true }, lctAuditChunk: { progress: 3 } });
  }, statusBeforeProgress);
  await host.locator('.status-message').filter({ hasText: '3 of 35' }).waitFor();
  await page.waitForTimeout(1100); // Includes the SPA-navigation polling interval.
  for (const retained of [retainedPanelCompany, retainedPopupCompany, retainedPanelQuestion, retainedPopupQuestion])
    assert.equal(await retained.evaluate((node) => node.isConnected), true, 'Progress updates must retain existing result links.');
  assert.equal(await retainedPanelQuestion.evaluate((node) => node.getRootNode().activeElement === node), true, 'A focused practice link must survive refresh progress.');
  await popup.evaluate(async (status) => {
    await chrome.storage.local.set({ lctStatus: status, lctStage: null });
    await chrome.storage.local.remove('lctAuditChunk');
  }, statusBeforeProgress);
  for (const retained of [retainedPanelCompany, retainedPopupCompany, retainedPanelQuestion, retainedPopupQuestion]) await retained.dispose();
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  await popup.getByRole('button', { name: 'Back to companies', exact: false }).click();
  results.push('Background sync progress and unrelated storage checkpoints preserve company/practice result nodes and the focused practice link.');

  // Disabling the panel must not retain filtered results under newly reset controls.
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await host.locator('.difficulty-select').selectOption('Medium');
  await host.locator('.topic-input').fill('Tree');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Binary Tree Level Order Traversal']);
  await popup.locator('#enabled').uncheck();
  await host.waitFor({ state: 'detached' });
  await popup.locator('#enabled').check();
  await host.locator('.company-view').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await host.locator('.practice-view').isVisible(), false);
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  assert.equal(await host.locator('.difficulty-select').inputValue(), '');
  assert.equal(await host.locator('.topic-input').inputValue(), '');
  await expectTexts(host.locator('.practice-questions .question-title'), amazonPractice);
  // A pending topic debounce must also be cancelled when the panel is removed.
  await host.locator('.topic-input').fill('Tree');
  await popup.locator('#enabled').uncheck();
  await host.waitFor({ state: 'detached' });
  await popup.locator('#enabled').check();
  await host.locator('.company-view').waitFor({ state: 'visible', timeout: 3000 });
  await page.waitForTimeout(300);
  assert.equal(await host.locator('.practice-view').isVisible(), false);
  // LeetCode can replace page elements; recreating the removed panel resets filters.
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await host.locator('.difficulty-select').selectOption('Medium');
  await host.locator('.topic-input').fill('Tree');
  await expectTexts(host.locator('.practice-questions .question-title'), ['Binary Tree Level Order Traversal']);
  await host.evaluate(element => element.remove());
  await host.locator('.company-view').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await host.locator('.practice-view').isVisible(), false);
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  assert.equal(await host.locator('.difficulty-select').inputValue(), '');
  assert.equal(await host.locator('.topic-input').inputValue(), '');
  await expectTexts(host.locator('.practice-questions .question-title'), amazonPractice);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  results.push('Panel toggles and external removal reset practice state, filter controls, and pending topic input.');

  const collapsedGeometry = await exerciseCollapsedBubble(page, { output, browserName,
    getCollapsed: () => popup.evaluate(async () => Boolean((await chrome.storage.local.get('lctSettings')).lctSettings?.collapsed)),
    setCollapsed: (collapsed) => popup.evaluate(async (value) => {
      const { lctSettings } = await chrome.storage.local.get('lctSettings');
      await chrome.storage.local.set({ lctSettings: { ...lctSettings, collapsed: value } });
    }, collapsed),
  });
  await writeFile(path.join(output, `${browserName}-collapsed-layout.json`), JSON.stringify(collapsedGeometry, null, 2) + '\n');
  results.push(collapsedGeometry.check);

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForFunction(() => document.getElementById('company-lens-root')?.hasAttribute('data-dark'));
  assert.equal(await host.getAttribute('data-dark'), '');
  await page.setViewportSize({ width: 375, height: 667 });
  await host.locator('.body').evaluate((body) => { body.scrollTop = 0; });
  const smallBounds = await host.boundingBox();
  assert.ok(smallBounds.x >= 0 && smallBounds.x + smallBounds.width <= 375, 'Panel fits a narrow viewport');
  const smallGeometry = await panelGeometry(host);
  await page.screenshot({ path: path.join(output, `${browserName}-small.png`), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await host.locator('.body').evaluate((body) => { body.scrollTop = 0; });
  const desktopGeometry = await panelGeometry(host);
  assert.ok(desktopGeometry.fifthRow.bottom <= desktopGeometry.list.bottom + 1, 'Default five rows fit without scrolling inside the company list');
  await writeFile(path.join(output, `${browserName}-layout.json`), JSON.stringify({ desktop: desktopGeometry, narrow: smallGeometry }, null, 2) + '\n');
  results.push('Dark theme follows the page and the panel fits a 375-pixel viewport.');

  await page.screenshot({ path: path.join(output, `${browserName}-problem.png`), fullPage: true, animations: 'disabled' });
  await popup.screenshot({ path: path.join(output, `${browserName}-popup.png`), animations: 'disabled' });

  await host.getByRole('button', { name: 'Show all 7 companies' }).click();
  await page.evaluate(() => history.pushState({}, '', '/problems/add-two-numbers/'));
  await host.locator('.company-view h2').filter({ hasText: 'Add Two Numbers' }).waitFor();
  await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).waitFor();
  assert.deepEqual(await host.locator('.company-name').allTextContents(), ['Google', 'Amazon', 'Meta', 'Apple', 'Microsoft']);
  assert.equal(await host.locator('.companies a').count(), 5);
  assert.equal(await host.locator('.show-companies').getAttribute('aria-expanded'), 'false');
  assert.match(await host.locator('.company-view h2').textContent(), /Add Two Numbers/);
  results.push('SPA navigation replaces and reranks companies, resetting disclosure to five.');

  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), ['Two Sum', ...amazonPractice.slice(1)]);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  results.push('Practice lists update the excluded current problem after SPA navigation.');

  await popup.locator('#enabled').uncheck();
  await host.waitFor({ state: 'detached' });
  await popup.locator('#enabled').check();
  await host.getByRole('link', { name: 'Microsoft, view source', exact: true }).waitFor();
  results.push('Toolbar popup enable/disable updates already-open problem pages.');

  await page.evaluate(() => history.pushState({}, '', '/problems/not-a-listed-problem/'));
  await host.locator('.empty').filter({ hasText: 'No company matches in this dataset.' }).waitFor();
  assert.equal(await host.locator('.companies a').count(), 0);
  results.push('Unknown problems show the dataset coverage message without old tags.');

  await page.evaluate(() => history.pushState({}, '', '/problemset/'));
  await host.waitFor({ state: 'detached' });
  await page.evaluate(() => history.pushState({}, '', '/problems/%2F/'));
  await page.waitForTimeout(1000);
  assert.equal(await host.count(), 0);
  await page.goto('https://leetcode.cn/contest/weekly-contest-100/problems/two-sum/');
  await host.getByRole('link', { name: 'Amazon, view source', exact: true }).waitFor();
  results.push('Off-problem and malformed URLs remove the panel; contest and .cn URLs work.');

  await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://example.com/problems/two-sum/');
  assert.equal(await host.count(), 0);
  results.push('Unrelated websites receive no company panel.');
  return { results, errors, page, popup, host };
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
    firstInstall.popupLogos = await exercisePopupLogos(chromiumExplorerDriver(setupPopup), expectedBundle.windows.all.slice(0, 5).map(company => company.name));
    firstInstall.popup = 'Actual packaged popup displays the same bundled all-time tags and source date.';
    await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
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
    const { results, errors, popup } = await exercise(context, extensionUrl, 'chromium');
    results.unshift(firstInstall.check, firstInstall.popup, firstInstall.logos.check, firstInstall.popupLogos.check, ...explorer.checks,
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
    return { status: 'passed', mode: 'actual unpacked extension', firstInstall, archive, explorer, results, live };
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
