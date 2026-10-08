import assert from 'node:assert/strict';
import path from 'node:path';

// Both drivers operate the actual packaged document. Firefox extension-process
// tabs are unavailable to Playwright, so its driver uses Mozilla's DOM console.
export function chromiumExplorerDriver(page) {
  return {
    read: (expression) => page.evaluate(expression),
    click: (selector) => page.locator(selector).click(),
    fill: (selector, value) => page.locator(selector).fill(value),
    select: (selector, value) => page.locator(selector).selectOption(value),
    activateWithKeyboard: async (selector) => { await page.locator(selector).focus(); await page.locator(selector).press('Enter'); },
    mutate: (source) => page.evaluate(source),
    screenshot: (filename) => page.screenshot({ path: filename, fullPage: true, animations: 'disabled' }),
    setViewport: (viewport) => page.setViewportSize(viewport),
    viewport: () => page.viewportSize(),
    keyboard: 'Native Chromium keyboard events',
  };
}

export function firefoxExplorerDriver(evaluate) {
  const mutate = async (source) => evaluate(`(() => { ${source}; return 'changed'; })()`);
  return {
    read: async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`)),
    click: (selector) => mutate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    fill: (selector, value) => mutate(`const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true }))`),
    select: (selector, value) => mutate(`const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', { bubbles: true }))`),
    activateWithKeyboard: async (selector) => {
      // RDP cannot issue trusted key input to these tabs. Check native keyboard
      // semantics and focus, then activate the same button through its DOM.
      const semantics = JSON.parse(await evaluate(`JSON.stringify((() => {
        const node = document.querySelector(${JSON.stringify(selector)}); node.focus();
        return { tag: node.tagName, type: node.type, tabIndex: node.tabIndex, role: node.getAttribute('role'), focused: document.activeElement === node };
      })())`));
      assert.equal(semantics.tag, 'BUTTON'); assert.equal(semantics.type, 'button'); assert.equal(semantics.focused, true);
      assert.ok(semantics.tabIndex === 0 || (semantics.role === 'tab' && semantics.tabIndex === -1));
      return mutate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    mutate,
    keyboard: 'Native button semantics/focus inspected through Mozilla RDP; activation uses the actual DOM click',
  };
}

const values = (selector, attribute) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}), node => node.getAttribute(${JSON.stringify(attribute)}))`;
const texts = (selector) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}), node => node.textContent)`;
const visible = (selector) => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
const text = (selector) => `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function expectRead(ui, expression, expected, message) {
  let observed;
  for (let attempt = 0; attempt < 200; attempt++) {
    observed = await ui.read(expression);
    if (JSON.stringify(observed) === JSON.stringify(expected)) return observed;
    await wait(50);
  }
  assert.deepEqual(observed, expected, message);
}
async function expectSummary(ui, selector, total) {
  const expected = total.toLocaleString('en');
  let observed;
  for (let attempt = 0; attempt < 200; attempt++) {
    observed = await ui.read(text(selector));
    if (observed.includes(expected)) return observed;
    await wait(50);
  }
  assert.ok(observed.includes(expected), `${selector} should report the source total ${expected}; got ${observed}`);
}

export async function exerciseExplorer(ui, { data, core, output, browserName }) {
  const checks = [];
  const resultProblems = '#results [data-action="problem"]';
  const resultCompanies = '#results .company-title[data-action="company"]';
  const questionTitles = '#detail-results .question-title';
  const companyNames = '#detail-results .company-name';
  const companyScores = '#detail-results .frequency-score';
  const companyRanks = '#detail-results .company-rank';
  const problemSlugs = () => values(resultProblems, 'data-slug');
  const companyNamesGlobal = () => values(resultCompanies, 'data-company');
  const questions = (company, options = {}) => core.practiceQuestions(data, { company, window: 'all', limit: 50, ...options });
  const companyRecords = (company, window = 'all') => data.files[company + '/' + core.WINDOW_FILES[window]].records;
  const expectQuestions = async (expected) => expectRead(ui, texts(questionTitles), expected.map(({ title }) => title));
  const expectCompanies = async (expected) => {
    await expectRead(ui, texts(companyNames), expected.map(({ name }) => name));
    await expectRead(ui, texts(companyScores), expected.map(({ frequency }) => frequency == null ? '—' : String(frequency)));
    await expectRead(ui, texts(companyRanks), expected.map(({ rank }) => rank == null ? 'Rank unavailable' : `Company rank #${rank}`));
  };
  await expectRead(ui, visible('#global-search'), true);
  await expectRead(ui, 'document.querySelector("#window-select").value', 'all');
  await expectRead(ui, 'document.querySelector("#mode-problems").getAttribute("aria-selected")', 'true');

  // Every catalog comes from the selected complete window, including questions
  // and companies that are absent from the current LeetCode problem's tags.
  const coverage = {};
  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await ui.fill('#global-search', '');
    const expected = core.searchProblems(data, { window, limit: 50 });
    await expectRead(ui, problemSlugs(), expected.problems.map(({ slug }) => slug));
    await expectSummary(ui, '#result-summary', expected.total);
    coverage[window] = expected.total;
  }
  const firstProblems = core.searchProblems(data, { window: 'all', limit: 100 });
  await ui.click('#load-more');
  const first100Problems = await expectRead(ui, problemSlugs(), firstProblems.problems.map(({ slug }) => slug));
  assert.equal(new Set(first100Problems).size, 100);
  checks.push('Global problem catalog covers every complete time window and pages beyond 50 without duplicate or skipped questions.');

  await ui.mutate(`const node = document.querySelector('#global-search'); node.value = 'two sum';
    node.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#load-more').click();`);
  const twoSumSearch = core.searchProblems(data, { query: 'two sum', window: 'all', limit: 50 });
  await expectRead(ui, problemSlugs(), twoSumSearch.problems.map(({ slug }) => slug));
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-problems.png`));
  await ui.activateWithKeyboard('#results [data-action="problem"][data-slug="two-sum"]');
  await expectRead(ui, visible('#detail-view'), true);
  await expectRead(ui, text('#detail-title'), 'Two Sum');
  const expectedTags = core.companiesForSlug(data, 'two-sum', 'all');
  await expectCompanies(expectedTags);
  await expectSummary(ui, '#detail-summary', expectedTags.length);
  await ui.activateWithKeyboard('#detail-results .company-title[data-company="Amazon"]');
  await expectRead(ui, text('#detail-title'), 'Amazon');
  await expectQuestions(questions('Amazon').questions);
  await ui.activateWithKeyboard('#detail-back');
  await expectRead(ui, text('#detail-title'), 'Two Sum');
  await expectCompanies(expectedTags);
  await expectRead(ui, 'document.activeElement?.getAttribute("data-company")', 'Amazon');
  assert.equal(expectedTags.length, 115);
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-two-sum.png`));
  await ui.select('#window-select', '30d');
  await expectCompanies(core.companiesForSlug(data, 'two-sum', '30d'));
  await ui.select('#window-select', 'all');
  await expectCompanies(expectedTags);
  await ui.activateWithKeyboard('#detail-back');
  await expectRead(ui, visible('#results'), true);
  await expectRead(ui, problemSlugs(), twoSumSearch.problems.map(({ slug }) => slug));
  checks.push('Global Two Sum lookup opens all 115 companies sorted by source score with ranks and correctly refreshes its selected window.');

  await ui.activateWithKeyboard('#mode-companies');
  await ui.fill('#global-search', 'Acko');
  await expectRead(ui, companyNamesGlobal(), ['Acko']);
  const acko = core.searchCompanies(data, { query: 'Acko', window: 'all' }).companies[0];
  assert.equal(acko.problemCount, 4);
  assert.equal(expectedTags.some(({ name }) => name === 'Acko'), false);
  await ui.click('#results .company-title[data-action="company"][data-company="Acko"]');
  await expectRead(ui, text('#detail-title'), 'Acko');
  await expectQuestions(questions('Acko').questions);
  await expectSummary(ui, '#detail-summary', 4);
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-acko.png`));
  if (ui.setViewport) {
    const previousViewport = ui.viewport();
    await ui.setViewport({ width: 375, height: 667 });
    const geometry = await ui.read(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: ['#detail-back', '#window-select', '#difficulty-select', '#topic-select', '#question-search', '#detail-results a[href*=problems]'].map(selector => {
        const node = document.querySelector(selector); const rect = node.getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      }) })`);
    assert.equal(geometry.width, 375);
    assert.ok(geometry.scrollWidth <= geometry.width, 'Explorer must not require horizontal scrolling on a 375px viewport.');
    for (const control of geometry.controls) {
      assert.ok(control.width > 0 && control.height > 0, `${control.selector} must remain visible and reachable.`);
      assert.ok(control.left >= 0 && control.right <= geometry.width, `${control.selector} must fit inside the narrow viewport.`);
    }
    if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-acko-small.png`));
    await ui.setViewport(previousViewport);
    checks.push('Explorer fits a 375px viewport without horizontal scrolling; Back, window, filters, search and direct LeetCode actions remain reachable.');
  }
  checks.push('Global company lookup finds Acko independently of current-problem tags and displays all four real source questions.');

  await ui.select('#difficulty-select', 'Hard');
  await expectQuestions(questions('Acko', { difficulty: 'Hard' }).questions);
  await ui.select('#topic-select', 'Math');
  await expectQuestions(questions('Acko', { difficulty: 'Hard', topic: 'Math' }).questions);
  await ui.fill('#question-search', 'parallel');
  await expectQuestions([]);
  await ui.select('#topic-select', '');
  await expectQuestions(questions('Acko', { difficulty: 'Hard', query: 'parallel' }).questions);
  await ui.select('#difficulty-select', 'Easy');
  await expectQuestions([]);
  await ui.fill('#question-search', '');
  await expectQuestions(questions('Acko', { difficulty: 'Easy' }).questions);
  await ui.select('#topic-select', 'Database');
  await expectQuestions(questions('Acko', { difficulty: 'Easy', topic: 'Database' }).questions);
  await ui.select('#difficulty-select', '');
  await ui.select('#topic-select', '');
  await expectQuestions(questions('Acko').questions);
  await ui.select('#window-select', '30d');
  await expectQuestions([]);
  assert.match(await ui.read(text('#detail-summary')), /no questions|0.*questions/i);
  assert.equal(await ui.read('document.querySelector("#detail-source").getAttribute("href")'), core.sourceFileURL(data.commit, 'Acko/' + core.WINDOW_FILES['30d']));
  await ui.click('#detail-back');
  await expectRead(ui, companyNamesGlobal(), ['Acko']);
  assert.match(await ui.read(text('#results')), /0.*questions/i, 'Zero-question companies must still be discoverable.');
  checks.push('Company difficulty/topic/problem-text filters compose correctly; an empty window clears old questions while retaining the company in global search.');

  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await ui.fill('#global-search', '');
    const expected = core.searchCompanies(data, { window, limit: 50 });
    await expectRead(ui, companyNamesGlobal(), expected.companies.map(({ name }) => name));
    await expectSummary(ui, '#result-summary', 470);
  }
  const companyPage = core.searchCompanies(data, { window: 'all', limit: 100 });
  await ui.click('#load-more');
  const first100Companies = await expectRead(ui, companyNamesGlobal(), companyPage.companies.map(({ name }) => name));
  assert.equal(new Set(first100Companies).size, 100);
  checks.push('Every window exposes all 470 companies, including zero-question CSVs, and global company paging has no duplicates.');

  await ui.fill('#global-search', 'Amazon');
  await expectRead(ui, companyNamesGlobal(), ['Amazon']);
  await ui.click('#results .company-title[data-action="company"][data-company="Amazon"]');
  await expectQuestions(questions('Amazon').questions);
  await expectSummary(ui, '#detail-summary', 2011);
  await ui.click('#detail-load-more');
  const first100Questions = companyRecords('Amazon').slice(0, 100);
  await expectQuestions(first100Questions);
  assert.equal(new Set(await ui.read(texts(questionTitles))).size, 100);
  const nextPageMetadata = await ui.read('document.querySelectorAll("#detail-results .question-meta")[50].textContent');
  assert.ok(nextPageMetadata.includes(`score ${first100Questions[50].frequency}`));
  assert.ok(nextPageMetadata.includes(`company rank #${first100Questions[50].rank}`));
  const directLink = await ui.read('document.querySelector("#detail-results a[href*=problems]").getAttribute("href")');
  assert.equal(directLink, 'https://leetcode.com/problems/two-sum/');
  await ui.mutate(`const node = document.querySelector('#question-search'); node.value = 'lru';
    node.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#detail-results [data-action="problem"][data-slug="two-sum"]').click();`);
  await expectRead(ui, text('#detail-title'), 'Two Sum');
  await expectCompanies(expectedTags);
  await ui.click('#detail-back');
  await expectRead(ui, text('#detail-title'), 'Amazon');
  await expectQuestions(questions('Amazon', { query: 'lru' }).questions);
  await expectRead(ui, 'document.querySelector("#question-search").value', 'lru');
  checks.push('Typing a company search immediately before drilldown and Back refreshes filtered rows instead of restoring old questions.');
  await ui.fill('#question-search', '');
  await expectQuestions(questions('Amazon').questions);
  await ui.mutate(`const node = document.querySelector('#question-search'); node.value = 'two sum';
    node.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#detail-load-more').click();`);
  await expectQuestions(questions('Amazon', { query: 'two sum' }).questions);
  assert.ok((await ui.read(texts(questionTitles))).includes('Two Sum'), 'Global company lookup must include the current LeetCode question.');
  checks.push('Amazon global lookup exposes its full 2,011-question list; next-page rows retain source frequency/rank and searches include Two Sum.');

  // Dispatch real UI events consecutively so earlier requests are still pending.
  await ui.mutate(`const node = document.querySelector('#question-search');
    for (const value of ['lru', 'not-a-real-problem', 'two sum']) { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await expectQuestions(questions('Amazon', { query: 'two sum' }).questions);
  await ui.mutate(`const node = document.querySelector('#window-select');
    for (const value of ['30d', 'all']) { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }`);
  await expectRead(ui, 'document.querySelector("#window-select").value', 'all');
  const finalFilters = await ui.read('({ difficulty: document.querySelector("#difficulty-select").value, topic: document.querySelector("#topic-select").value, query: document.querySelector("#question-search").value })');
  await expectQuestions(questions('Amazon', finalFilters).questions);
  await ui.mutate(`const node = document.querySelector('#question-search'); node.value = 'lru';
    node.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#detail-back').click();`);
  await expectRead(ui, visible('#results'), true);
  await ui.mutate(`const node = document.querySelector('#global-search');
    for (const value of ['Acko', 'nothing-matches-this-name', 'Amazon']) { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await expectRead(ui, companyNamesGlobal(), ['Amazon']);
  await wait(350);
  await expectRead(ui, visible('#detail-view'), false);
  await expectRead(ui, companyNamesGlobal(), ['Amazon']);
  await ui.fill('#global-search', '');
  await ui.click('#mode-problems');
  await ui.fill('#global-search', '');
  await expectRead(ui, problemSlugs(), core.searchProblems(data, { window: 'all', limit: 50 }).problems.map(({ slug }) => slug));
  checks.push('Rapid query edits, Load more during debounce, window changes and Back navigation keep the latest view; stale responses cannot mix pages or reopen a closed view.');
  return { checks, coverage, twoSumCompanies: expectedTags.length, ackoQuestions: 4, amazonQuestions: 2011, keyboardVerification: ui.keyboard };
}
