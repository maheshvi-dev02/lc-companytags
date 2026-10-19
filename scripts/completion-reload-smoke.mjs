import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
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
const data = JSON.parse(gunzipSync(await readFile(path.join(extension, 'data/snapshot.json.gz'))));
for (const slug of Object.keys(data.problems)) fixture.setStatus(slug, null);
const directRequests = [];
let context;
try {
  context = await playwright.chromium.launchPersistentContext(path.join(output, 'completion-reload-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  context.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = new URL(worker.url()), base = url.protocol + '//' + url.host;
  await context.addCookies([{ name: 'company_lens_test_session', value: 'alpha', url: 'https://leetcode.com/', httpOnly: true, secure: true, sameSite: 'None' }]);
  await context.route(/^https:\/\/(?:www\.)?leetcode\.(?:com|cn)\//, async route => {
    if (route.request().serviceWorker()) directRequests.push({ url: route.request().url(), method: route.request().method(), cookie: (await route.request().allHeaders()).cookie });
    await fixture.route(route);
  });
  const page = await context.newPage();
  fixture.setStatus('two-sum', 'ac');
  const route = base + '/explore.html?mode=problems&query=two-sum';
  const tick = page.locator('#results [data-slug="two-sum"] .completion-indicator');
  const ready = () => page.waitForFunction(() => document.querySelector('#completion-status').dataset.state === 'ready');
  const pending = async () => {
    for (let i = 0; i < 150 && !fixture.pending.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fixture.pending.length, 1);
  };
  await page.goto(route); await tick.waitFor({ state: 'visible' }); await ready();
  await page.addInitScript(() => {
    globalThis.firstTickVisible = null;
    new MutationObserver(() => {
      const tick = document.querySelector('#results [data-slug="two-sum"] .completion-indicator');
      if (tick && globalThis.firstTickVisible === null) globalThis.firstTickVisible = !tick.hidden;
    }).observe(document, { childList: true, subtree: true });
  });
  fixture.state.holdNext = true;
  await page.reload(); await tick.waitFor({ state: 'attached' }); await pending();
  assert.equal(await tick.isVisible(), true, 'Tick is visible while the new catalog response is held.');
  assert.equal(await page.evaluate(() => firstTickVisible), true, 'The first rendered row already includes the tick.');
  assert.equal(await page.locator('#completion-status').getAttribute('data-state'), 'refreshing');
  fixture.releaseAll(); await ready();
  report.checks.push('Reload renders cached ticks with the first rows, before a delayed catalog response');
  fixture.state.holdNext = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await pending();
  assert.equal(await tick.isVisible(), true); fixture.releaseAll(); await ready();
  report.checks.push('Focus revalidation does not blank existing ticks');
  fixture.setAccount('beta'); fixture.setStatus('two-sum', null);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await ready();
  assert.equal(await tick.isVisible(), false);
  fixture.setStatus('two-sum', 'ac');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await ready();
  assert.equal(await tick.isVisible(), true);
  fixture.setAccount(null);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#completion-status').dataset.state === 'signed-out');
  assert.equal(await tick.isVisible(), false);
  await page.reload(); await tick.waitFor({ state: 'attached' });
  assert.equal(await tick.isVisible(), false);
  report.checks.push('Account changes replace cached marks; sign-out clears the cache across reload');
  assert.deepEqual(report.pageErrors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  fixture.releaseAll(); if (context) await context.close();
  await writeFile(path.join(output, 'completion-reload-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
