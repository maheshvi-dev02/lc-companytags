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
  return {
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
