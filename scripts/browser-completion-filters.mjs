import assert from 'node:assert/strict';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = selector => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
const text = selector => `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`;
async function expectRead(ui, expression, expected, label) {
  let actual;
  for (let attempt = 0; attempt < 240; attempt++) {
    actual = await ui.read(expression);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await pause(50);
  }
  assert.deepEqual(actual, expected, label || expression);
}

// Deliberately use ONLY the old, unfiltered source lookup for the oracle. The
// expected status subset is calculated independently before any page is sliced.
export function completionFilterOracle(core, data, fixture, options = {}) {
  const request = { window: 'all', ...options, completionFilter: 'all' };
  delete request.groupTopic;
  const lookup = request.company ? core.practiceQuestions : core.searchProblems;
  const key = request.company ? 'questions' : 'problems';
  const source = [];
  let page;
  do {
    page = lookup(data, { ...request, offset: source.length, limit: 100 });
    source.push(...page[key]);
  } while (page.hasMore);
  const known = slug => {
    const status = fixture.status(slug);
    if (status === null || /^(notac|tried|not_started)$/i.test(String(status))) return false;
    if (/^ac$/i.test(String(status))) return true;
    return null;
  };
  const selection = options.completionFilter || 'all';
  const filtered = selection === 'all' ? source : source.filter(row => known(row.slug) === (selection === 'solved'));
  const groups = new Map();
  for (const row of filtered) for (const topic of row.topics.length ? row.topics : [null]) groups.set(topic, (groups.get(topic) || 0) + 1);
  const rows = Object.hasOwn(options, 'groupTopic') ? filtered.filter(row => options.groupTopic === null ? !row.topics.length : row.topics.some(topic => topic.toLowerCase() === options.groupTopic.toLowerCase())) : filtered;
  return { rows, total: rows.length, source, topics: page.topics,
    unknownCount: source.filter(row => known(row.slug) === null).length,
    groups: [...groups].map(([topic, total]) => ({ topic, total })).sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'en')) };
}

export async function exerciseCompletionFilters(ui, { fixture, data, core, output, browserName = 'chromium',
  openLeetCode, closeLeetCode, openPopup, refresh = () => ui.mutate("window.dispatchEvent(new Event('focus'));"), onProgress = () => {} }) {
  const report = { stages: [], checks: [], screenshots: [], keyboard: ui.keyboard };
  const stage = name => { report.stages.push(name); onProgress(name); };
  const globalOptions = { window: 'all', query: 'tree', sort: 'relevance', completionFilter: 'all' };
  const companyOptions = { company: 'Walmart Labs', window: 'all', sort: 'frequency-desc', completionFilter: 'all' };
  const oracle = options => completionFilterOracle(core, data, fixture, options);
  const globalAll = oracle(globalOptions).rows, companyAll = oracle(companyOptions).rows;
  assert.ok(globalAll.length > 150 && companyAll.length > 100);
  const early = new Set([...globalAll.slice(0, 50), ...companyAll.slice(0, 20)].map(row => row.slug));
  const accepted = new Set([...globalAll.slice(50, 150), ...companyAll.slice(20, 120)].filter(row => !early.has(row.slug)).map(row => row.slug));
  for (const [index, slug] of Object.keys(data.windows.all.index).entries()) {
    fixture.setStatus(slug, accepted.has(slug) ? 'ac' : index % 5 === 0 ? '__missing__' : ['notac', null, 'TRIED', 'NOT_STARTED'][index % 4], 'alpha');
    fixture.setStatus(slug, index % 3 === 0 ? 'ac' : index % 5 === 0 ? '__missing__' : null, 'beta');
  }
  fixture.setAccount('alpha');
  const globalSolved = oracle({ ...globalOptions, completionFilter: 'solved' });
  const companySolved = oracle({ ...companyOptions, completionFilter: 'solved' });
  assert.ok(globalSolved.total > 50 && companySolved.total > 50, 'Fixture must require filtering before both initial pages.');
  assert.ok(globalAll.slice(0, 50).every(row => !accepted.has(row.slug)));
  assert.ok(companyAll.slice(0, 20).every(row => !accepted.has(row.slug)));
  report.fixture = { globalSource: globalAll.length, globalSolved: globalSolved.total, companySource: companyAll.length, companySolved: companySolved.total,
    lateGlobalSentinel: globalSolved.rows[0].slug, lateCompanySentinel: companySolved.rows[0].slug };

  async function rows(driver, selector, expected) {
    await expectRead(driver, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.dataset.slug)`, expected.map(row => row.slug));
    const actual = await driver.read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>({slug:node.dataset.slug,title:node.querySelector('h3,.question-title')?.textContent,meta:node.querySelector('.question-meta')?.textContent||''}))`);
    assert.equal(new Set(actual.map(row => row.slug)).size, actual.length);
    actual.forEach((row, index) => {
      const wanted = expected[index]; assert.equal(row.title, wanted.title);
      if (Object.hasOwn(wanted, 'rank')) {
        assert.ok(row.meta.includes(wanted.rank === null ? 'rank unavailable' : `company rank #${wanted.rank}`));
        assert.ok(row.meta.includes(`score ${wanted.frequency === null ? 'unavailable' : wanted.frequency}`));
      }
    });
  }
  async function summary(driver, selector, expected) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await driver.read(text(selector));
      if (expected ? value.includes(expected.toLocaleString('en')) : /no .*match/i.test(value)) return value;
      await pause(50);
    }
    assert.fail(`Expected ${selector} to report ${expected}: ${await driver.read(text(selector))}`);
  }
  async function request(driver, message) {
    await driver.mutate(`globalThis.__filterProbe=undefined;void(globalThis.browser||globalThis.chrome).runtime.sendMessage(${JSON.stringify(message)}).then(value=>{globalThis.__filterProbe=value},error=>{globalThis.__filterProbe={probeError:error.message}});`);
    await expectRead(driver, 'globalThis.__filterProbe!==undefined', true);
    const result = await driver.read('globalThis.__filterProbe'); assert.equal(result.ok, true, JSON.stringify(result)); return result;
  }
  async function apiMatches(driver, options, extra = {}) {
    const expected = oracle(options);
    const result = await request(driver, { type: options.company ? 'LCT_PRACTICE' : 'LCT_SEARCH_PROBLEMS', ...options, limit: 100, ...extra });
    const key = options.company ? 'questions' : 'problems';
    assert.deepEqual(result[key].map(row => row.slug), expected.rows.slice(0, 100).map(row => row.slug));
    assert.equal(result.total, expected.total);
    assert.deepEqual(result.topicGroups.slice().sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'en')), expected.groups);
    assert.deepEqual(result.topics, expected.topics, 'The status subset must not shrink the source topic catalog.');
    if (options.completionFilter !== 'all') {
      assert.equal(result.completion.state, 'ready'); assert.equal(result.completion.unknownCount, expected.unknownCount);
      assert.equal(typeof result.completion.sessionKey, 'string'); assert.ok(result.completion.revision);
      assert.ok(result[key].every(row => row.completed === (options.completionFilter === 'solved')));
    }
    return result;
  }
  async function flat(driver, selector, summarySelector, options, limit) {
    const expected = oracle(options); await rows(driver, selector, expected.rows.slice(0, limit));
    await summary(driver, summarySelector, expected.total); return expected;
  }
  async function topics(driver, prefix, selected) {
    await driver.click(`#${prefix}topic-picker-trigger`); await driver.click('#topic-picker-reset');
    for (const topic of selected) { await driver.fill('#topic-picker-search', topic); await driver.click(`#topic-picker-options input[data-topic=${JSON.stringify(topic)}]`); }
    await driver.press('#topic-picker-search', 'Escape'); await expectRead(driver, visible('#topic-picker-menu'), false);
  }
  async function groups(driver, root, options) {
    const expected = oracle(options);
    const wanted = options.topics?.length ? options.topics.map(topic => ({ topic, total: expected.groups.find(item => item.topic === topic)?.total || 0 })) : expected.groups;
    await expectRead(driver, `Array.from(document.querySelectorAll(${JSON.stringify(root + ' .topic-group')}),node=>({topic:node.dataset.topic||null,total:Number(node.querySelector('.topic-group-count').textContent.replace(/[^0-9]/g,''))})).sort((a,b)=>String(a.topic).localeCompare(String(b.topic),'en'))`, wanted.slice().sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'en')));
    const largest = expected.groups.slice().sort((a, b) => b.total - a.total)[0];
    if (!largest) return;
    const group = `${root} .topic-group[data-topic=${JSON.stringify(largest.topic ?? '')}]`;
    await driver.click(`${group} .topic-group-toggle`);
    const expectedRows = oracle({ ...options, groupTopic: largest.topic }).rows;
    await rows(driver, `${group} .question-row`, expectedRows.slice(0, 20));
    if (expectedRows.length > 20) { await driver.click(`${group} .topic-group-load-more`); await rows(driver, `${group} .question-row`, expectedRows.slice(0, 40)); }
    return { group, rows: expectedRows };
  }
  async function nonready(driver, options, state) {
    const result = await request(driver, { type: options.company ? 'LCT_PRACTICE' : 'LCT_SEARCH_PROBLEMS', ...options, refreshCompletion: true });
    assert.equal(result.completion.state, state); assert.equal(result.total, null);
    assert.deepEqual(result[options.company ? 'questions' : 'problems'], []); assert.deepEqual(result.topicGroups, []);
    assert.equal(result.hasMore, false); assert.equal(result.available, true);
    return result;
  }
  const globalRows = '#results > .question-row', companyRows = '#detail-results > .question-row';
  let popup;
  try {
    stage('full-source oracle and unavailable account versus empty matches');
    await ui.fill('#global-search', 'tree'); await flat(ui, globalRows, '#result-summary', globalOptions, 50);
    await ui.select('#problem-status-select', 'solved'); globalOptions.completionFilter = 'solved';
    await rows(ui, globalRows, []); await nonready(ui, globalOptions, 'unavailable');
    assert.match(await ui.read(text('#result-summary')), /LeetCode|sign.in|status/i);
    await ui.select('#problem-status-select', 'all'); globalOptions.completionFilter = 'all';
    await flat(ui, globalRows, '#result-summary', globalOptions, 50);
    await openLeetCode('https://leetcode.com/problems/longest-substring-without-repeating-characters/');
    await refresh();
    await expectRead(ui, "document.querySelector('#completion-status').dataset.state", 'ready');
    await expectRead(ui, "Array.from(document.querySelectorAll('#results > .question-row')).filter(row=>row.querySelector('.completion-indicator')?.getClientRects().length).map(row=>row.dataset.slug)", []);
    const marker = globalSolved.rows[0];
    await ui.fill('#global-search', marker.slug); await rows(ui, globalRows, oracle({ ...globalOptions, query: marker.slug }).rows.slice(0, 50));
    await expectRead(ui, `Boolean(document.querySelector(${JSON.stringify(`#results [data-slug="${marker.slug}"] .completion-indicator`)})?.getClientRects().length)`, true);
    await ui.fill('#global-search', 'tree'); await flat(ui, globalRows, '#result-summary', globalOptions, 50);

    stage('global solved and not-solved filtering before paging and topic counts');
    await ui.select('#problem-status-select', 'solved'); globalOptions.completionFilter = 'solved';
    await flat(ui, globalRows, '#result-summary', globalOptions, 50); const alpha = await apiMatches(ui, globalOptions);
    const catalogCount = fixture.calls.filter(call => call.catalog).length;
    await ui.click('#load-more'); await flat(ui, globalRows, '#result-summary', globalOptions, 100);
    await ui.click('#problem-view-topics'); await groups(ui, '#topic-groups', globalOptions);
    assert.equal(fixture.calls.filter(call => call.catalog).length, catalogCount, 'Pagination and grouped requests should reuse one valid account snapshot.');
    await ui.click('#collapse-topic-groups');
    await ui.select('#problem-status-select', 'not-solved'); globalOptions.completionFilter = 'not-solved';
    await groups(ui, '#topic-groups', globalOptions); await apiMatches(ui, globalOptions);
    await ui.click('#problem-view-list'); await flat(ui, globalRows, '#result-summary', globalOptions, 50);
    await ui.select('#problem-difficulty-select', 'Medium'); globalOptions.difficulty = 'Medium';
    await topics(ui, '', ['Tree', 'Depth-First Search']); globalOptions.topics = ['Tree', 'Depth-First Search'];
    await flat(ui, globalRows, '#result-summary', globalOptions, 50); await apiMatches(ui, globalOptions);
    await ui.select('#topic-match-select', 'all'); globalOptions.topicMatch = 'all';
    await ui.select('#sort-select', 'name-desc'); globalOptions.sort = 'name-desc';
    await flat(ui, globalRows, '#result-summary', globalOptions, 50); await apiMatches(ui, globalOptions);
    await ui.select('#window-select', '6m'); globalOptions.window = '6m';
    await flat(ui, globalRows, '#result-summary', globalOptions, 50); await apiMatches(ui, globalOptions);
    await ui.select('#window-select', 'all'); globalOptions.window = 'all';

    stage('company full set, source rank, groups and nested Back');
    await ui.click('#mode-companies'); await ui.fill('#global-search', companyOptions.company);
    await expectRead(ui, visible('#results .company-title[data-company="Walmart Labs"]'), true);
    await ui.click('#results .company-title[data-company="Walmart Labs"]');
    await ui.select('#detail-status-select', 'solved'); companyOptions.completionFilter = 'solved';
    await flat(ui, companyRows, '#detail-summary', companyOptions, 50); await apiMatches(ui, companyOptions);
    await ui.click('#detail-load-more'); await flat(ui, companyRows, '#detail-summary', companyOptions, 100);
    await ui.click(`${companyRows}:first-child button[data-action=problem]`); await expectRead(ui, text('#detail-kind'), 'Problem companies');
    await ui.click('#detail-back'); await flat(ui, companyRows, '#detail-summary', companyOptions, 100);
    await ui.click('#detail-view-topics'); await groups(ui, '#detail-topic-groups', companyOptions);
    await ui.click('#collapse-detail-topic-groups');
    fixture.setAccount(null); await refresh(); await nonready(ui, companyOptions, 'signed-out');
    await expectRead(ui, "document.querySelectorAll('#detail-topic-groups .question-row').length", 0);
    assert.match(await ui.read(text('#detail-summary')), /sign.in/i);
    fixture.setAccount('beta'); await refresh(); await groups(ui, '#detail-topic-groups', companyOptions);
    const beta = await apiMatches(ui, companyOptions); assert.notEqual(beta.completion.sessionKey, alpha.completion.sessionKey);
    await ui.click('#detail-view-list'); await flat(ui, companyRows, '#detail-summary', companyOptions, 50);
    fixture.state.failure = 'http'; await refresh(); await nonready(ui, companyOptions, 'unavailable'); await rows(ui, companyRows, []);
    await ui.select('#detail-status-select', 'all'); companyOptions.completionFilter = 'all';
    await flat(ui, companyRows, '#detail-summary', companyOptions, 50);

    fixture.state.failure = null; fixture.setAccount('alpha'); await refresh();
    await ui.select('#detail-status-select', 'solved'); companyOptions.completionFilter = 'solved';
    await flat(ui, companyRows, '#detail-summary', companyOptions, 50);

    stage('account change detected before appending a different snapshot');
    fixture.setAccount('beta'); await ui.click('#detail-load-more');
    await flat(ui, companyRows, '#detail-summary', companyOptions, 50);
    await apiMatches(ui, companyOptions);
    fixture.setAccount('alpha'); await refresh(); await flat(ui, companyRows, '#detail-summary', companyOptions, 50);

    stage('superseded account snapshot cannot restore stale filtered rows');
    fixture.state.holdNext = true; await refresh();
    for (let attempt = 0; attempt < 200 && !fixture.pending.length; attempt++) await pause(50);
    assert.equal(fixture.pending.length, 1, 'Hold a real source snapshot response, not a mocked extension result.');
    fixture.setAccount('beta'); await refresh();
    const alphaOnly = companySolved.rows.filter(row => !oracle(companyOptions).rows.some(other => other.slug === row.slug)).map(row => row.slug);
    await ui.mutate(`globalThis.__filterPaints=[];globalThis.__filterObserver=new MutationObserver(()=>__filterPaints.push(Array.from(document.querySelectorAll('#detail-results > .question-row'),row=>row.dataset.slug)));__filterObserver.observe(document.querySelector('#detail-results'),{subtree:true,childList:true});`);
    fixture.releaseAll(); await flat(ui, companyRows, '#detail-summary', companyOptions, 50); await apiMatches(ui, companyOptions);
    assert.equal(await ui.read(`__filterPaints.some(slugs=>slugs.some(slug=>${JSON.stringify(alphaOnly)}.includes(slug)))`), false);
    await ui.mutate('__filterObserver.disconnect();');

    stage('popup practice filters complete company list before its twenty-row page');
    fixture.setAccount('alpha'); await refresh();
    popup = await openPopup(); const p = popup.ui;
    if (await p.read(visible('#show-companies'))) await p.click('#show-companies');
    await p.click('.practice-company[aria-label="Practice Walmart Labs"]');
    const popupOptions = { ...companyOptions, completionFilter: 'all' };
    await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 20);
    await p.select('#practice-status-select', 'solved'); popupOptions.completionFilter = 'solved';
    await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 20); await apiMatches(p, popupOptions);
    await p.click('#practice-load-more'); await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 40);
    await p.click('#practice-show-all'); const complete = await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, Infinity);
    assert.ok(complete.total > 20); assert.equal(await p.read(visible('#practice-load-more')), false);
    await p.select('#practice-status-select', 'not-solved'); popupOptions.completionFilter = 'not-solved';
    await p.select('#difficulty-select', 'Medium'); popupOptions.difficulty = 'Medium';
    await p.fill('#topic-input', 'Array'); popupOptions.topic = 'Array';
    await p.select('#practice-sort-select', 'name-desc'); popupOptions.sort = 'name-desc';
    await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 20); await apiMatches(p, popupOptions);
    fixture.setAccount(null); await popup.refresh(); await nonready(p, popupOptions, 'signed-out'); await rows(p, '#practice-questions > li', []);
    assert.match(await p.read(text('#practice-completion-status')), /sign.in/i);
    await p.select('#practice-status-select', 'all'); popupOptions.completionFilter = 'all';
    await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 20);
    fixture.setAccount('alpha'); await popup.refresh();
    await p.fill('#topic-input', ''); delete popupOptions.topic;
    await p.select('#difficulty-select', ''); delete popupOptions.difficulty;
    await p.select('#practice-status-select', 'solved'); popupOptions.completionFilter = 'solved';
    await flat(p, '#practice-questions > li', '#practice-summary', popupOptions, 20);
    if (popup.openExpanded) {
      const expanded = await popup.openExpanded();
      try {
        assert.equal(new URL(expanded.url).searchParams.get('completionFilter'), 'solved');
        await expectRead(expanded.ui, "document.querySelector('#detail-status-select').value", 'solved');
        await flat(expanded.ui, companyRows, '#detail-summary', popupOptions, 50);
        report.checks.push('The real popup expand button preserves solved status and sort in the new company Explorer tab.');
      } finally { await expanded.close(); }
    }
    if (p.setViewport && p.setColorScheme && p.screenshot) {
      await p.setViewport({ width: 440, height: 600 });
      for (const theme of ['light', 'dark']) {
        await p.setColorScheme(theme); assert.ok(await p.read('document.documentElement.scrollWidth<=innerWidth'));
        const filename = path.join(output, `${browserName}-completion-filter-popup-${theme}.png`);
        await p.screenshot(filename, { fullPage: false }); report.screenshots.push(filename);
      }
    }
    await popup.close(); popup = null;
    await refresh(); await flat(ui, companyRows, '#detail-summary', companyOptions, 50);
    await ui.click('#detail-status-select-trigger'); await ui.press('#detail-status-select-trigger', 'Home'); await ui.press('#detail-status-select-trigger', 'Escape');
    await expectRead(ui, "document.querySelector('#detail-status-select').value", 'solved');
    if (ui.setViewport && ui.setColorScheme && ui.screenshot) for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
      await ui.setViewport({ width, height: 900 }); await ui.setColorScheme(theme);
      await ui.mutate("document.querySelector('#detail-view').scrollIntoView({block:'start'});");
      assert.ok(await ui.read('document.documentElement.scrollWidth<=innerWidth'));
      const filename = path.join(output, `${browserName}-completion-filter-${theme}-${width}.png`);
      await ui.screenshot(filename, { fullPage: false }); report.screenshots.push(filename);
    }
    if (ui.setViewport && ui.screenshot) {
      await ui.setViewport({ width: 980, height: 1000 }); await ui.setColorScheme?.('dark');
      await ui.mutate("document.querySelector('#detail-view').scrollIntoView({block:'start'});");
      const clip = await ui.read("(()=>{const view=document.querySelector('#detail-view').getBoundingClientRect(),last=document.querySelector('#detail-results > .question-row:nth-child(3)').getBoundingClientRect();return{x:Math.max(0,view.x),y:Math.max(0,view.y),width:Math.min(view.width,innerWidth-view.x),height:Math.min(last.bottom+8,innerHeight)-Math.max(0,view.y)};})()");
      const filename = path.join(output, `${browserName}-completion-filter-preview.png`);
      await ui.screenshot(filename, { fullPage: false, clip }); report.screenshots.push(filename);
    }
    assert.deepEqual(fixture.forbidden, []);
    report.checks.push('Independent full-source oracle verifies solved/not-solved subsets before global50, company50 and popup20 pagination.',
      'Exact unique totals, topic-group counts, unknown exclusions and unchanged topic catalogs match the source oracle.',
      'Difficulty, multi-topic any/all, query, sort and time window compose with completion status; source ranks remain intact.',
      'Global/company grouped paging and nested Back preserve membership; logout clears cached filtered groups.',
      'No-tab, logout and source errors produce unknown totals and no filtered rows; All remains usable offline.',
      'Account switches and a delayed actual source response cannot publish old filtered membership.',
      'Popup practice paginates the complete filtered company set with no duplicate rows and retains accessible custom controls.');
    report.requestCount = fixture.calls.length;
    return report;
  } finally { fixture.releaseAll(); if (popup) await popup.close(); await closeLeetCode(); }
}
