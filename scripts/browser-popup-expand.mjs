import assert from 'node:assert/strict';
import path from 'node:path';
import { expectTexts } from './browser-first-install.mjs';
import { chromiumExplorerDriver } from './browser-explorer.mjs';

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

// Tests the packaged popup document in an ordinary extension tab. Pointer and
// keyboard input are trusted browser input; this is not native toolbar UI input.
export async function exercisePopupExpand(context, popup, problemPage, {
  core, data, extensionUrl, output, browserName = 'chromium', company = 'Walmart Labs',
  slug = 'longest-substring-without-repeating-characters',
}) {
  const ui = chromiumExplorerDriver(popup);
  const worker = context.serviceWorkers().find(item => item.url().startsWith(extensionUrl));
  assert.ok(worker);
  const openedPages = [];
  const result = { company, slug, mode: 'Packaged popup.html test tab with trusted pointer/keyboard input',
    activations: [], layouts: [], checks: [], screenshots: [] };
  const originalSettings = await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get(['lctSettings', 'lctExplorerSorts', 'lctPopupPracticeSort']);
    const create = chrome.tabs.create.bind(chrome.tabs), openPopup = chrome.action.openPopup;
    const audit = globalThis.__popupExpandAudit = { calls: [], created: [], popupCalls: 0, holdNext: false,
      failNext: false, pending: false, release: null };
    chrome.tabs.create = async properties => {
      audit.calls.push({ ...properties });
      if (audit.failNext) { audit.failNext = false; throw new Error('Injected isolated-browser create failure'); }
      if (audit.holdNext) {
        audit.holdNext = false; audit.pending = true;
        await new Promise(resolve => { audit.release = () => { audit.pending = false; audit.release = null; resolve(); }; });
      }
      const tab = await create(properties);
      audit.created.push({ id: tab.id, windowId: tab.windowId, active: tab.active });
      return tab;
    };
    chrome.action.openPopup = async () => { audit.popupCalls++; throw new Error('Practice expand must open a full page.'); };
    audit.restore = () => { audit.release?.(); chrome.tabs.create = create; chrome.action.openPopup = openPopup; };
    return stored;
  });
  const questions = selection => {
    const source = core.practiceQuestions(data, { ...selection, limit: 100 });
    const all = [...source.questions];
    while (all.length < source.total) {
      const page = core.practiceQuestions(data, { ...selection, offset: all.length, limit: 100 });
      assert.ok(page.questions.length); all.push(...page.questions);
    }
    return { ...source, questions: all };
  };
  const popupRows = async selection => expectTexts(popup.locator('#practice-questions .question-title'),
    questions(selection).questions.slice(0, 20).map(row => row.title));
  const settle = () => popup.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const button = popup.getByRole('button', { name: 'Open company practice full page', exact: true });
  async function openPractice(name) {
    if (await popup.locator('#search').isVisible()) await popup.locator('#search').fill(name);
    await popup.locator(`#companies .practice-company[data-company=${JSON.stringify(name)}]`).click();
    await expectTexts(popup.locator('#practice-title'), [name]);
    await popup.locator('#practice-questions .question-title').first().waitFor();
  }
  async function assertRows(explorer, expected) {
    await expectTexts(explorer.locator('#detail-results .question-title'), expected.map(row => row.title));
    const observed = await explorer.locator('#detail-results .question-row').evaluateAll(nodes => nodes.map(row => ({
      slug: row.dataset.slug, title: row.querySelector('.question-title').textContent,
      meta: row.querySelector('.question-meta').textContent,
      topics: row.querySelector('.question-topics')?.textContent || '',
      href: row.querySelector('.leetcode-link').href,
    })));
    assert.deepEqual(observed, expected.map(row => ({ slug: row.slug, title: row.title,
      meta: `${row.difficulty || 'Difficulty unavailable'} · ${core.formatAcceptanceRate(row.acceptanceRate) === null ? 'Acceptance unavailable' : `Acceptance ${core.formatAcceptanceRate(row.acceptanceRate)}`} · score ${Number.isFinite(row.frequency) && row.frequency >= 0 ? row.frequency : 'unavailable'} · ${Number.isInteger(row.rank) && row.rank > 0 ? `company rank #${row.rank}` : 'rank unavailable'} · ${Number.isInteger(row.companyCount) && row.companyCount >= 0 ? `${row.companyCount.toLocaleString('en')} ${row.companyCount === 1 ? 'company' : 'companies'} in this window` : 'Company count unavailable'}`,
      topics: row.topics.join(' · '), href: `https://leetcode.com/problems/${row.slug}/`,
    })));
  }
  async function verifyOpened(explorer, selection, activation, complete = false) {
    openedPages.push(explorer);
    await explorer.waitForURL(url => url.pathname === '/explore.html');
    const url = new URL(explorer.url());
    assert.equal(`${url.protocol}//${url.host}`, extensionUrl);
    for (const [key, value] of Object.entries({ mode: 'companies', ...selection })) assert.equal(url.searchParams.get(key) || '', value, `Deep link must carry ${key}.`);
    const expected = questions(selection);
    await expectTexts(explorer.locator('#detail-title'), [selection.company]);
    for (const [selector, value] of [['#window-select', selection.window], ['#difficulty-select', selection.difficulty],
      ['#topic-select', selection.topic], ['#detail-sort-select', selection.sort]]) assert.equal(await explorer.locator(selector).inputValue(), value);
    assert.equal(await explorer.locator('#mode-companies').getAttribute('aria-selected'), 'true');
    assert.equal(await explorer.locator('#search-view').isVisible(), false);
    await assertRows(explorer, expected.questions.slice(0, 50));
    assert.equal(await explorer.locator('#detail-source').getAttribute('href'), expected.sourceUrl);
    const identity = await worker.evaluate(async () => {
      const created = __popupExpandAudit.created.at(-1);
      const active = (await chrome.tabs.query({ active: true, windowId: created.windowId }))[0];
      return { created, activeId: active.id };
    });
    assert.equal(identity.activeId, identity.created.id);
    assert.equal(identity.created.windowId, sourceWindowId);
    assert.equal(identity.created.active, true);
    await eventually(() => button.isEnabled(), true, 'Expand must re-enable after opening.');
    assert.equal(popup.isClosed(), false);
    assert.equal(await popup.locator('#practice-view').isVisible(), true);
    await popupRows(selection);
    if (complete) {
      let count = Math.min(50, expected.questions.length);
      while (count < expected.questions.length) {
        await explorer.locator('#detail-load-more').click();
        count = Math.min(count + 50, expected.questions.length);
        await assertRows(explorer, expected.questions.slice(0, count));
      }
      assert.equal(await explorer.locator('#detail-load-more').isVisible(), false);
      const slugs = await explorer.locator('#detail-results .question-row').evaluateAll(nodes => nodes.map(row => row.dataset.slug));
      assert.equal(new Set(slugs).size, expected.questions.length);
      result.completeRows = expected.questions.length;
    }
    result.activations.push({ activation, selection, total: expected.total, nativeTab: identity.created, complete });
    return explorer;
  }
  async function activate(selection, activation = 'pointer', complete = false) {
    await popup.bringToFront(); await button.scrollIntoViewIfNeeded(); await settle();
    const before = await worker.evaluate(() => __popupExpandAudit.calls.length);
    const opening = context.waitForEvent('page');
    if (activation === 'pointer') await button.click();
    else {
      await popup.locator('#back-companies').focus(); await popup.keyboard.press('Tab');
      assert.equal(await button.evaluate(node => node === document.activeElement), true, 'Tab from Back must reach expand.');
      assert.equal(await button.evaluate(node => node.matches(':focus-visible')), true);
      await button.press(activation);
    }
    const explorer = await verifyOpened(await opening, selection, activation, complete);
    assert.equal(await worker.evaluate(() => __popupExpandAudit.calls.length), before + 1);
    return explorer;
  }
  async function layout(label) {
    for (const theme of ['light', 'dark']) {
      await popup.bringToFront(); await popup.emulateMedia({ colorScheme: theme });
      await popup.setViewportSize({ width: 440, height: 600 });
      await button.scrollIntoViewIfNeeded(); await settle(); await popup.mouse.move(0, 0);
      const geometry = await button.evaluate(node => {
        const box = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const header = node.closest('.practice-header');
        return { button: box(node), icon: box(node.querySelector('svg')), header: box(header),
          back: box(document.querySelector('#back-companies')), title: box(document.querySelector('#practice-title')),
          documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
      });
      assert.equal(geometry.button.width, 28); assert.equal(geometry.button.height, 28);
      assert.equal(geometry.icon.width, 16); assert.equal(geometry.icon.height, 16);
      assert.equal(geometry.header.right - geometry.button.right, 0);
      assert.ok(geometry.back.right <= geometry.button.left && geometry.title.right <= 440);
      assert.ok(geometry.documentWidth <= 440);
      result.layouts.push({ label, theme, ...geometry });
      const filename = path.join(output, `${browserName}-practice-expand-${label}-${theme}.png`);
      await popup.screenshot({ path: filename, animations: 'disabled' }); result.screenshots.push(filename);
    }
  }
  let sourceWindowId;
  try {
    await ui.select('#window-select', 'all');
    const currentTitle = await popup.locator('#problem-title').textContent();
    const defaultSelection = { company, window: 'all', difficulty: '', topic: '', sort: 'frequency-desc' };
    await openPractice(company); await ui.select('#practice-sort-select', 'frequency-desc'); await popupRows(defaultSelection);
    assert.equal(await button.getAttribute('id'), 'expand-practice');
    assert.equal(await button.getAttribute('type'), 'button');
    assert.equal(await button.getAttribute('title'), 'Open company practice full page');
    assert.equal(await button.locator('svg').getAttribute('aria-hidden'), 'true');
    await popup.bringToFront();
    sourceWindowId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    await layout('walmart');
    const explorer = await activate(defaultSelection, 'pointer', true);
    const screenshot = path.join(output, `${browserName}-practice-expand-explorer-complete.png`);
    await explorer.setViewportSize({ width: 1280, height: 900 });
    await explorer.evaluate(() => scrollTo(0, 0));
    await explorer.screenshot({ path: screenshot, animations: 'disabled' }); result.screenshots.push(screenshot);
    await explorer.locator('#detail-back').click(); await explorer.locator('#search-view').waitFor({ state: 'visible' });
    assert.equal(await explorer.locator('#mode-companies').getAttribute('aria-selected'), 'true');
    await explorer.locator('#global-search').fill(company);
    await expectTexts(explorer.locator('#results .company-name'), core.searchCompanies(data, { window: 'all', query: company, sort: 'name-asc', limit: 50 }).companies.map(row => row.name));
    await explorer.close();
    const filtered = { company, window: 'older', difficulty: 'Medium', topic: 'Hash Table', sort: 'name-desc' };
    await ui.select('#window-select', filtered.window); await ui.select('#difficulty-select', filtered.difficulty);
    await popup.locator('#topic-input').fill(filtered.topic); await ui.select('#practice-sort-select', filtered.sort); await popupRows(filtered);
    assert.ok(questions(filtered).total > 0);
    const filteredExplorer = await activate(filtered, 'Enter');
    const filteredShot = path.join(output, `${browserName}-practice-expand-explorer-filtered.png`);
    await filteredExplorer.setViewportSize({ width: 1280, height: 900 });
    await filteredExplorer.screenshot({ path: filteredShot, animations: 'disabled' }); result.screenshots.push(filteredShot);
    await chromiumExplorerDriver(filteredExplorer).select('#detail-sort-select', 'frequency-desc');
    await assertRows(filteredExplorer, questions({ ...filtered, sort: 'frequency-desc' }).questions.slice(0, 50));
    result.checks.push('An explicitly opened name-desc company view can switch back to stored/default Highest frequency and reorder correctly.');
    await filteredExplorer.close();
    await popup.bringToFront(); await button.scrollIntoViewIfNeeded(); await settle();
    await worker.evaluate(() => { __popupExpandAudit.holdNext = true; });
    const beforeDouble = await worker.evaluate(() => __popupExpandAudit.calls.length);
    const doubleOpening = context.waitForEvent('page');
    const rect = await button.boundingBox();
    await popup.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2, { delay: 20 });
    await eventually(() => worker.evaluate(() => __popupExpandAudit.pending), true);
    assert.equal(await button.isDisabled(), true); assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.equal(await worker.evaluate(() => __popupExpandAudit.calls.length), beforeDouble + 1);
    await worker.evaluate(() => __popupExpandAudit.release());
    await (await verifyOpened(await doubleOpening, filtered, 'rapid double-click')).close();
    assert.equal(await worker.evaluate(() => __popupExpandAudit.calls.length), beforeDouble + 1);
    await popup.bringToFront(); await worker.evaluate(() => { __popupExpandAudit.failNext = true; });
    const countBeforeFailure = context.pages().length;
    await button.click();
    await expectTexts(popup.locator('#practice-open-status'), ['Could not open Company Lens. Try again.']);
    assert.equal(await popup.locator('#practice-open-status').getAttribute('role'), 'status');
    assert.equal(await button.isEnabled(), true); assert.equal(await button.getAttribute('aria-busy'), 'false');
    assert.equal(context.pages().length, countBeforeFailure); await popupRows(filtered);
    await (await activate(filtered, 'Enter')).close();
    assert.equal(await popup.locator('#practice-open-status').isVisible(), false);
    await popup.locator('#back-companies').click(); await popup.locator('#search').fill(''); await ui.select('#window-select', 'all');
    assert.equal(await popup.locator('#problem-title').textContent(), currentTitle);
    await expectTexts(popup.locator('#companies .company-name'), core.companiesForSlug(data, slug, 'all').slice(0, 5).map(row => row.name));
    assert.equal(await button.isVisible(), false);
    const longCompany = data.companies.slice().sort((a, b) => b.name.length - a.name.length).find(row => core.practiceQuestions(data, { company: row.name, window: 'all', limit: 1 }).questions.length);
    const longSlug = core.practiceQuestions(data, { company: longCompany.name, window: 'all', limit: 1 }).questions[0].slug;
    await problemPage.goto(`https://leetcode.com/problems/${longSlug}/`);
    await problemPage.locator('#company-lens-root .company-name').first().waitFor();
    await problemPage.bringToFront(); await popup.reload(); await popup.locator('#companies .company-name').first().waitFor();
    await openPractice(longCompany.name); await layout('long-company');
    result.longCompany = longCompany.name;
    result.calls = await worker.evaluate(() => __popupExpandAudit.calls);
    assert.equal(await worker.evaluate(() => __popupExpandAudit.popupCalls), 0);
    assert.ok(result.calls.every(call => call.active === true && (call.windowId === undefined || call.windowId === sourceWindowId)));
    result.checks.push('Actual popup document pointer/Enter open the company in an active Explorer tab with explicit window, difficulty, topic and sort preserved.',
      'All Walmart company questions match source membership/order/metadata through complete Explorer paging; filtered route matches the saved selection.',
      'Held native tab creation proves duplicate-click protection; injected opening failure retains practice rows and local live feedback, then keyboard retry succeeds.',
      'Popup current-problem view and Explorer Back/global company search remain usable; no action.openPopup calls occur.',
      'The top-right expand icon measures16px within28px; light/dark440×600 and longest bundled company title have no horizontal overflow.');
    return result;
  } finally {
    await worker.evaluate(async original => {
      globalThis.__popupExpandAudit?.restore();
      for (const key of ['lctSettings', 'lctExplorerSorts', 'lctPopupPracticeSort']) {
        if (Object.hasOwn(original, key)) await chrome.storage.local.set({ [key]: original[key] });
        else await chrome.storage.local.remove(key);
      }
    }, originalSettings);
    await Promise.allSettled(openedPages.filter(page => !page.isClosed()).map(page => page.close()));
  }
}
