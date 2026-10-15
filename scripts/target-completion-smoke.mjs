import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompletionFixture } from './browser-completion.mjs';
import { problemFixture } from './browser-first-install.mjs';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch {}
}
assert.ok(playwright, 'Use the installed Playwright runtime.');
let executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath && process.env.LOCALAPPDATA) {
  const dir = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const versions = (await readdir(dir)).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  executablePath = path.join(dir, versions[0], 'chrome-win64/chrome.exe');
}
const output = path.join(root, 'output/playwright'), extension = path.join(root, 'dist/chrome');
await mkdir(output, { recursive: true });
const report = { version: JSON.parse(await readFile(path.join(extension, 'manifest.json'))).version, checks: [], pageErrors: [] };
const fixture = createCompletionFixture({ html: problemFixture() });
let context;
try {
  context = await playwright.chromium.launchPersistentContext(path.join(output, 'target-completion-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  context.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = new URL(worker.url()), base = url.protocol + '//' + url.host;
  await context.route(/^https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//, fixture.route);
  const leetcode = await context.newPage();
  await leetcode.goto('https://leetcode.com/problems/two-sum/');
  const page = await context.newPage();
  await page.goto(base + '/explore.html?mode=target');
  await page.locator('#target-company option[value="Microsoft"]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#target-generate').disabled);
  const ready = async p => p.waitForFunction(() => document.querySelector('#target-completion-status')?.dataset.state === 'ready');
  const checked = p => p.locator('#target-results .completion-indicator:not([hidden])').count();
  const slugs = p => p.locator('#target-results .target-question').evaluateAll(rows => rows.map(row => row.dataset.slug));
  const refresh = async p => { await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await ready(p); };
  await page.locator('#target-plan').click();
  await page.locator('#target-company').evaluate(select => {
    select.querySelector('option[value="Microsoft"]').selected = true;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#target-generate').click();
  await page.waitForFunction(() => document.querySelectorAll('#target-results > li').length === 20 && document.querySelector('.target-saved-entry'));
  await ready(page);
  const originalSlugs = await slugs(page);
  fixture.setStatus(originalSlugs[0], 'ac'); fixture.setStatus(originalSlugs[1], 'ac');
  await refresh(page);
  assert.equal(await checked(page), 2);
  await page.reload(); await ready(page);
  assert.equal(await checked(page), 2); assert.deepEqual(await slugs(page), originalSlugs);
  report.checks.push('New All-problems plan and reopened saved list check live LeetCode status');
  fixture.setStatus(originalSlugs[2], 'ac');
  await refresh(page); assert.equal(await checked(page), 3); assert.deepEqual(await slugs(page), originalSlugs);
  fixture.setStatus(originalSlugs[3], '__missing__');
  await refresh(page); assert.match(await page.locator('#target-completion-status').innerText(), /1 status unavailable/);
  report.checks.push('Returning after solving refreshes checkmarks without removing or reordering saved questions; unknown remains explicit');
  fixture.setAccount('beta'); fixture.setStatus(originalSlugs[4], 'ac');
  await refresh(page); assert.equal(await checked(page), 1);
  assert.equal(await page.locator('#target-results .completion-indicator:not([hidden])').evaluate(el => el.closest('li').dataset.slug), originalSlugs[4]);
  fixture.setAccount(null);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#target-completion-status').dataset.state === 'signed-out');
  assert.equal(await checked(page), 0);
  fixture.setAccount('alpha'); await refresh(page);
  report.checks.push('Account switch and sign-out clear stale account checkmarks');
  const before = await page.evaluate(() => chrome.storage.local.get('lctTargetCollection'));
  const stored = before.lctTargetCollection;
  assert.ok(!JSON.stringify(stored).includes('completed'));
  // Hold a reply for the plan, then switch to a random result. It must not paint the new rows.
  fixture.state.holdNext = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (let tries = 0; !fixture.pending.length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.pending.length, 1);
  await page.locator('#target-random').click(); await page.locator('#target-generate').click();
  await page.waitForFunction(() => document.querySelectorAll('#target-results > li').length === 1);
  fixture.releaseAll(); await ready(page);
  const randomSlugs = await slugs(page);
  assert.equal(await checked(page), Number(fixture.completed(randomSlugs[0])));
  report.checks.push('Late completion reply cannot paint a different Target result');
  // Restore the saved plan and exercise the same implementation in popup.html.
  await page.locator('#target-collection').evaluate(el => { el.open = true; });
  await page.locator('.target-saved-open').first().click(); await ready(page);
  const popup = await context.newPage(); await popup.goto(base + '/popup.html');
  await popup.locator('#mode-target').click(); await ready(popup);
  assert.deepEqual(await slugs(popup), originalSlugs); assert.equal(await checked(popup), 3);
  const after = await popup.evaluate(() => chrome.storage.local.get('lctTargetCollection'));
  assert.deepEqual(after.lctTargetCollection, stored);
  await popup.screenshot({ path: path.join(output, 'target-completion-popup.png'), fullPage: true });
  await page.bringToFront(); await ready(page);
  await page.screenshot({ path: path.join(output, 'target-completion-fullpage.png'), fullPage: true });
  await leetcode.close(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#target-completion-status').dataset.state === 'no-tab');
  assert.equal(await checked(page), 0);
  report.checks.push('Popup completion route works; saved collection stays account-free; closing LeetCode clears checkmarks with guidance');
  assert.deepEqual(fixture.forbidden, []); assert.deepEqual(report.pageErrors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  fixture.releaseAll(); if (context) await context.close();
  const dest = path.join(output, 'target-completion-report.json');
  await writeFile(dest, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
