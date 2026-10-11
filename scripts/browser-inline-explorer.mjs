import assert from 'node:assert/strict';
import path from 'node:path';
import { expectTexts } from './browser-first-install.mjs';
import { exerciseNativePopup } from './browser-native-popup.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, expected, message) {
  let actual;
  for (let attempt = 0; attempt < 100; attempt++) {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await pause(50);
  }
  assert.deepEqual(actual, expected, message);
}

// Preserve the smoke entry point. Company buttons open Explorer; the separate
// corner action opens a native toolbar popup, observed through its CDP target.
export async function exerciseInlineExplorer(context, page, {
  core, data, extensionUrl, output, browserName = 'chromium', slug = 'two-sum',
}) {
  const worker = context.serviceWorkers().find(item => item.url().startsWith(extensionUrl));
  assert.ok(worker);
  const host = page.locator('#company-lens-root');
  const chip = company => host.getByRole('button', { name: `${company}, open company questions`, exact: true });
  const corner = host.getByRole('button', { name: 'Open Company Lens popup', exact: true });
  const opened = [];
  const result = { slug, activations: [], checks: [] };
  const original = await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get(['lctSettings', 'lctExplorerSorts']);
    const create = chrome.tabs.create.bind(chrome.tabs), popup = chrome.action.openPopup.bind(chrome.action);
    const audit = globalThis.__inlineActionAudit = { calls: [], created: [], popupCalls: 0, failNext: false,
      holdNext: false, pending: false, release: null };
    chrome.tabs.create = async properties => {
      audit.calls.push({ ...properties });
      if (audit.failNext) { audit.failNext = false; throw new Error('Injected isolated-browser create failure'); }
      if (audit.holdNext) {
        audit.holdNext = false; audit.pending = true;
        await new Promise(resolve => { audit.release = () => { audit.pending = false; audit.release = null; resolve(); }; });
      }
      const tab = await create(properties); audit.created.push({ id: tab.id, windowId: tab.windowId, active: tab.active });
      return tab;
    };
    // Forward to the browser, then independently inspect the real popup. A
    // successful API return alone must never count as proof of native UI.
    chrome.action.openPopup = async (...args) => { audit.popupCalls++; return popup(...args); };
    audit.restore = () => { audit.release?.(); chrome.tabs.create = create; chrome.action.openPopup = popup; };
    return stored;
  });
  const setWindow = async window => {
    await worker.evaluate(async window => {
      const { lctSettings } = await chrome.storage.local.get('lctSettings');
      await chrome.storage.local.set({ lctSettings: { ...lctSettings, enabled: true, window } });
    }, window);
    await expectTexts(host.locator('.company-name'), core.companiesForSlug(data, slug, window).map(row => row.name));
    await eventually(() => chip('Google').getAttribute('data-window'), window);
  };
  async function assertRows(explorer, expected) {
    await expectTexts(explorer.locator('#detail-results .question-title'), expected.map(row => row.title));
    const rows = await explorer.locator('#detail-results .question-row').evaluateAll(nodes => nodes.map(node => ({
      slug: node.dataset.slug, meta: node.querySelector('.question-meta').textContent,
      topics: node.querySelector('.question-topics')?.textContent || '', href: node.querySelector('.leetcode-link').href,
    })));
    assert.deepEqual(rows, expected.map(row => ({ slug: row.slug,
      meta: `${row.difficulty || 'Difficulty unavailable'} · ${core.formatAcceptanceRate(row.acceptanceRate) === null ? 'Acceptance unavailable' : `Acceptance ${core.formatAcceptanceRate(row.acceptanceRate)}`} · score ${Number.isFinite(row.frequency) && row.frequency >= 0 ? row.frequency : 'unavailable'} · ${Number.isInteger(row.rank) && row.rank > 0 ? `company rank #${row.rank}` : 'rank unavailable'} · ${Number.isInteger(row.companyCount) && row.companyCount >= 0 ? `${row.companyCount.toLocaleString('en')} ${row.companyCount === 1 ? 'company' : 'companies'} in this window` : 'Company count unavailable'}`,
      topics: row.topics.join(' · '), href: `https://leetcode.com/problems/${row.slug}/`,
    })));
  }
  let sourceWindowId;
  async function verifyExplorer(explorer, company, window, activation, loadMore = false) {
    opened.push(explorer); await explorer.waitForURL(url => url.pathname === '/explore.html');
    const url = new URL(explorer.url());
    assert.equal(`${url.protocol}//${url.host}`, extensionUrl);
    for (const [key, value] of Object.entries({ mode: 'companies', company, window, sort: 'frequency-desc' })) assert.equal(url.searchParams.get(key), value);
    assert.equal(url.searchParams.has('slug'), false);
    const source = core.practiceQuestions(data, { company, window, sort: 'frequency-desc', limit: 50 });
    await expectTexts(explorer.locator('#detail-title'), [company]);
    assert.equal(await explorer.locator('#window-select').inputValue(), window);
    assert.equal(await explorer.locator('#detail-sort-select').inputValue(), 'frequency-desc');
    assert.equal(await explorer.locator('#mode-companies').getAttribute('aria-selected'), 'true');
    await assertRows(explorer, source.questions);
    assert.equal(await explorer.locator('#detail-source').getAttribute('href'), source.sourceUrl);
    let verifiedRows = source.questions.length;
    if (loadMore && source.hasMore) {
      await explorer.locator('#detail-load-more').click();
      const second = core.practiceQuestions(data, { company, window, sort: 'frequency-desc', offset: 50, limit: 50 });
      const expected = [...source.questions, ...second.questions];
      await assertRows(explorer, expected); verifiedRows = expected.length;
      assert.equal(new Set(await explorer.locator('#detail-results .question-row').evaluateAll(nodes => nodes.map(node => node.dataset.slug))).size, verifiedRows);
    }
    const active = await worker.evaluate(async () => {
      const created = __inlineActionAudit.created.at(-1);
      return { created, activeId: (await chrome.tabs.query({ active: true, windowId: created.windowId }))[0].id };
    });
    assert.equal(active.activeId, active.created.id); assert.equal(active.created.active, true); assert.equal(active.created.windowId, sourceWindowId);
    await eventually(() => chip(company).isEnabled(), true);
    assert.equal(await worker.evaluate(() => __inlineActionAudit.popupCalls), 0, 'Company buttons must not request a native popup.');
    result.activations.push({ company, window, activation, total: source.total, verifiedRows, ...active.created });
    return explorer;
  }
  async function activate(company, window, activation, loadMore = false) {
    await page.bringToFront(); await chip(company).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await worker.evaluate(() => __inlineActionAudit.calls.length);
    const opening = context.waitForEvent('page');
    if (activation === 'logo pointer') await chip(company).locator('.company-logo').click();
    else if (activation === 'name pointer') await chip(company).locator('.company-name').click();
    else { await chip(company).focus(); await chip(company).press(activation); }
    const explorer = await verifyExplorer(await opening, company, window, activation, loadMore);
    assert.equal(await worker.evaluate(() => __inlineActionAudit.calls.length), before + 1);
    return explorer;
  }
  try {
    await setWindow('all');
    sourceWindowId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).windowId, page.url());
    assert.equal(await chip('Google').getAttribute('href'), null);
    assert.equal(await chip('Google').getAttribute('type'), 'button');
    const google = await activate('Google', 'all', 'logo pointer', true);
    await google.evaluate(() => scrollTo(0, 0));
    await google.screenshot({ path: path.join(output, `${browserName}-inline-google-questions.png`), animations: 'disabled' });
    await google.locator('#detail-back').click(); await google.locator('#search-view').waitFor({ state: 'visible' });
    await google.locator('#global-search').fill('Google');
    await expectTexts(google.locator('#results .company-name'), core.searchCompanies(data, { query: 'Google', window: 'all', sort: 'name-asc', limit: 50 }).companies.map(row => row.name));
    await google.close();
    await setWindow('3m');
    const alternate = core.companiesForSlug(data, slug, '3m').some(row => row.name === 'Meta') ? 'Meta' : 'Amazon';
    await (await activate(alternate, '3m', 'name pointer', true)).close();
    for (const key of ['Enter', 'Space']) await (await activate('Google', '3m', key)).close();
    await page.bringToFront(); await chip('Google').scrollIntoViewIfNeeded();
    await worker.evaluate(() => { __inlineActionAudit.holdNext = true; });
    const beforeDouble = await worker.evaluate(() => __inlineActionAudit.calls.length);
    const doubleOpening = context.waitForEvent('page');
    const rect = await chip('Google').boundingBox();
    await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2, { delay: 20 });
    await eventually(() => worker.evaluate(() => __inlineActionAudit.pending), true);
    assert.equal(await chip('Google').isDisabled(), true); assert.equal(await chip('Google').getAttribute('aria-busy'), 'true');
    assert.equal(await worker.evaluate(() => __inlineActionAudit.calls.length), beforeDouble + 1);
    assert.equal(await corner.isEnabled(), true, 'Company opening must not disable the independent popup icon.');
    await worker.evaluate(() => __inlineActionAudit.release());
    await (await verifyExplorer(await doubleOpening, 'Google', '3m', 'rapid double-click')).close();
    await page.bringToFront(); await worker.evaluate(() => { __inlineActionAudit.failNext = true; });
    const caption = await host.locator('.window-label').textContent(), countBeforeFailure = context.pages().length;
    await chip('Google').click();
    await expectTexts(host.locator('.company-feedback'), ['Could not open Google questions. Try again.']);
    assert.equal(await chip('Google').isEnabled(), true); assert.equal(await host.locator('.window-label').textContent(), caption);
    assert.equal(context.pages().length, countBeforeFailure);
    await (await activate('Google', '3m', 'Enter')).close();
    assert.equal(await host.locator('.company-feedback').textContent(), '');
    await setWindow('all'); await page.bringToFront();
    const beforeNative = await worker.evaluate(() => __inlineActionAudit.calls.length);
    result.nativePopup = await exerciseNativePopup(context, page, { core, data, extensionUrl, output, browserName, slug });
    assert.equal(await worker.evaluate(() => __inlineActionAudit.calls.length), beforeNative, 'The corner popup icon must not create an Explorer tab.');
    assert.equal(await worker.evaluate(() => __inlineActionAudit.popupCalls), 1);
    result.calls = await worker.evaluate(() => __inlineActionAudit.calls);
    assert.ok(result.calls.every(call => call.active === true && call.windowId === sourceWindowId && new URL(call.url).pathname === '/explore.html'));
    result.checks.push('Trusted direct Google logo click opens its active full-page company view; first page and Load more match exact source membership/order/metadata.',
      'Another company name and a non-default window plus Enter/Space open the selected company/window, never a source CSV or native popup.',
      'Per-company duplicate protection and failed tab creation retry preserve the caption and independent corner icon.',
      'A trusted click on the separate corner icon opens an independently observed native toolbar popup for the current problem without creating a tab.',
      ...result.nativePopup.checks);
    return result;
  } finally {
    await worker.evaluate(async stored => {
      globalThis.__inlineActionAudit?.restore();
      for (const key of ['lctSettings', 'lctExplorerSorts']) {
        if (Object.hasOwn(stored, key)) await chrome.storage.local.set({ [key]: stored[key] }); else await chrome.storage.local.remove(key);
      }
    }, original);
    await Promise.allSettled(opened.filter(item => !item.isClosed()).map(item => item.close()));
    await page.bringToFront();
  }
}
