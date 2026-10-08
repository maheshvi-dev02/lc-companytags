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
  return { data, meta, windows, practice: core.practiceQuestions(data,
    { company: 'Amazon', window: 'all', excludeSlug: 'two-sum' }) };
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

export async function exerciseBundledPopup(ui, page, expected) {
  const topNames = companies => companies.slice(0, 5).map(company => company.name);
  await expectUI(ui, 'document.querySelector("#window-select").value', 'all');
  const note = await ui.read('document.querySelector("#window-note").textContent');
  assert.match(note, /Bundled snapshot/i);
  assert.ok(note.includes(String(new Date(expected.data.sourceUpdatedAt).getUTCFullYear())));
  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await expectUI(ui, uiTexts('.company-name'), topNames(expected.windows[window]));
    await expectTexts(page.locator('#company-lens-root .company-name'), expected.windows[window].map(company => company.name));
  }
  await ui.click('#companies button[data-company="Amazon"]');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), expected.practice.questions.map(question => question.title));
  const first = expected.practice.questions[0];
  const meta = await ui.read('document.querySelector("#practice-questions .question-meta").textContent');
  assert.ok(meta.includes(`score ${first.frequency}`) && meta.includes(`company rank #${first.rank}`));
  await ui.click('#back-companies');
  return { windowNote: note,
    check: 'Offline toolbar popup exposes all five bundled windows, source date, frequency/rank scores and real Amazon practice questions; window selections update the complete inline chip list.' };
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
  const sample = data.files[samplePath].records.find(({ slug }) => slug === 'two-sum');
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
        overflowX: getComputedStyle(list).overflowX }, lastChip: rect(list.querySelector('li:last-child a')) };
  });
}

async function assertChips(page, core, data, slug, window = 'all') {
  const expected = core.companiesForSlug(data, slug, window);
  const host = page.locator('#company-lens-root');
  await expectTexts(host.locator('.company-name'), expected.map(company => company.name));
  await expectTexts(host.locator('.frequency-score'), expected.map(company => company.frequency == null ? '—' : String(company.frequency)));
  for (const company of expected) {
    const chip = host.getByRole('link', { name: `${company.name}, view source`, exact: true });
    assert.equal(await chip.getAttribute('href'), company.sourceUrl);
    assert.equal(await chip.getAttribute('target'), '_blank');
    assert.match(await chip.getAttribute('rel'), /noopener/);
    const explanation = await chip.evaluate(node => (node.title || '') + ' ' + (node.getRootNode().getElementById(node.getAttribute('aria-describedby'))?.textContent || ''));
    assert.match(explanation, /not interview counts/i);
    if (company.rank != null) assert.ok(explanation.includes(`#${company.rank}`), `${company.name} rank must remain available in its tooltip/description.`);
  }
  return expected;
}

export async function exerciseInlineLayout(page, { core, data, slug = 'two-sum', output, browserName }) {
  const host = page.locator('#company-lens-root');
  const expected = await assertChips(page, core, data, slug);
  assert.equal(await host.locator('button,input,select,.card,.collapsed-bubble').count(), 0, 'The inline bar must have no floating-panel controls.');
  const geometry = await inlineGeometry(page);
  assert.ok(['static', 'relative'].includes(geometry.position), 'Company bar must participate in the normal page flow.');
  assert.equal(geometry.titleBeforeHost, true); assert.equal(geometry.hostBeforeDescription, true);
  assert.ok(geometry.host.top >= geometry.tags.bottom - 1, 'Company bar must appear below the complete title/tag group.');
  assert.ok(geometry.host.bottom <= geometry.description.top + 1, 'Company bar must appear before the problem statement.');
  assert.ok(geometry.documentWidth <= geometry.viewport.width, 'The inline bar must not widen the document.');
  assert.ok(['auto', 'scroll'].includes(geometry.list.overflowX));
  assert.ok(geometry.list.scrollWidth > geometry.list.clientWidth, 'All company chips must share one horizontal scrolling row.');
  const first = host.locator('.companies a').first();
  await first.focus(); await first.press('Tab');
  assert.equal(await host.locator('.companies a').nth(1).evaluate(node => node.getRootNode().activeElement === node), true);
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
    'All companies appear in source-frequency order with zero/unknown scores, pinned source links and accessible frequency/rank explanations.',
    'Company bar sits below the title/tags and before the description in normal flow; keyboard Tab reaches its chips and no floating controls remain.',
    'Horizontal scrolling reaches the last chip without widening the page at desktop or actual 375px viewport widths.',
  ] };
}

export async function exercisePopupFeatures(ui, page, { data, core, getStatus, setStorage, removeStorage, slug = 'two-sum' }) {
  const checks = [];
  const companies = window => core.companiesForSlug(data, slug, window);
  const names = window => companies(window).map(company => company.name);
  const top = window => names(window).slice(0, 5);
  await expectUI(ui, uiTexts('.company-name'), top('all'));
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
    await assertChips(page, core, data, slug, window);
  }
  checks.push('All five toolbar time windows rerank every inline company chip and update its source file and rank.');
  const practice = options => core.practiceQuestions(data, { company: 'Amazon', window: 'all', excludeSlug: slug, ...options });
  await ui.click('#companies button[data-company="Amazon"]');
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice().questions.map(question => question.title));
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
  checks.push('Toolbar practice retains frequency/rank, current-question exclusion, difficulty/topic filters, no-match states and direct LeetCode links.');
  await ui.mutate(`globalThis.__lctProgressNodes = { company: document.querySelector('#companies a'), question: document.querySelector('#practice-questions a') };`);
  const host = page.locator('#company-lens-root');
  const retained = await host.locator('.companies a').last().elementHandle();
  await host.locator('.companies a').last().focus();
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
  await ui.mutate(`const node = document.querySelector('#enabled'); node.checked = false; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  await host.waitFor({ state: 'detached' });
  await ui.mutate(`const node = document.querySelector('#enabled'); node.checked = true; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  await assertChips(page, core, data, slug);
  checks.push('Toolbar enable/disable removes and restores the inline company bar on the active problem page.');
  return { checks };
}

export async function exercisePopupContext(ui, { data, core, slug }) {
  const expected = core.companiesForSlug(data, slug, 'all').slice(0, 5).map(company => company.name);
  await expectUI(ui, uiTexts('.company-name'), expected);
  await ui.click('#companies button[data-company="Amazon"]');
  const practice = core.practiceQuestions(data, { company: 'Amazon', window: 'all', excludeSlug: slug });
  await expectUI(ui, uiTexts('#practice-questions .question-title'), practice.questions.map(question => question.title));
  await ui.click('#back-companies');
  return 'Opening the toolbar after SPA navigation reads the new problem and updates practice current-question exclusion.';
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
