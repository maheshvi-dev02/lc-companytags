import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
let context;
try {
  context = await playwright.chromium.launchPersistentContext(path.join(output, 'difficulty-sort-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP raw.githubusercontent.com ~NOTFOUND, MAP codeload.github.com ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  context.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = new URL(worker.url()), base = url.protocol + '//' + url.host;
  const choose = async (p, id, label) => {
    await p.locator('#' + id + '-trigger').scrollIntoViewIfNeeded();
    await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await p.locator('#' + id + '-trigger').click();
    if (await p.locator('#' + id).evaluate(node => node.multiple)) {
      await p.locator('#' + id + '-clear').click();
      const values = Array.isArray(label) ? label : /^All |^Any /.test(label) ? [] : [label];
      for (const item of values) {
        const search = p.locator('#' + id + '-search');
        if (await search.isVisible()) await search.fill(item);
        await p.locator('#' + id + '-options').getByRole('checkbox', { name: item, exact: true }).check();
      }
      assert.equal(await p.locator('#' + id + '-menu').isVisible(), true);
      assert.deepEqual(await p.locator('#' + id).evaluate(node => Array.from(node.selectedOptions, o => o.textContent).filter(Boolean).sort()), [...values].sort());
      await p.keyboard.press('Escape'); return;
    }
    await p.locator('#' + id + '-menu [role="option"]').filter({ hasText: new RegExp('^' + label + '$') }).click();
  };
  const verify = async (p, difficultyId, sortId, fallback) => {
    await choose(p, sortId, 'Easy → hard');
    for (const difficulty of ['Easy', 'Medium', 'Hard']) {
      await choose(p, difficultyId, difficulty);
      assert.equal(await p.locator('#' + sortId).inputValue(), fallback);
      await p.locator('#' + sortId + '-trigger').click();
      assert.equal(await p.locator('#' + sortId + '-menu [data-value^="difficulty-"]').count(), 0);
      assert.equal(await p.locator('#' + sortId + ' option[value^="difficulty-"]').count(), 0);
      await p.keyboard.press('Escape');
    }
    await choose(p, difficultyId, ['Easy', 'Medium']);
    assert.equal(await p.locator('#' + sortId + ' option[value^="difficulty-"]').count(), 2);
    await choose(p, difficultyId, 'All difficulties');
    await p.locator('#' + sortId + '-trigger').click();
    assert.equal(await p.locator('#' + sortId + '-menu [data-value^="difficulty-"]').count(), 2);
    await p.keyboard.press('Escape');
    await choose(p, sortId, 'Hard → easy');
    await choose(p, difficultyId, 'Medium');
    assert.equal(await p.locator('#' + sortId).inputValue(), fallback);
    const nameLabel = sortId === 'practice-sort-select' ? 'Title Z–A' : 'Z–A';
    await choose(p, sortId, nameLabel);
    await choose(p, difficultyId, 'Hard');
    assert.equal(await p.locator('#' + sortId).inputValue(), 'name-desc');
    await choose(p, difficultyId, 'All difficulties');
    assert.equal(await p.locator('#' + sortId).inputValue(), 'name-desc');
  };
  const page = await context.newPage();
  await page.goto(base + '/explore.html');
  await page.locator('#results .question-row').first().waitFor();
  await verify(page, 'problem-difficulty-select', 'sort-select', 'relevance');
  report.checks.push('Problems: Easy/Medium/Hard hide both sorts; All restores them; both active sorts fall back; title sort retained');
  await page.goto(base + '/explore.html?mode=companies&company=Microsoft&difficulty=Medium&sort=difficulty-desc');
  await page.locator('#detail-results .question-row').first().waitFor();
  assert.equal(await page.locator('#detail-sort-select').inputValue(), 'frequency-desc');
  assert.equal(await page.locator('#detail-sort-select option[value^="difficulty-"]').count(), 0);
  await choose(page, 'difficulty-select', 'All difficulties');
  await verify(page, 'difficulty-select', 'detail-sort-select', 'frequency-desc');
  report.checks.push('Company Explorer: same behavior, including initially conflicting route parameters');
  const popup = await context.newPage();
  // Supply only popup tab context; use the actual background and bundled questions.
  await popup.addInitScript(() => {
    chrome.tabs.query = async () => [{ id: 999999 }];
    chrome.tabs.sendMessage = async () => ({ slug: 'two-sum' });
  });
  await popup.goto(base + '/popup.html');
  await popup.locator('#companies .practice-company').first().waitFor();
  await popup.locator('#companies .practice-company').first().click();
  await popup.locator('#practice-questions li').first().waitFor();
  await verify(popup, 'difficulty-select', 'practice-sort-select', 'frequency-desc');
  report.checks.push('Popup company practice: same visibility, fallback, restoration and title-sort preservation');
  assert.deepEqual(report.pageErrors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { if (context) await context.close(); report.contextClosed = true; await writeFile(path.join(output, 'difficulty-sort-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
