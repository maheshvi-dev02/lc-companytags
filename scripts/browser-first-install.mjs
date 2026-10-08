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

export async function exerciseBundledPanel(page, expected, timings) {
  const host = page.locator('#company-lens-root');
  await host.waitFor({ state: 'visible' });
  await expectTexts(host.locator('.company-name'), expected.windows.all.slice(0, 5).map(({ name }) => name));
  const readyAt = Date.now();
  assert.equal(await host.locator('.window-select').inputValue(), 'all', 'New installations default to all-time data.');
  const formatScore = (score) => score == null ? '—' : String(score);
  await expectTexts(host.locator('.frequency-score'), expected.windows.all.slice(0, 5).map(({ frequency }) => formatScore(frequency)));
  await expectTexts(host.locator('.company-rank'), expected.windows.all.slice(0, 5).map(({ rank }) => rank == null ? 'Rank unavailable' : `Company rank #${rank}`));
  const windowNote = await host.locator('.window-note').textContent();
  assert.match(windowNote, /Bundled snapshot/i, 'Fresh offline data must be identified as bundled.');
  assert.ok(windowNote.includes(String(new Date(expected.data.sourceUpdatedAt).getUTCFullYear())), 'The actual source date must be visible.');
  const counts = {};
  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    const companies = expected.windows[window];
    await host.locator('.window-select').selectOption(window);
    await expectTexts(host.locator('.company-name'), companies.slice(0, 5).map(({ name }) => name));
    if (companies.length > 5) {
      await host.getByRole('button', { name: `Show all ${companies.length} companies` }).click();
      await expectTexts(host.locator('.company-name'), companies.map(({ name }) => name));
      await host.getByRole('button', { name: 'Show fewer' }).click();
    }
    counts[window] = companies.length;
  }
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await expectTexts(host.locator('.practice-questions .question-title'), expected.practice.questions.map(({ title }) => title));
  assert.ok(expected.practice.questions.length > 0);
  const firstQuestion = expected.practice.questions[0];
  const firstMeta = await host.locator('.practice-questions .question-meta').first().textContent();
  assert.ok(firstMeta.includes(`score ${formatScore(firstQuestion.frequency)}`));
  assert.ok(firstMeta.includes(`company rank #${firstQuestion.rank}`));
  assert.equal(await host.locator('.practice-questions a').first().getAttribute('href'), firstQuestion.url);
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  let bubblePreview;
  if (timings.output && timings.browserName) {
    await host.getByRole('button', { name: 'Collapse Company Lens' }).click();
    const bubble = host.locator('.collapsed-bubble');
    await bubble.waitFor({ state: 'visible' });
    await expectTexts(bubble.locator('.bubble-count'), [`${expected.windows.all.length}+`]);
    const rectangle = await bubble.boundingBox();
    assert.equal(rectangle.width, 64); assert.equal(rectangle.height, 64);
    bubblePreview = path.join(timings.output, `${timings.browserName}-first-install-bubble.png`);
    await page.screenshot({ path: bubblePreview,
      clip: { x: rectangle.x - 12, y: rectangle.y - 12, width: 88, height: 88 }, animations: 'disabled' });
    await bubble.click();
    await host.locator('.body').waitFor({ state: 'visible' });
  }
  return {
    bubblePreview,
    startupToFirstPanelResultsMs: readyAt - timings.startupStartedAt,
    navigationToFirstPanelResultsMs: readyAt - timings.navigationStartedAt,
    sourceUpdatedAt: expected.data.sourceUpdatedAt, commit: expected.data.commit,
    companyCount: expected.data.companyCount, problemCount: expected.data.problemCount,
    twoSumCompaniesByWindow: counts, windowNote,
    check: 'Fresh installation displays all five packaged windows, ranked tags, expandable companies, frequency scores, company ranks and practice questions without GitHub access.',
  };
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

export async function exerciseCollapsedBubble(page, { output, browserName, setCollapsed, getCollapsed, expectedCount = 7 }) {
  const host = page.locator('#company-lens-root');
  const bubble = host.locator('.collapsed-bubble');
  const expandedWidth = (await host.boundingBox()).width;
  assert.ok(expandedWidth > 250, 'Expanded panel must retain its full layout.');
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('micro');
  await expectTexts(host.locator('.company-name'), ['Microsoft']);
  await host.getByRole('button', { name: 'Collapse Company Lens' }).click();
  await bubble.waitFor({ state: 'visible' });
  const assertCollapsed = async () => {
    const hitbox = await host.boundingBox();
    const button = await bubble.boundingBox();
    for (const rectangle of [hitbox, button]) {
      assert.equal(rectangle.width, 64, 'Collapsed visual and pointer hitbox must both be 64px wide.');
      assert.equal(rectangle.height, 64, 'Collapsed visual and pointer hitbox must both be 64px high.');
    }
    assert.equal(await host.locator('.card').isVisible(), false);
    assert.equal(await host.locator('.header').isVisible(), false);
    assert.equal(await host.locator('.brand').isVisible(), false);
    assert.equal(await host.locator('.body').isVisible(), false);
    assert.equal(await bubble.locator('.mark').isVisible(), true);
    assert.equal(await bubble.locator('.bubble-count').textContent(), `${expectedCount}+`, 'Count covers every company, including search-hidden and undisclosed rows.');
    assert.equal(await bubble.evaluate((node) => node.tagName), 'BUTTON');
    assert.match(await bubble.getAttribute('aria-label'), /^Expand Company Lens/);
    assert.equal(await bubble.getAttribute('aria-expanded'), 'false');
    assert.equal(await bubble.getAttribute('aria-controls'), 'company-lens-body');
    return { hitbox, button, count: await bubble.locator('.bubble-count').textContent() };
  };
  const geometry = await assertCollapsed();
  await page.screenshot({ path: path.join(output, `${browserName}-collapsed.png`), fullPage: true, animations: 'disabled' });
  await page.screenshot({ path: path.join(output, `${browserName}-collapsed-bubble.png`),
    clip: { x: geometry.button.x - 12, y: geometry.button.y - 12, width: 88, height: 88 }, animations: 'disabled' });
  const assertExpanded = async () => {
    await host.locator('.body').waitFor({ state: 'visible' });
    assert.equal(await bubble.isVisible(), false);
    assert.equal((await host.boundingBox()).width, expandedWidth);
    assert.equal(await host.locator('.header').isVisible(), true);
    assert.equal(await host.locator('.brand').isVisible(), true);
  };
  await bubble.click({ position: { x: 8, y: 8 } }); // Whole button, including space outside the icon/count.
  await assertExpanded();
  await host.getByRole('searchbox', { name: 'Filter company names' }).fill('');
  for (const key of ['Enter', 'Space']) {
    await host.getByRole('button', { name: 'Collapse Company Lens' }).click();
    await bubble.waitFor({ state: 'visible' });
    await bubble.focus();
    await bubble.press(key);
    await assertExpanded();
  }
  await host.getByRole('button', { name: 'Collapse Company Lens' }).click();
  await bubble.waitFor({ state: 'visible' });
  let saved = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    saved = await getCollapsed();
    if (saved) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(saved, true, 'Collapse preference must be saved.');
  await page.reload();
  await bubble.waitFor({ state: 'visible' });
  // Wait for cached problem tags to populate the count after document reload.
  await expectTexts(bubble.locator('.bubble-count'), [`${expectedCount}+`]);
  await assertCollapsed();
  await setCollapsed(false);
  await assertExpanded();
  await setCollapsed(true);
  await bubble.waitFor({ state: 'visible' });
  await assertCollapsed();
  await setCollapsed(false);
  await assertExpanded();
  return { ...geometry, expandedWidth,
    check: 'Collapsed panel is a 64px square icon/count button with a matching hitbox; full counts, corner clicks, Enter/Space, saved preference and external setting changes work.' };
}
