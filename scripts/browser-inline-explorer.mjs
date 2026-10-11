import assert from 'node:assert/strict';
import path from 'node:path';
import { expectTexts } from './browser-first-install.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function expectValue(read, expected, label) {
  let actual;
  for (let attempt = 0; attempt < 100; attempt++) {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await pause(50);
  }
  assert.deepEqual(actual, expected, label);
}

// The browser APIs are observed in this isolated extension worker. Successful
// calls still reach native tabs.create; only explicit error/race cases are gated.
// This never opens, attaches to, or discovers a native toolbar popup.
export async function exerciseInlineExplorer(context, page, {
  core, data, extensionUrl, output, browserName = 'chromium', slug = 'two-sum', window = '3m',
}) {
  const worker = context.serviceWorkers().find(item => item.url().startsWith(extensionUrl))
    || await context.waitForEvent('serviceworker');
  const host = page.locator('#company-lens-root');
  const button = host.getByRole('button', { name: 'Open Company Lens full page', exact: true });
  const expected = core.companiesForSlug(data, slug, window);
  const problem = core.problemForSlug(data, slug);
  assert.ok(expected.length, 'The selected test window must contain companies.');
  const pages = [];
  const result = { slug, window, companyCount: expected.length, layouts: [], activations: [], checks: [] };
  const original = await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get(['lctSettings', 'lctExplorerSorts']);
    const nativeCreate = chrome.tabs.create.bind(chrome.tabs);
    const nativePopup = chrome.action.openPopup;
    const audit = globalThis.__inlineExplorerAudit = { calls: [], created: [], nativePopupCalls: 0, failNext: false,
      holdNext: false, pending: false, release: null, restore: null };
    chrome.tabs.create = async properties => {
      audit.calls.push({ ...properties });
      if (audit.failNext) { audit.failNext = false; throw new Error('Injected isolated-browser tab creation failure'); }
      if (audit.holdNext) {
        audit.holdNext = false; audit.pending = true;
        await new Promise(resolve => { audit.release = () => { audit.pending = false; audit.release = null; resolve(); }; });
      }
      const created = await nativeCreate(properties);
      audit.created.push({ id: created.id, windowId: created.windowId, active: created.active });
      return created;
    };
    chrome.action.openPopup = async () => { audit.nativePopupCalls++; throw new Error('The inline action must open Explorer.'); };
    audit.restore = () => { audit.release?.(); chrome.tabs.create = nativeCreate; chrome.action.openPopup = nativePopup; };
    return stored;
  });
  try {
    await worker.evaluate(async ({ settings, window }) => {
      await chrome.storage.local.set({ lctSettings: { ...settings, enabled: true, window },
        lctExplorerSorts: { problems: 'relevance', companies: 'name-asc', companyQuestions: 'frequency-desc', problemCompanies: 'frequency-desc' } });
    }, { settings: original.lctSettings, window });
    await expectTexts(host.locator('.company-name'), expected.map(company => company.name));
    await button.waitFor({ state: 'visible' });
    const caption = await host.locator('.window-label').textContent();
    assert.equal(await button.getAttribute('title'), 'Open Company Lens full page');
    assert.equal(await button.getAttribute('type'), 'button');
    assert.equal(await button.locator('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(await button.locator('svg').getAttribute('stroke'), 'currentColor');
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['dark', 375]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => {
        document.documentElement.classList.remove('dark', 'light');
        document.documentElement.classList.add(theme);
      }, theme);
      await page.waitForFunction(theme => document.querySelector('#company-lens-root')?.hasAttribute('data-dark') === (theme === 'dark'), theme);
      const layout = await button.evaluate(node => {
        const box = element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, right: r.right }; };
        return { button: box(node), svg: box(node.querySelector('svg')), host: box(node.getRootNode().host),
          documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
      });
      assert.equal(layout.button.width, 28); assert.equal(layout.button.height, 28);
      assert.equal(layout.svg.width, 16); assert.equal(layout.svg.height, 16);
      assert.ok(layout.host.right <= width && layout.documentWidth <= width);
      result.layouts.push({ theme, ...layout });
      await host.screenshot({ path: path.join(output, `${browserName}-inline-explorer-${theme}-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const sourceTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
    assert.ok(Number.isInteger(sourceTab?.windowId));
    const callCount = () => worker.evaluate(() => __inlineExplorerAudit.calls.length);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    async function verifyExplorer(explorer, activation) {
      pages.push(explorer);
      await explorer.waitForURL(url => url.pathname === '/explore.html');
      const url = new URL(explorer.url());
      assert.equal(`${url.protocol}//${url.host}`, extensionUrl);
      assert.equal(url.searchParams.get('mode'), 'problems');
      assert.equal(url.searchParams.get('query'), '');
      assert.equal(url.searchParams.get('slug'), slug);
      await expectTexts(explorer.locator('#detail-title'), [problem.title]);
      await expectTexts(explorer.locator('#detail-results .company-name'), expected.map(company => company.name));
      assert.equal(await explorer.locator('#window-select').inputValue(), window);
      assert.equal(await explorer.locator('#mode-problems').getAttribute('aria-selected'), 'true');
      assert.equal(await explorer.locator('#search-view').isVisible(), false);
      const rows = await explorer.locator('#detail-results .company-row').evaluateAll(nodes => nodes.map(node => ({
        name: node.querySelector('.company-name').textContent,
        score: node.querySelector('.frequency-score').textContent,
        rank: node.querySelector('.company-rank').textContent,
        source: node.querySelector('.source-link').href,
      })));
      assert.deepEqual(rows, expected.map(company => ({ name: company.name,
        score: company.frequency == null ? '—' : String(company.frequency),
        rank: company.rank == null ? 'Rank unavailable' : `Company rank #${company.rank}`, source: company.sourceUrl })));
      assert.match(await explorer.locator('#detail-context').textContent(), new RegExp(problem.difficulty));
      assert.equal(await explorer.locator('#detail-context .acceptance-rate').textContent(),
        core.formatAcceptanceRate(problem.acceptanceRate) === null ? 'Acceptance unavailable' : `Acceptance ${core.formatAcceptanceRate(problem.acceptanceRate)}`);
      const active = await worker.evaluate(async windowId => (await chrome.tabs.query({ active: true, windowId }))[0], sourceTab.windowId);
      // Without the broad tabs permission, query may omit an extension tab's
      // URL. Match its native identity; Playwright already verified the URL.
      const created = await worker.evaluate(() => __inlineExplorerAudit.created.at(-1));
      assert.equal(active.id, created.id);
      assert.equal(active.windowId, sourceTab.windowId);
      assert.equal(await explorer.evaluate(() => chrome.extension.getViews({ type: 'popup' }).includes(window)), false);
      await expectValue(() => button.isEnabled(), true, 'The inline action must re-enable after opening.');
      await expectTexts(host.locator('.company-name'), expected.map(company => company.name));
      assert.equal(await host.locator('.window-label').textContent(), caption);
      result.activations.push({ activation, url: explorer.url(), active: active.active, windowId: active.windowId, rows: rows.length });
      return explorer;
    }
    async function activate(activation) {
      await page.bringToFront(); await button.scrollIntoViewIfNeeded(); await settle();
      const before = await callCount();
      const opening = context.waitForEvent('page');
      if (activation === 'pointer') await button.click();
      else {
        await page.locator('#problem-tags button').last().focus(); await page.keyboard.press('Tab');
        assert.equal(await button.evaluate(node => node.getRootNode().activeElement === node), true, 'Keyboard Tab must reach the inline action.');
        assert.equal(await button.evaluate(node => node.matches(':focus-visible')), true);
        await button.press(activation);
      }
      const explorer = await verifyExplorer(await opening, activation);
      assert.equal(await callCount(), before + 1);
      return explorer;
    }
    const explorer = await activate('pointer');
    await explorer.screenshot({ path: path.join(output, `${browserName}-inline-explorer-current-problem.png`), animations: 'disabled', fullPage: true });
    await explorer.locator('#detail-back').click();
    await explorer.locator('#search-view').waitFor({ state: 'visible' });
    await expectTexts(explorer.locator('#results .result-title'), core.searchProblems(data, { window, sort: 'relevance', limit: 50 }).problems.map(row => row.title));
    await explorer.locator('#global-search').fill('two sum');
    await expectTexts(explorer.locator('#results .result-title'), core.searchProblems(data, { window, query: 'two sum', sort: 'relevance', limit: 50 }).problems.map(row => row.title));
    await explorer.locator('#mode-companies').click();
    await explorer.locator('#global-search').fill(expected[0].name);
    await expectTexts(explorer.locator('#results .company-name'), core.searchCompanies(data, { window, query: expected[0].name, sort: 'name-asc', limit: 50 }).companies.map(row => row.name));
    // A status/storage refresh must not reopen a consumed deep link.
    await worker.evaluate(async () => { const { lctStatus } = await chrome.storage.local.get('lctStatus');
      await chrome.storage.local.set({ lctStatus: { ...lctStatus, lastCheckedAt: new Date().toISOString() } }); });
    await pause(100);
    assert.equal(await explorer.locator('#detail-view').isVisible(), false);
    assert.equal(await explorer.locator('#mode-companies').getAttribute('aria-selected'), 'true');
    await explorer.close();
    for (const activation of ['Enter', 'Space']) await (await activate(activation)).close();

    await page.bringToFront(); await button.scrollIntoViewIfNeeded(); await settle();
    await worker.evaluate(() => { __inlineExplorerAudit.holdNext = true; });
    const beforeDouble = await callCount();
    const doubleOpening = context.waitForEvent('page');
    const box = await button.boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 20 });
    await expectValue(() => worker.evaluate(() => __inlineExplorerAudit.pending), true, 'Actual tab creation must be held during the rapid-click check.');
    assert.equal(await button.isDisabled(), true); assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.equal(await callCount(), beforeDouble + 1, 'Rapid double-click must submit only one tab creation.');
    await worker.evaluate(() => __inlineExplorerAudit.release());
    await (await verifyExplorer(await doubleOpening, 'rapid double-click')).close();
    assert.equal(await callCount(), beforeDouble + 1);

    await page.bringToFront(); await worker.evaluate(() => { __inlineExplorerAudit.failNext = true; });
    const pagesBeforeFailure = context.pages().length;
    await button.focus(); await button.press('Enter');
    await expectTexts(host.locator('.open-feedback'), ['Could not open Company Lens. Try again.']);
    assert.equal(await button.isEnabled(), true); assert.equal(await button.getAttribute('aria-busy'), 'false');
    assert.equal(await host.locator('.window-label').textContent(), caption);
    assert.equal(context.pages().length, pagesBeforeFailure);
    await (await activate('pointer')).close();
    assert.equal(await host.locator('.open-feedback').textContent(), '');

    const invalid = await context.newPage(); pages.push(invalid);
    await invalid.goto(`${extensionUrl}/explore.html?mode=problems&query=two+sum&slug=..%2Ftwo-sum`);
    await invalid.locator('#search-view').waitFor({ state: 'visible' });
    await expectTexts(invalid.locator('#results .result-title'), core.searchProblems(data, { window, query: 'two sum', sort: 'relevance', limit: 50 }).problems.map(row => row.title));
    assert.equal(await invalid.locator('#detail-view').isVisible(), false);
    await invalid.close();
    result.calls = await worker.evaluate(() => __inlineExplorerAudit.calls);
    assert.equal(await worker.evaluate(() => __inlineExplorerAudit.nativePopupCalls), 0);
    assert.ok(result.calls.every(call => call.active === true && call.windowId === sourceTab.windowId));
    result.checks.push(
      'Real pointer, Enter and Space open one active Explorer tab in the source browser window with the current problem, saved time window and exact company metadata.',
      'A held native tabs.create call confirms rapid double-click protection; one injected create failure preserves the caption and supports a successful real retry.',
      'Back, global problem/company search and invalid-route fallback work; later status changes do not reopen the problem, and the inline action never calls action.openPopup.',
      'The accessible outline icon remains 16px in a 28px target at light/dark desktop and 375px widths without widening the inline bar.',
    );
    return result;
  } finally {
    await worker.evaluate(async stored => {
      globalThis.__inlineExplorerAudit?.restore();
      for (const key of ['lctSettings', 'lctExplorerSorts']) {
        if (Object.hasOwn(stored, key)) await chrome.storage.local.set({ [key]: stored[key] });
        else await chrome.storage.local.remove(key);
      }
    }, original);
    await Promise.allSettled(pages.filter(item => !item.isClosed()).map(item => item.close()));
    await page.bringToFront();
  }
}
