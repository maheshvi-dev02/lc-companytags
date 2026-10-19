import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const core = require('../extension/core.js');
const data = JSON.parse(gunzipSync(await readFile(path.join(root, 'extension/data/snapshot.json.gz'))));
const dir = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
const versions = (await readdir(dir)).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
const extension = path.join(root, 'dist/chrome'), output = path.join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [] };
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'topic-exclusions-profile-' + Date.now()), {
    headless: true, executablePath: path.join(dir, versions[0], 'chrome-win64/chrome.exe'), channel: 'chromium', viewport: { width: 1160, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND, MAP leetcode.com ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().replace('/background.js', '');
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  async function choose(id, topics) {
    await page.locator('#' + id + '-trigger').click();
    await page.locator('#' + id + '-clear').click();
    for (const topic of topics) {
      await page.locator('#' + id + '-search').fill(topic);
      await page.locator('#' + id + '-options input[data-value=' + JSON.stringify(topic) + ']').check();
    }
    await page.keyboard.press('Escape');
  }
  async function summary(id, total) {
    await page.waitForFunction(({ id, total }) => document.getElementById(id)?.textContent.includes(total.toLocaleString()), { id, total });
  }
  const excludedTopics = ['Database', 'Shell'];
  await page.goto(base + '/explore.html?mode=problems&query=');
  await page.waitForFunction(() => document.getElementById('excluded-topics').options.length > 10);
  await choose('excluded-topics', excludedTopics);
  const expected = core.searchProblems(data, { excludedTopics });
  await summary('result-summary', expected.total);
  await page.reload(); await summary('result-summary', expected.total);
  assert.deepEqual(await page.locator('#excluded-topics').evaluate(el => [...el.selectedOptions].map(o => o.value)), excludedTopics);
  assert.equal(await page.locator('#results > li .question-topics').evaluateAll(els => els.some(el => /Database|Shell/.test(el.textContent))), false);
  await page.locator('#excluded-topics-trigger').click();
  assert.equal(await page.locator('#excluded-topics-selected .multi-select-chip').count(), 2);
  await page.screenshot({ path: path.join(output, 'topic-exclusions.png') });
  await page.keyboard.press('Escape');
  await page.locator('#problem-view-topics').click();
  await page.waitForFunction(() => document.querySelectorAll('#topic-groups .topic-group').length > 0);
  assert.equal(await page.locator('#topic-groups [data-topic="Database"], #topic-groups [data-topic="Shell"]').count(), 0);
  report.checks.push('Problems auto-apply exclusions, retain them on reload, show selected chips, and exclude those topic groups');
  await page.goto(base + '/explore.html?mode=companies&company=Amazon&excludedTopic=Database&excludedTopic=Shell');
  const companyExpected = core.practiceQuestions(data, { company: 'Amazon', excludedTopics });
  await summary('detail-summary', companyExpected.total);
  assert.deepEqual(await page.locator('#detail-excluded-topics').evaluate(el => [...el.selectedOptions].map(o => o.value)), excludedTopics);
  await choose('detail-excluded-topics', ['Array']);
  await summary('detail-summary', core.practiceQuestions(data, { company: 'Amazon', excludedTopics: ['Array'] }).total);
  report.checks.push('Company deep links and live checkbox changes preserve exclusions and update counts');
  await page.locator('#mode-target').click();
  await page.waitForFunction(() => document.getElementById('target-excluded-topics').options.length > 10 && !document.getElementById('target-status').disabled);
  await choose('target-excluded-topics', ['Array', 'Database', 'Shell']);
  await page.locator('#target-status-trigger').click();
  await page.locator('#target-status-menu [data-value="all"]').click();
  await page.locator('#target-generate').click();
  await page.locator('#target-results > li').waitFor();
  assert.ok((await page.locator('#target-results .target-question-topics').innerText()).split(' · ').every(topic => !['Array', 'Database', 'Shell'].includes(topic)));
  await page.locator('#target-plan').click();
  await choose('target-company', ['Amazon']);
  await page.locator('#target-generate').click();
  await page.waitForFunction(() => document.querySelectorAll('#target-results > li').length === 20 && document.querySelectorAll('#target-collection-list > li').length === 1);
  const saved = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'LCT_TARGET_LIST' })).targets);
  assert.deepEqual(saved[0].context.excludedTopics, ['Array', 'Database', 'Shell']);
  await page.goto(base + '/explore.html?mode=target');
  await page.waitForFunction(() => document.getElementById('target-excluded-topics')?.selectedOptions.length === 3);
  report.checks.push('Random and company prep apply exclusions; saved Target preferences restore them');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (e) { report.status = 'failed'; report.error = e.stack; process.exitCode = 1; }
finally { await context?.close(); await writeFile(path.join(output, 'topic-exclusions-report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
