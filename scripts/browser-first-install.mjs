import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

// Source-backed expectations for the real packaged, offline first-install path.
// Nothing is injected into extension storage until these checks have completed.
export async function bundledExpectations(directory, core) {
  const data = JSON.parse(gunzipSync(await readFile(path.join(directory, 'data/snapshot.json.gz'))));
  const meta = JSON.parse(await readFile(path.join(directory, 'data/snapshot-meta.json'), 'utf8'));
  assert.equal(data.commit, meta.commit);
  assert.ok(data.companyCount > 400, 'The package must include the full company snapshot.');
  assert.ok(data.problemCount > 3000, 'The package must include all-time problem coverage.');
  const windows = Object.fromEntries(Object.keys(core.WINDOW_FILES).map((window) => {
    assert.equal(core.windowAvailable(data, window), true);
    const companies = core.companiesForSlug(data, 'two-sum', window);
    assert.ok(companies.length > 0, `Bundled Two Sum tags must exist in ${window}.`);
    return [window, companies];
  }));
  return { data, meta, windows, problem: core.problemForSlug(data, 'two-sum'), practice: core.practiceQuestions(data,
    { company: 'Amazon', window: 'all' }) };
}

export async function expectTexts(locator, expected) {
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await locator.allTextContents();
    if (JSON.stringify(observed) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(observed, expected);
}

export function problemHeader(title = '1. Two Sum', slug = 'two-sum') {
  return `<div id="problem-header"><h1 class="text-title-large"><a href="/problems/${slug}/">${title}</a></h1>
    <div id="problem-tags" data-problem-tags><span class="text-difficulty-easy">Easy</span><button type="button">Topics</button><button type="button">Companies</button><button type="button">Hint</button></div></div>`;
}

// A recognizable description-pane layout, fulfilled only inside isolated tests.
// The extension and company dataset are the real packaged production artifacts.
export function problemFixture({ anchor = true } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two Sum - LeetCode</title>
    <style>*{box-sizing:border-box}body{margin:0;background:#171717;color:#eee;font:15px/1.6 system-ui}header{padding:16px 24px;border-bottom:1px solid #343434;color:#ffa116}.layout{display:grid;grid-template-columns:minmax(0,720px) minmax(0,1fr);gap:20px;padding:24px;max-width:1400px;margin:auto}#description-pane{min-width:0}.tabs{display:flex;gap:18px;overflow-x:auto;min-width:0;white-space:nowrap;margin-bottom:18px;padding-bottom:9px;border-bottom:1px solid #333}.tabs button{font:inherit;background:transparent;border:0;color:#aaa}#problem-header h1{font-size:24px;line-height:1.4;margin:0}#problem-header a{color:inherit;text-decoration:none}#problem-tags{display:flex;align-items:center;gap:10px;margin-top:12px;color:#54bb93;font-size:12px}#problem-tags button{font:inherit;color:#aaa;border:0;border-radius:12px;background:#292929;padding:3px 10px}#problem-description{padding-top:12px}pre{background:#272727;padding:16px;border-radius:8px;white-space:pre-wrap}aside{min-width:0;border:1px solid #343434;border-radius:8px;padding:20px;color:#aaa}code{color:#78b6ff}@media(max-width:800px){.layout{display:block;padding:18px}aside{display:none}}
    </style></head><body><header>LeetCode &nbsp; / &nbsp; Problems</header><main class="layout"><section id="description-pane" class="flexlayout__tab" aria-label="Problem description"><nav class="tabs"><button id="description_tab" class="flexlayout__tab_button flexlayout__tab_button--selected" aria-selected="true" type="button">Description</button><button type="button">Editorial</button><button type="button">Solutions</button><button type="button">Submissions</button></nav>${anchor ? problemHeader() : ''}
    <div id="problem-description" data-track-load="description_content" class="elfjS"><p>Given an array of integers <strong>nums</strong> and an integer <strong>target</strong>, return indices of the two numbers such that they add up to target.</p><p>You may assume that each input would have exactly one solution, and you may not use the same element twice.</p><h3>Example 1:</h3><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre><p><strong>Explanation:</strong> Because nums[0] + nums[1] == 9, we return [0, 1].</p><h3>Constraints:</h3><ul><li>2 ≤ nums.length ≤ 10⁴</li><li>Only one valid answer exists.</li></ul></div></section><aside>Code &nbsp; · &nbsp; JavaScript<pre><code>function twoSum(nums, target) {\n  // Your solution\n}</code></pre></aside></main></body></html>`;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function expectUI(ui, expression, expected) {
  let observed;
  for (let attempt = 0; attempt < 120; attempt++) {
    observed = await ui.read(expression);
    if (JSON.stringify(observed) === JSON.stringify(expected)) return observed;
    await delay(50);
  }
  assert.deepEqual(observed, expected);
}
const uiTexts = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}), node => node.textContent)`;

export function acceptanceLabel(core, value) {
  const formatted = core.formatAcceptanceRate(value);
  return formatted === null ? 'Acceptance unavailable' : `Acceptance ${formatted}`;
}

export async function exerciseAcceptanceControl(ui, { selector, label, core }) {
  await expectUI(ui, `document.querySelector(${JSON.stringify(selector)})?.textContent`, label);
  const state = () => ui.read(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const help = document.getElementById(button.getAttribute('aria-controls'));
    return { tag: button.tagName, type: button.type, tabIndex: button.tabIndex, title: button.title,
      expanded: button.getAttribute('aria-expanded'), described: button.getAttribute('aria-describedby'),
      helpId: help?.id, helpText: help?.textContent, helpHidden: help?.hidden,
      insideLink: Boolean(button.closest('a')), visible: Boolean(button.getClientRects().length) };
  })()`);
  const initial = await state();
  assert.equal(initial.tag, 'BUTTON'); assert.equal(initial.type, 'button'); assert.equal(initial.tabIndex, 0);
  assert.equal(initial.insideLink, false, 'Acceptance help must not be nested in a navigation link.');
  assert.equal(initial.visible, true); assert.equal(initial.expanded, 'false'); assert.equal(initial.helpHidden, true);
  assert.equal(initial.described, initial.helpId);
  assert.ok(initial.title.includes(core.ACCEPTANCE_TOOLTIP));
  assert.match(initial.title, /submissions accepted.*across all users/i);
  assert.match(initial.title, /LeetCode submissions/);
  if (label === 'Acceptance unavailable') assert.match(initial.helpText, /No valid acceptance rate/);
  await ui.click(selector);
  await expectUI(ui, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`, 'true');
  assert.equal((await state()).helpHidden, false);
  assert.ok((await state()).helpText.includes(core.ACCEPTANCE_TOOLTIP));
  await ui.press(selector, 'Escape');
  assert.equal((await state()).helpHidden, true);
  await ui.activateWithKeyboard(selector);
  assert.equal((await state()).helpHidden, false);
  await ui.press(selector, 'Escape');
  assert.equal((await state()).expanded, 'false');
  return { label, meaning: initial.helpText, keyboard: ui.keyboard };
}

export async function exerciseBundledPanel(page, expected, timings) {
  const host = page.locator('#company-lens-root');
  await host.waitFor({ state: 'visible' });
  await expectTexts(host.locator('.company-name'), expected.windows.all.map(company => company.name));
  const readyAt = Date.now();
  return {
    startupToFirstPanelResultsMs: readyAt - timings.startupStartedAt,
    navigationToFirstPanelResultsMs: readyAt - timings.navigationStartedAt,
    sourceUpdatedAt: expected.data.sourceUpdatedAt, commit: expected.data.commit,
    companyCount: expected.data.companyCount, problemCount: expected.data.problemCount,
    twoSumCompaniesByWindow: Object.fromEntries(Object.entries(expected.windows).map(([window, companies]) => [window, companies.length])),
    check: 'Fresh installation displays all 115 sorted company chips immediately from the complete bundled snapshot without GitHub access.',
  };
}

export async function exerciseBundledPopup(ui, page, expected, core) {
  const topNames = companies => companies.slice(0, 5).map(company => company.name);
  await expectUI(ui, 'document.querySelector("#window-select").value', 'all');
  const note = await ui.read('document.querySelector("#window-note").textContent');
  assert.match(note, /Bundled snapshot/i);
  assert.ok(note.includes(String(new Date(expected.data.sourceUpdatedAt).getUTCFullYear())));
  const acceptance = await exerciseAcceptanceControl(ui, { selector: '#problem-acceptance .acceptance-rate',
    label: acceptanceLabel(core, expected.problem.acceptanceRate), core });
  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await expectUI(ui, uiTexts('.company-name'), topNames(expected.windows[window]));
    await expectUI(ui, uiTexts('#problem-acceptance .acceptance-rate'), [acceptance.label]);
    await expectTexts(page.locator('#company-lens-root .company-name'), expected.windows[window].map(company => company.name));
  }
  await ui.click('#companies button[data-company="Amazon"]');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), expected.practice.questions.map(question => question.title));
  await expectUI(ui, uiTexts('#practice-questions .acceptance-rate'), expected.practice.questions.map(question => acceptanceLabel(core, question.acceptanceRate)));
  const first = expected.practice.questions[0];
  const meta = await ui.read('document.querySelector("#practice-questions .question-meta").textContent');
  assert.ok(meta.includes(`score ${first.frequency}`) && meta.includes(`company rank #${first.rank}`));
  await ui.click('#back-companies');
  await ui.fill('#search', 'Walmart Labs');
  await ui.click('#companies button[data-company="Walmart Labs"]');
  const pagination = await exercisePracticePagination(ui, { data: expected.data, core, company: 'Walmart Labs', slug: 'two-sum' });
  const practiceSorting = await exercisePracticeSorting(ui, { data: expected.data, core, company: 'Walmart Labs', slug: 'two-sum' });
  await ui.click('#back-companies');
  await ui.fill('#search', '');
  return { windowNote: note, acceptance, pagination, practiceSorting,
    check: 'Offline toolbar popup exposes all five bundled windows, source date, frequency/rank scores and saved acceptance rates with accessible global-submission explanations; changing windows preserves the current problem acceptance rate.' };
}

export async function exercisePracticePagination(ui, { data, core, company, slug, window = 'all' }) {
  const options = { company, window };
  const full = [];
  let total = 0;
  do {
    const result = core.practiceQuestions(data, { ...options, offset: full.length, limit: 100 });
    total = result.total;
    full.push(...result.questions);
    if (!result.questions.length) break;
  } while (full.length < total);
  assert.ok(total > 140, 'This pagination regression needs a real company exceeding the 100-result backend page cap.');
  assert.equal(full.length, total);
  const rendered = () => ui.read(`Array.from(document.querySelectorAll('#practice-questions li'), node => ({
    slug: node.dataset.slug, title: node.querySelector('.question-title').textContent,
    meta: node.querySelector('.question-meta').textContent, current: Boolean(node.querySelector('.current-problem')) }))`);
  const assertRows = async questions => {
    await expectUI(ui, `Array.from(document.querySelectorAll('#practice-questions li'), node => node.dataset.slug)`, questions.map(question => question.slug));
    const rows = await rendered();
    assert.equal(new Set(rows.map(row => row.slug)).size, rows.length, 'Appending practice pages must not duplicate questions.');
    questions.forEach((question, index) => {
      assert.equal(rows[index].title, question.title);
      const score = Number.isFinite(question.frequency) ? question.frequency : 'unavailable';
      const rank = Number.isInteger(question.rank) ? `company rank #${question.rank}` : 'rank unavailable';
      assert.ok(rows[index].meta.includes(`score ${score}`) && rows[index].meta.includes(rank), 'Pagination must retain source frequency and rank.');
      assert.equal(rows[index].current, question.slug === slug, 'Only the current LeetCode problem should carry the current marker.');
    });
  };
  await assertRows(full.slice(0, 20));
  assert.ok((await ui.read('document.querySelector("#practice-summary").textContent')).startsWith(`20 of ${total} questions`));
  await ui.mutate("globalThis.__practiceFirstRow = document.querySelector('#practice-questions li');");
  await ui.click('#practice-load-more');
  await assertRows(full.slice(0, 40));
  assert.equal(await ui.read('globalThis.__practiceFirstRow.isConnected && globalThis.__practiceFirstRow === document.querySelector("#practice-questions li")'), true, 'Loading a page should preserve existing rows.');
  await ui.click('#practice-show-all');
  await assertRows(full);
  assert.equal(await ui.read('Boolean(document.querySelector("#practice-pagination").getClientRects().length)'), false);
  assert.ok((await ui.read('document.querySelector("#practice-summary").textContent')).startsWith(`${total} of ${total} questions`));
  await ui.select('#difficulty-select', 'Medium');
  const filtered = core.practiceQuestions(data, { ...options, difficulty: 'Medium', limit: 20 });
  await assertRows(filtered.questions);
  assert.ok((await ui.read('document.querySelector("#practice-summary").textContent')).startsWith(`${filtered.questions.length} of ${filtered.total} questions`));
  await ui.fill('#topic-input', 'not-a-real-pagination-topic');
  await assertRows([]);
  await expectUI(ui, 'document.querySelector("#practice-summary").textContent.includes("No questions match")', true);
  assert.equal(await ui.read('Boolean(document.querySelector("#practice-pagination").getClientRects().length)'), false);
  await ui.fill('#topic-input', '');
  await assertRows(filtered.questions);
  await ui.select('#difficulty-select', '');
  await assertRows(full.slice(0, 20));
  await ui.mutate('delete globalThis.__practiceFirstRow;');
  return { company, total, pages: [20, 40, total], currentProblemIncluded: full.some(question => question.slug === slug),
    check: 'Practice Load more and Show all reach the complete source-ordered company list beyond the 100-row page cap, preserve existing rows and original ranks, mark the current problem, and reset after difficulty/topic filtering.' };
}

export async function exercisePracticeSorting(ui, { data, core, company, slug, window = 'all' }) {
  const sorts = ['frequency-desc', 'frequency-asc', 'name-asc', 'name-desc', 'difficulty-asc', 'difficulty-desc', 'companies-desc', 'companies-asc'];
  const questions = options => {
    const rows = [];
    let total;
    do {
      const page = core.practiceQuestions(data, { company, window, ...options, offset: rows.length, limit: 100 });
      total = page.total;
      rows.push(...page.questions);
      if (!page.questions.length) break;
    } while (rows.length < total);
    assert.equal(rows.length, total);
    return rows;
  };
  const assertRows = async expected => {
    await expectUI(ui, `Array.from(document.querySelectorAll('#practice-questions li'), node => node.dataset.slug)`, expected.map(question => question.slug));
    const rows = await ui.read(`Array.from(document.querySelectorAll('#practice-questions li'), node => ({ slug:node.dataset.slug, title:node.querySelector('.question-title').textContent, meta:node.querySelector('.question-meta').textContent, acceptance:node.querySelector('.acceptance-rate').textContent, topics:node.querySelector('.question-topics')?.textContent || '', current:Boolean(node.querySelector('.current-problem')) }))`);
    assert.equal(new Set(rows.map(row => row.slug)).size, rows.length);
    expected.forEach((question, index) => {
      assert.equal(rows[index].title, question.title);
      assert.ok(rows[index].meta.includes(question.difficulty || 'Difficulty unavailable'));
      assert.equal(rows[index].acceptance, acceptanceLabel(core, question.acceptanceRate));
      assert.equal(rows[index].topics, (question.topics || []).slice(0, 3).join(' · '));
      assert.ok(rows[index].meta.includes(`score ${Number.isFinite(question.frequency) ? question.frequency : 'unavailable'}`));
      assert.ok(rows[index].meta.includes(Number.isInteger(question.rank) ? `company rank #${question.rank}` : 'rank unavailable'));
      assert.equal(rows[index].current, question.slug === slug);
    });
  };
  for (const sort of sorts) {
    await ui.select('#practice-sort-select', sort);
    const full = questions({ sort });
    await assertRows(full.slice(0, 20));
    const label = await ui.read('document.querySelector("#practice-sort-select-value").textContent');
    assert.ok((await ui.read('document.querySelector("#practice-sort-select-trigger").title')).includes(label));
    assert.ok((await ui.read('document.querySelector("#practice-questions").getAttribute("aria-label")')).toLocaleLowerCase().includes(label.toLocaleLowerCase()));
    assert.ok((await ui.read('document.querySelector("#practice-summary").textContent')).toLocaleLowerCase().includes(label.toLocaleLowerCase()));
    await ui.click('#practice-show-all');
    await assertRows(full);
    if (sort === 'companies-desc' || sort === 'companies-asc') {
      const metadata = await ui.read(`Array.from(document.querySelectorAll('#practice-questions .question-meta'), node => node.textContent)`);
      full.forEach((question, index) => {
        const label = Number.isInteger(question.companyCount) ? `${question.companyCount} ${question.companyCount === 1 ? 'company' : 'companies'}` : 'Company count unavailable';
        assert.ok(metadata[index].includes(label), 'Company-count sorting must display its criterion alongside the original metadata.');
      });
      assert.equal(await ui.read(`Array.from(document.querySelectorAll('#practice-questions .question-company-count')).filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').length`), full.length, 'Company counts must be visibly rendered for every result in a company-count sort.');
    }
    assert.equal(await ui.read('Boolean(document.querySelector("#practice-pagination").getClientRects().length)'), false);
  }
  await ui.select('#practice-sort-select', 'frequency-asc');
  await ui.select('#difficulty-select', 'Medium');
  await ui.fill('#topic-input', 'Hash Table');
  const filtered = questions({ sort: 'frequency-asc', difficulty: 'Medium', topic: 'Hash Table' });
  await assertRows(filtered.slice(0, 20));
  if (filtered.length > 20) await ui.click('#practice-show-all');
  await assertRows(filtered);
  await ui.fill('#topic-input', '');
  await ui.select('#difficulty-select', '');
  await ui.select('#practice-sort-select', 'frequency-desc');
  await assertRows(questions({ sort: 'frequency-desc' }).slice(0, 20));
  return { company, sorts, filteredTotal: filtered.length,
    check: 'All eight practice orders sort the full company dataset before paging; Show all retains exact membership, source ranks, ties and the current marker, and combines with difficulty/topic filters.' };
}

export async function archiveFixture(root, core) {
  const fixtureRoot = path.join(root, 'output/source-validation');
  const storage = JSON.parse(await readFile(path.join(fixtureRoot, 'storage.json'), 'utf8'));
  const data = storage.lctData;
  assert.ok(data?.files && data?.commit, 'The verified local archive fixture needs its source data.');
  const files = Object.entries(data.files).map(([relativePath, file]) => {
    const separator = relativePath.indexOf('/');
    const name = relativePath.slice(0, separator);
    const filename = relativePath.slice(separator + 1);
    const window = Object.keys(core.WINDOW_FILES).find((key) => core.WINDOW_FILES[key] === filename);
    assert.ok(window);
    return { path: relativePath, name, window, sha: file.sha };
  });
  const samplePath = 'Amazon/' + core.WINDOW_FILES.all;
  const csvs = JSON.parse(await readFile(path.join(fixtureRoot, 'csvs.json'), 'utf8'));
  const sampleCSV = csvs.find(file => file.path === samplePath);
  assert.equal(sampleCSV.sha, data.files[samplePath].sha);
  const sample = core.parseCompanyRecords(sampleCSV.csv, { commit: data.commit }).find(({ slug }) => slug === 'two-sum');
  assert.ok(Number.isFinite(sample.acceptanceRate), 'Archive validation must retain its real source acceptance rate.');
  return { payload: { base64: (await readFile(path.join(fixtureRoot, 'source.zip'))).toString('base64'),
    commit: data.commit, files, samplePath }, expected: { fileCount: files.length, sample } };
}

// This function is self-contained so it can execute in a Chromium worker or the
// actual Firefox extension background through Mozilla's debugging protocol.
export async function browserArchiveCheck({ base64, commit, files, samplePath }) {
  const started = performance.now();
  new DecompressionStream('deflate-raw');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed = await globalThis.LCTArchive.readCompanyArchive(bytes, { commit, files });
  return { nativeDeflateRaw: true, archiveBytes: bytes.length, fileCount: Object.keys(parsed).length,
    decodeAndValidateMs: Math.round(performance.now() - started),
    sample: parsed[samplePath].records.find(({ slug }) => slug === 'two-sum') };
}

export function assertArchiveResult(result, fixture) {
  assert.equal(result.nativeDeflateRaw, true);
  assert.equal(result.fileCount, fixture.expected.fileCount);
  assert.deepEqual(result.sample, fixture.expected.sample);
}


export async function inlineGeometry(page) {
  return page.locator('#company-lens-root').evaluate(host => {
    const rect = node => { const { left, right, top, bottom, width, height } = node.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
    const list = host.shadowRoot.querySelector('.companies');
    const title = document.querySelector('#problem-header .text-title-large');
    const tags = document.querySelector('#problem-tags');
    const description = document.querySelector('#problem-description');
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      position: getComputedStyle(host).position, host: rect(host), title: rect(title), tags: rect(tags), description: rect(description),
      titleBeforeHost: Boolean(title.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING),
      hostBeforeDescription: Boolean(host.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING),
      list: { ...rect(list), scrollLeft: list.scrollLeft, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
        overflowX: getComputedStyle(list).overflowX }, lastChip: rect(list.querySelector('li:last-child .company-chip')) };
  });
}

async function assertChips(page, core, data, slug, window = 'all') {
  const expected = core.companiesForSlug(data, slug, window);
  const host = page.locator('#company-lens-root');
  await expectTexts(host.locator('.company-name'), expected.map(company => company.name));
  await expectTexts(host.locator('.frequency-score'), expected.map(company => company.frequency == null ? '—' : String(company.frequency)));
  for (const company of expected) {
    const chip = host.getByRole('button', { name: `${company.name}, open company questions`, exact: true });
    assert.equal(await chip.getAttribute('type'), 'button');
    assert.equal(await chip.getAttribute('href'), null);
    assert.equal(await chip.getAttribute('data-company'), company.name);
    assert.equal(await chip.getAttribute('data-window'), window);
    const explanation = await chip.evaluate(node => (node.title || '') + ' ' + (node.getRootNode().getElementById(node.getAttribute('aria-describedby'))?.textContent || ''));
    assert.match(explanation, /not interview counts/i);
    if (company.rank != null) assert.ok(explanation.includes(`#${company.rank}`), `${company.name} rank must remain available in its tooltip/description.`);
  }
  return expected;
}

export async function exerciseInlineLayout(page, { core, data, slug = 'two-sum', output, browserName }) {
  const host = page.locator('#company-lens-root');
  const expected = await assertChips(page, core, data, slug);
  assert.equal(await host.getByRole('button', { name: 'Open Company Lens popup', exact: true }).count(), 1, 'The inline caption must expose one accessible toolbar-popup shortcut.');
  assert.equal(await host.locator('button.open-extension').count(), 1);
  assert.equal(await host.locator('.acceptance-rate,.acceptance-help').count(), 0, 'Acceptance metadata must not add controls or text to the compact inline bar.');
  assert.equal(await host.locator('button:not(.open-extension):not(.company-chip),input,select,.card,.collapsed-bubble').count(), 0, 'The inline bar must have no unrelated or floating-panel controls.');
  const geometry = await inlineGeometry(page);
  assert.ok(['static', 'relative'].includes(geometry.position), 'Company bar must participate in the normal page flow.');
  assert.equal(geometry.titleBeforeHost, true); assert.equal(geometry.hostBeforeDescription, true);
  assert.ok(geometry.host.top >= geometry.tags.bottom - 1, 'Company bar must appear below the complete title/tag group.');
  assert.ok(geometry.host.bottom <= geometry.description.top + 1, 'Company bar must appear before the problem statement.');
  assert.ok(geometry.documentWidth <= geometry.viewport.width, 'The inline bar must not widen the document.');
  assert.ok(['auto', 'scroll'].includes(geometry.list.overflowX));
  assert.ok(geometry.list.scrollWidth > geometry.list.clientWidth, 'All company chips must share one horizontal scrolling row.');
  const first = host.locator('.companies .company-chip').first();
  await first.focus(); await first.press('Tab');
  assert.equal(await host.locator('.companies .company-chip').nth(1).evaluate(node => node.getRootNode().activeElement === node), true);
  await host.locator('.companies').focus();
  await host.locator('.companies').press('End');
  const scrolled = await inlineGeometry(page);
  assert.ok(scrolled.list.scrollLeft > 0);
  assert.ok(scrolled.lastChip.right <= scrolled.list.right + 1 && scrolled.lastChip.left >= scrolled.list.left - 1, 'Last company must be reachable inside the scrolling bar.');
  await host.locator('.companies').press('Home');
  assert.equal(await host.locator('.companies').evaluate(list => list.scrollLeft), 0);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForFunction(() => document.querySelector('#company-lens-root')?.hasAttribute('data-dark'));
  await page.locator('#problem-description').click({ position: { x: 2, y: 2 } });
  await page.screenshot({ path: path.join(output, `${browserName}-inline-desktop.png`), fullPage: true, animations: 'disabled' });
  const previous = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (browserName.startsWith('firefox')) {
    // This installed Firefox accepts viewportSize only. The public API adds
    // incompatible screenSize/isMobile fields; send its supported raw command.
    await page._connection.toImpl(page).delegate._session.send('Page.setViewportSize', { viewportSize: { width: 375, height: 700 } });
  } else await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForFunction(() => innerWidth === 375);
  await host.locator('.companies').evaluate(list => { list.scrollLeft = list.scrollWidth; });
  const narrow = await inlineGeometry(page);
  assert.equal(narrow.viewport.width, 375);
  assert.ok(narrow.documentWidth <= 375);
  assert.ok(narrow.host.left >= 0 && narrow.host.right <= 375);
  assert.ok(narrow.lastChip.right <= narrow.list.right + 1 && narrow.lastChip.left >= narrow.list.left - 1);
  await page.screenshot({ path: path.join(output, `${browserName}-inline-small.png`), fullPage: true, animations: 'disabled' });
  if (browserName.startsWith('firefox')) await page._connection.toImpl(page).delegate._session.send('Page.setViewportSize', { viewportSize: previous });
  else await page.setViewportSize(previous);
  await host.locator('.companies').evaluate(list => { list.scrollLeft = 0; });
  return { geometry, narrow, count: expected.length, checks: [
    'All company buttons appear in source-frequency order with zero/unknown scores, captured company/window targets and accessible frequency/rank explanations.',
    'Company bar sits below the title/tags and before the description in normal flow; keyboard Tab reaches its chips and no floating controls remain.',
    'Horizontal scrolling reaches the last chip without widening the page at desktop or actual 375px viewport widths.',
  ] };
}

export async function exercisePopupCompanySort(ui, { data, core, slug = 'two-sum' }) {
  const trigger = '#company-sort-trigger', menu = '#company-sort-menu';
  const options = ['frequency-desc', 'frequency-asc', 'name-asc', 'name-desc'];
  const expected = (sort, expanded = false, query = '') => core.sortCompanies(core.companiesForSlug(data, slug, 'all'), sort)
    .filter(company => company.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(company => company.name).slice(0, expanded || query ? undefined : 5);
  const state = () => ui.read(`(() => {
    const button = document.querySelector('#company-sort-trigger'), menu = document.querySelector('#company-sort-menu');
    return { tag: button.tagName, type: button.type, role: button.getAttribute('role'),
      expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'),
      visible: Boolean(menu.getClientRects().length), menuRole: menu.getAttribute('role'),
      label: document.querySelector('#company-sort-value').textContent,
      selected: Array.from(menu.querySelectorAll('[aria-selected="true"]'), node => node.dataset.value),
      options: Array.from(menu.querySelectorAll('[role="option"]'), node => node.dataset.value),
      radius: getComputedStyle(menu).borderRadius };
  })()`);
  const closed = async () => {
    await expectUI(ui, 'document.querySelector("#company-sort-trigger").getAttribute("aria-expanded")', 'false');
    await expectUI(ui, 'Boolean(document.querySelector("#company-sort-menu").getClientRects().length)', false);
  };
  const assertOrder = async (sort, expanded = false, query = '') => {
    await expectUI(ui, uiTexts('#companies .company-name'), expected(sort, expanded, query));
    const selected = await state();
    assert.deepEqual(selected.selected, [sort]);
    assert.equal(selected.label, await ui.read(`document.querySelector('#company-sort-menu [role="option"][data-value="${sort}"]').textContent`));
    let storedSort;
    for (let attempt = 0; attempt < 120; attempt++) {
      await ui.mutate("globalThis.__lctPopupStoredSort = null; (globalThis.browser || globalThis.chrome).storage.local.get('lctPopupCompanySort').then(value => { globalThis.__lctPopupStoredSort = { value: value.lctPopupCompanySort }; });");
      await expectUI(ui, 'globalThis.__lctPopupStoredSort !== null', true);
      storedSort = await ui.read('globalThis.__lctPopupStoredSort.value');
      if (storedSort === sort) break;
      await delay(50);
    }
    assert.equal(storedSort, sort, 'The popup sort must persist to extension storage.');
    await ui.mutate('delete globalThis.__lctPopupStoredSort;');
  };
  const choose = async sort => {
    await ui.click(trigger);
    await expectUI(ui, 'document.querySelector("#company-sort-trigger").getAttribute("aria-expanded")', 'true');
    await ui.click(`#company-sort-menu [role="option"][data-value="${sort}"]`);
    await closed();
  };
  const initial = await state();
  assert.equal(initial.tag, 'BUTTON'); assert.equal(initial.type, 'button'); assert.equal(initial.role, 'combobox');
  assert.equal(initial.controls, 'company-sort-menu'); assert.equal(initial.menuRole, 'listbox');
  assert.deepEqual(initial.options, options); assert.deepEqual(initial.selected, ['frequency-desc']);
  assert.equal(initial.expanded, 'false'); assert.equal(initial.visible, false);
  await choose('name-asc'); await assertOrder('name-asc');
  await ui.click('#show-companies');
  await choose('name-desc'); await assertOrder('name-desc', true);
  assert.equal(await ui.read('document.querySelector("#show-companies").getAttribute("aria-expanded")'), 'true');
  const query = 'a';
  await ui.fill('#search', query);
  await choose('frequency-asc'); await assertOrder('frequency-asc', true, query);
  assert.equal(await ui.read('document.querySelector("#search").value'), query);
  assert.equal(await ui.read('document.querySelector("#show-companies").getAttribute("aria-expanded")'), 'true');
  assert.equal(await ui.read('document.querySelector("#window-select").value'), 'all');
  await ui.fill('#search', '');
  await ui.press(trigger, 'Enter'); await expectUI(ui, 'Boolean(document.querySelector("#company-sort-menu").getClientRects().length)', true);
  const opened = await state(); assert.ok(parseFloat(opened.radius) >= 6, 'Popup company menu must retain rounded corners.');
  await ui.press(trigger, 'Home'); await ui.press(trigger, 'Enter'); await closed(); await assertOrder('frequency-desc', true);
  await ui.press(trigger, 'Enter'); await ui.press(trigger, 'End'); await ui.press(trigger, 'Enter');
  await closed(); await assertOrder('name-desc', true);
  await ui.press(trigger, 'Enter'); await ui.press(trigger, 'Home'); await ui.press(trigger, 'Escape');
  await closed(); await assertOrder('name-desc', true);
  await choose('frequency-desc');
  await ui.click('#show-companies'); await assertOrder('frequency-desc');
  return { keyboard: ui.keyboard, options, check: 'Popup company sorting supports all four orders by pointer and keyboard, persists selection, and preserves search, expanded state and time window without changing inline chips.' };
}

export async function exercisePopupStatusDots(ui, { getStatus, setStorage }) {
  const original = await getStatus();
  const fresh = { ...original, phase: 'idle', hasData: true, lastCheckedAt: new Date().toISOString() };
  const examples = [
    ['Ready', 'ready', fresh],
    ['Syncing', 'syncing', { ...fresh, phase: 'syncing', completed: 3, total: 35 }],
    ['Needs attention', 'warning', { ...fresh, phase: 'error', message: 'Controlled status warning.' }],
    ['Saved data', 'warning', { ...fresh, lastCheckedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() }],
    ['Not synced', 'idle', { ...fresh, hasData: false, lastCheckedAt: null, lastSyncedAt: null }],
  ];
  const results = [];
  try {
    for (const [text, state, status] of examples) {
      await setStorage({ lctStatus: status });
      await expectUI(ui, 'document.querySelector("#dataset-state").textContent', text);
      await expectUI(ui, 'document.querySelector("#dataset-state").dataset.state', state);
      const style = await ui.read(`(() => {
        const node = document.querySelector('#dataset-state'), css = getComputedStyle(node), dot = getComputedStyle(node, '::before');
        return { tag: node.tagName, role: node.getAttribute('role'), tabIndex: node.tabIndex,
          inButton: Boolean(node.closest('button,a')), border: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth],
          background: css.backgroundColor, dotContent: dot.content, dotWidth: dot.width, dotHeight: dot.height,
          dotRadius: dot.borderRadius, dotColor: dot.backgroundColor };
      })()`);
      assert.equal(style.tag, 'SPAN'); assert.equal(style.tabIndex, -1); assert.equal(style.inButton, false);
      assert.ok(!['button', 'link', 'combobox', 'menuitem'].includes(style.role));
      assert.ok(style.border.every(width => parseFloat(width) === 0), 'Dataset state should not look like a bordered badge.');
      assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(style.background), 'Dataset state should not have a badge background.');
      assert.ok(!['none', 'normal'].includes(style.dotContent));
      const width = parseFloat(style.dotWidth), height = parseFloat(style.dotHeight);
      assert.ok(width > 0 && width <= 10); assert.equal(width, height);
      assert.ok(style.dotRadius === '50%' || parseFloat(style.dotRadius) >= width / 2, 'Status dot must be circular.');
      assert.ok(!['rgba(0, 0, 0, 0)', 'transparent'].includes(style.dotColor));
      results.push({ text, state, dotColor: style.dotColor });
    }
  } finally {
    await setStorage({ lctStatus: original });
  }
  return { states: results, check: 'Dataset status remains readable, non-interactive text with a small circular dot and no pill border or background across ready, syncing, warning, saved-data and idle states.' };
}

export async function exercisePopupFeatures(ui, page, { data, core, getStatus, setStorage, removeStorage, slug = 'two-sum', output, browserName }) {
  const checks = [];
  const companies = window => core.companiesForSlug(data, slug, window);
  const names = window => companies(window).map(company => company.name);
  const top = window => names(window).slice(0, 5);
  await expectUI(ui, uiTexts('.company-name'), top('all'));
  const acceptance = await exerciseAcceptanceControl(ui, { selector: '#problem-acceptance .acceptance-rate',
    label: acceptanceLabel(core, core.problemForSlug(data, slug).acceptanceRate), core });
  const companySort = await exercisePopupCompanySort(ui, { data, core, slug });
  checks.push(companySort.check);
  await assertChips(page, core, data, slug);
  await expectUI(ui, uiTexts('.frequency-score'), companies('all').slice(0, 5).map(company => company.frequency == null ? '—' : String(company.frequency)));
  await ui.click('#show-companies');
  await expectUI(ui, uiTexts('.company-name'), names('all'));
  await expectUI(ui, 'document.querySelector("#show-companies").getAttribute("aria-expanded")', 'true');
  await expectUI(ui, uiTexts('.frequency-score'), companies('all').map(company => company.frequency == null ? '—' : String(company.frequency)));
  await ui.click('#show-companies');
  await ui.fill('#search', 'micro'); await expectUI(ui, uiTexts('.company-name'), ['Microsoft']);
  await ui.fill('#search', 'unlisted-test-company'); await expectUI(ui, uiTexts('.company-name'), []);
  assert.match(await ui.read('document.querySelector("#empty").textContent'), /No company names match/);
  await ui.fill('#search', ''); await expectUI(ui, uiTexts('.company-name'), top('all'));
  checks.push('Toolbar popup retains ranked scores, five-company preview, Show all/Show fewer, full-list search, zero/unknown scores and no-match feedback.');
  for (const window of ['30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await expectUI(ui, uiTexts('.company-name'), top(window));
    await expectUI(ui, uiTexts('#problem-acceptance .acceptance-rate'), [acceptance.label]);
    await assertChips(page, core, data, slug, window);
  }
  checks.push('All five toolbar time windows rerank every inline company chip and update its captured window and rank.');
  const practice = options => core.practiceQuestions(data, { company: 'Amazon', window: 'all', ...options });
  await ui.click('#companies button[data-company="Amazon"]');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice().questions.map(question => question.title));
  const practiceLabels = practice().questions.map(question => acceptanceLabel(core, question.acceptanceRate));
  await expectUI(ui, uiTexts('#practice-questions .acceptance-rate'), practiceLabels);
  assert.ok(practiceLabels.includes('Acceptance 0.0%') && practiceLabels.includes('Acceptance 100.0%'));
  assert.equal(practiceLabels.filter(label => label === 'Acceptance unavailable').length, 2, 'The fixture must cover both missing and malformed source values.');
  const missingIndex = practiceLabels.indexOf('Acceptance unavailable');
  await exerciseAcceptanceControl(ui, { selector: `#practice-questions li:nth-child(${missingIndex + 1}) .acceptance-rate`,
    label: 'Acceptance unavailable', core });
  const knownSelector = '#practice-questions li:first-child .acceptance-rate';
  await exerciseAcceptanceControl(ui, { selector: knownSelector, label: practiceLabels[0], core });
  if (output && ui.screenshot) {
    await ui.click(knownSelector);
    await ui.screenshot(path.join(output, `${browserName}-acceptance-popup-practice.png`));
    await ui.press(knownSelector, 'Escape');
  }
  checks.push('Toolbar acceptance displays normalized values including 0%/100%, marks missing and invalid source values unavailable, stays global across windows, and reveals/dismisses its submission-rate explanation by click and keyboard.');
  const first = practice().questions[0];
  const firstMeta = await ui.read('document.querySelector("#practice-questions .question-meta").textContent');
  assert.ok(firstMeta.includes(`score ${first.frequency}`) && firstMeta.includes(`company rank #${first.rank}`));
  assert.equal(await ui.read('document.querySelector("#practice-questions a").getAttribute("href")'), first.url);
  await ui.select('#difficulty-select', 'Medium');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice({ difficulty: 'Medium' }).questions.map(question => question.title));
  await ui.fill('#topic-input', 'Tree');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice({ difficulty: 'Medium', topic: 'Tree' }).questions.map(question => question.title));
  await ui.fill('#topic-input', 'not-a-fixture-topic');
  await expectUI(ui, 'document.querySelector("#practice-summary").textContent.includes("No questions match")', true);
  await expectUI(ui, uiTexts('#practice-questions .question-title'), []);
  assert.match(await ui.read('document.querySelector("#practice-summary").textContent'), /No questions match/);
  await ui.click('#back-companies'); await ui.click('#companies button[data-company="Amazon"]');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice().questions.map(question => question.title));
  await expectUI(ui, `Array.from(document.querySelectorAll('#practice-questions li')).filter(row => row.querySelector('.current-problem')).map(row => row.dataset.slug)`, practice().questions.filter(question => question.slug === slug).map(question => question.slug));
  checks.push('Toolbar practice retains source frequency/rank, includes and marks the current question, and supports difficulty/topic filters, no-match states and direct LeetCode links.');
  await ui.mutate(`globalThis.__lctProgressNodes = { company: document.querySelector('#companies a'), question: document.querySelector('#practice-questions a') };`);
  const host = page.locator('#company-lens-root');
  const retained = await host.locator('.companies .company-chip').last().elementHandle();
  await host.locator('.companies .company-chip').last().focus();
  const scrollBefore = await host.locator('.companies').evaluate(list => list.scrollLeft);
  const status = await getStatus();
  await setStorage({ lctStatus: { ...status, phase: 'syncing', completed: 3, total: 35 }, lctStage: { auditCheckpoint: true }, lctAuditChunk: { progress: 3 } });
  await expectUI(ui, 'document.querySelector("#status").textContent.includes("3 of 35")', true);
  await page.waitForTimeout(1100);
  assert.equal(await retained.evaluate(node => node.isConnected && node.getRootNode().activeElement === node), true);
  assert.equal(await host.locator('.companies').evaluate(list => list.scrollLeft), scrollBefore);
  await expectUI(ui, 'globalThis.__lctProgressNodes.company.isConnected && globalThis.__lctProgressNodes.question.isConnected', true);
  await page.evaluate(() => history.replaceState({}, '', location.pathname + '?audit=retained#companies'));
  await page.waitForTimeout(1000);
  assert.equal(await retained.evaluate(node => node.isConnected && node.getRootNode().activeElement === node), true);
  assert.equal(await host.locator('.companies').evaluate(list => list.scrollLeft), scrollBefore);
  await setStorage({ lctStatus: status, lctStage: null }); await removeStorage('lctAuditChunk');
  await retained.dispose(); await ui.mutate('delete globalThis.__lctProgressNodes;');
  await ui.click('#back-companies');
  checks.push('Sync progress, unrelated storage checkpoints and same-problem query/hash changes preserve chip nodes, keyboard focus and horizontal scroll; popup company/practice nodes remain connected.');
  const statusDots = await exercisePopupStatusDots(ui, { getStatus, setStorage });
  checks.push(statusDots.check);
  await ui.mutate(`const node = document.querySelector('#enabled'); node.checked = false; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  await host.waitFor({ state: 'detached' });
  await ui.mutate(`const node = document.querySelector('#enabled'); node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  await assertChips(page, core, data, slug);
  checks.push('Toolbar enable/disable removes and restores the inline company bar on the active problem page.');
  return { checks, acceptance, practiceAcceptance: practiceLabels, companySort, statusDots };
}

export async function exercisePopupContext(ui, { data, core, slug }) {
  const expected = core.companiesForSlug(data, slug, 'all').slice(0, 5).map(company => company.name);
  await expectUI(ui, uiTexts('.company-name'), expected);
  await expectUI(ui, uiTexts('#problem-acceptance .acceptance-rate'), [acceptanceLabel(core, core.problemForSlug(data, slug).acceptanceRate)]);
  await ui.click('#companies button[data-company="Amazon"]');
  const practice = core.practiceQuestions(data, { company: 'Amazon', window: 'all' });
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice.questions.map(question => question.title));
  await expectUI(ui, `Array.from(document.querySelectorAll('#practice-questions li')).filter(row => row.querySelector('.current-problem')).map(row => row.dataset.slug)`, practice.questions.filter(question => question.slug === slug).map(question => question.slug));
  await ui.click('#back-companies');
  return 'Opening the toolbar after SPA navigation reads the new problem and updates its practice current-question marker without excluding it.';
}

export async function exerciseInlineNavigation(page, { data, core, context, onSPA }) {
  const checks = [];
  const host = page.locator('#company-lens-root');
  await page.evaluate(() => {
    history.pushState({}, '', '/problems/add-two-numbers/description/');
  });
  await page.waitForTimeout(1000);
  assert.equal(await host.count(), 0, 'A new URL must not render chips beneath the previous problem title.');
  await page.locator('#problem-header a').evaluate(node => { node.textContent = '2. Add Two Numbers'; node.setAttribute('href', '/problems/add-two-numbers/'); });
  await assertChips(page, core, data, 'add-two-numbers');
  if (onSPA) checks.push(await onSPA());
  checks.push('SPA URL changes wait for the matching new title before rendering and rerank every company chip.');
  await page.locator('#description-pane').evaluate(pane => { const replacement = pane.cloneNode(true); replacement.querySelector('#company-lens-root')?.remove(); pane.replaceWith(replacement); });
  await assertChips(page, core, data, 'add-two-numbers');
  assert.equal(await host.count(), 1);
  await host.evaluate(node => node.remove());
  await assertChips(page, core, data, 'add-two-numbers');
  assert.equal(await host.count(), 1);
  checks.push('Replacing the description subtree or externally removing the bar remounts exactly one inline row at the matching anchor.');
  await page.locator('#problem-description').evaluate(node => { node.hidden = true; });
  await host.waitFor({ state: 'detached' });
  await page.locator('#problem-description').evaluate(node => { node.hidden = false; });
  await assertChips(page, core, data, 'add-two-numbers');
  checks.push('Hiding and restoring the description removes and remounts the inline row without a floating fallback.');
  const late = await context.newPage();
  await late.goto('https://leetcode.com/problems/two-sum/description/?late=1');
  await late.waitForTimeout(1000); assert.equal(await late.locator('#company-lens-root').count(), 0);
  await late.locator('#problem-description').evaluate(node => node.insertAdjacentHTML('beforeend', '<a href="/problems/two-sum/">Related: Two Sum</a>'));
  await late.waitForTimeout(1000); assert.equal(await late.locator('#company-lens-root').count(), 0, 'A related link inside the statement cannot authorize an inline anchor.');
  await late.locator('#problem-description').evaluate((node, header) => node.insertAdjacentHTML('beforebegin', header), problemHeader());
  await assertChips(late, core, data, 'two-sum');
  const lateGeometry = await inlineGeometry(late);
  assert.ok(lateGeometry.host.top >= lateGeometry.tags.bottom - 1 && lateGeometry.host.bottom <= lateGeometry.description.top + 1);
  await late.close(); await page.bringToFront();
  checks.push('A delayed title/tag header mounts the bar when it arrives; unrelated links in the description do not create an anchor.');
  await page.evaluate(() => { history.pushState({}, '', '/problems/not-a-listed-problem/'); const anchor = document.querySelector('#problem-header a'); anchor.textContent = 'Not A Listed Problem'; anchor.setAttribute('href', '/problems/not-a-listed-problem/'); });
  await expectTexts(host.locator('.company-name'), []);
  await host.locator('.status-message').waitFor({ state: 'visible' });
  assert.match(await host.locator('.status-message').textContent(), /no company|no companies/i);
  await page.evaluate(() => history.pushState({}, '', '/problemset/')); await host.waitFor({ state: 'detached' });
  await page.evaluate(() => history.pushState({}, '', '/problems/%2F/')); await page.waitForTimeout(1000); assert.equal(await host.count(), 0);
  checks.push('Unknown problems show coverage feedback without old chips; non-problem and malformed paths remove the bar.');
  await page.goto('https://leetcode.cn/problems/two-sum/description/');
  await page.locator('#problem-header a').evaluate(node => { node.textContent = '1. 两数之和'; });
  await assertChips(page, core, data, 'two-sum');
  await page.goto('https://leetcode.com/contest/weekly-contest-100/problems/two-sum/');
  await page.locator('#problem-header a').evaluate(node => { node.textContent = 'Two Sum'; node.setAttribute('href', '/contest/weekly-contest-100/problems/two-sum/'); });
  await assertChips(page, core, data, 'two-sum');
  await page.goto('https://example.com/problems/two-sum/'); assert.equal(await host.count(), 0);
  checks.push('Localized LeetCode.cn titles and numberless contest titles mount correctly by slug; unrelated websites receive no inline bar.');
  return { checks };
}
