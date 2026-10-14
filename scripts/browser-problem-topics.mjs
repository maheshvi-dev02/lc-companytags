import assert from 'node:assert/strict';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = selector => `document.querySelector(${JSON.stringify(selector)})?.value`;
const visible = selector => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
const text = selector => `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`;
const group = topic => `#topic-groups .topic-group[data-topic=${JSON.stringify(topic ?? '')}]`;

async function expectRead(ui, expression, expected, label) {
  let observed;
  for (let attempt = 0; attempt < 160; attempt++) {
    observed = await ui.read(expression);
    if (JSON.stringify(observed) === JSON.stringify(expected)) return observed;
    await pause(50);
  }
  assert.deepEqual(observed, expected, label || expression);
}

// Uses the existing real-document drivers. Firefox RDP interactions retain their
// explicit synthetic-input caveat; Chromium supplies trusted browser input.
export async function exerciseProblemTopics(ui, { data, core, output, browserName = 'chromium', onProgress = () => {} }) {
  const report = { keyboard: ui.keyboard, checks: [], screenshots: [], stages: [] };
  const options = { window: 'all', query: '', difficulty: '', topics: [], topicMatch: 'any', sort: 'relevance' };
  const source = extra => core.searchProblems(data, { ...options, limit: 50, ...extra });
  const stage = name => { report.stages.push(name); onProgress(name); };
  const selectedTopics = "Array.from(document.querySelectorAll('#topic-picker-selected button[data-topic]'),node=>node.dataset.topic).sort()";
  async function preparePicker() {
    await ui.mutate("document.querySelector('#topic-picker-trigger').scrollIntoView({block:'nearest'});");
    await pause(60); // Let scroll dismissal finish before opening a positioned dialog.
  }
  async function selectTopics(topics) {
    if (JSON.stringify(await ui.read(selectedTopics)) === JSON.stringify(topics.slice().sort())) { options.topics = topics.slice(); return; }
    await preparePicker();
    if (!await ui.read(visible('#topic-picker-menu'))) await ui.click('#topic-picker-trigger');
    if (!await ui.read("document.querySelector('#topic-picker-reset').disabled")) await ui.click('#topic-picker-reset');
    for (const topic of topics) {
      await ui.fill('#topic-picker-search', topic);
      const input = `#topic-picker-options input[data-topic=${JSON.stringify(topic)}]`;
      await expectRead(ui, `Boolean(document.querySelector(${JSON.stringify(input)}))`, true);
      await ui.click(input);
    }
    await ui.press('#topic-picker-search', 'Escape');
    await expectRead(ui, visible('#topic-picker-menu'), false);
    options.topics = topics.slice();
    await expectRead(ui, selectedTopics, topics.slice().sort());
  }
  async function assertRows(selector, expected) {
    await expectRead(ui, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.dataset.slug)`, expected.map(row => row.slug));
    const observed = await ui.read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>({
      slug:node.dataset.slug,title:node.querySelector('.result-title')?.textContent,
      acceptance:node.querySelector('.acceptance-rate')?.textContent,
      meta:node.querySelector('.result-meta')?.textContent,content:node.textContent,
      href:node.querySelector('.leetcode-link')?.href }))`);
    for (const [index, row] of observed.entries()) {
      const expectedRow = expected[index];
      assert.equal(row.title, expectedRow.title);
      assert.equal(row.href, expectedRow.url);
      assert.equal(row.acceptance, core.formatAcceptanceRate(expectedRow.acceptanceRate) === null ? 'Acceptance unavailable' : `Acceptance ${core.formatAcceptanceRate(expectedRow.acceptanceRate)}`);
      assert.ok(row.meta.includes(expectedRow.difficulty || 'Difficulty unavailable'));
      assert.ok(row.meta.includes(`${expectedRow.companyCount.toLocaleString('en')} ${expectedRow.companyCount === 1 ? 'company' : 'companies'}`));
      for (const topic of expectedRow.topics) assert.ok(row.content.includes(topic), `${row.slug} must expose its ${topic} topic.`);
    }
    assert.equal(new Set(observed.map(row => row.slug)).size, observed.length, 'Each individual list must contain unique problems.');
  }
  async function assertFlat(limit = 50) {
    const expected = source({ limit });
    await assertRows('#results > .question-row', expected.problems);
    await expectRead(ui, `document.querySelector('#results').getAttribute('aria-busy')`, 'false');
    assert.ok((await ui.read(text('#result-summary'))).includes(expected.total.toLocaleString('en')));
    return expected;
  }
  async function assertCatalog() {
    await preparePicker();
    await ui.click('#topic-picker-trigger'); await ui.fill('#topic-picker-search', '');
    await expectRead(ui, "Array.from(document.querySelectorAll('#topic-picker-options input[data-topic]'),node=>node.dataset.topic).sort()", source().topics.slice().sort(), 'The visible picker must retain the complete selected-window catalog despite other filters.');
    await ui.press('#topic-picker-search', 'Escape');
  }
  async function assertGroups() {
    const expected = source();
    const wanted = options.topics.length ? options.topics.map(topic => ({ topic, total: expected.topicGroups.find(item => item.topic?.toLowerCase() === topic.toLowerCase())?.total || 0 })) : expected.topicGroups;
    const sort = rows => rows.slice().sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'en'));
    await expectRead(ui, `Array.from(document.querySelectorAll('#topic-groups .topic-group'),node=>({topic:node.dataset.topic||null,total:Number(node.querySelector('.topic-group-count').textContent.replace(/[^0-9]/g,''))})).sort((a,b)=>String(a.topic).localeCompare(String(b.topic),'en'))`, sort(wanted));
    assert.ok((await ui.read(text('#result-summary'))).includes(expected.total.toLocaleString('en')));
    return expected;
  }
  async function assertGroupRows(topic, limit = 20) {
    const expected = source({ groupTopic: topic, limit });
    await assertRows(`${group(topic)} .topic-group-results > .question-row`, expected.problems);
    return expected;
  }
  async function toggleGroup(topic, expanded) {
    const selector = `${group(topic)} .topic-group-toggle`;
    if ((await ui.read(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`)) !== String(expanded)) await ui.click(selector);
    await expectRead(ui, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`, String(expanded));
  }
  await expectRead(ui, visible('#problem-filters'), true);
  await ui.mutate(`const api=globalThis.browser||globalThis.chrome;const send=api.runtime.sendMessage.bind(api.runtime);
    const audit=globalThis.__problemTopicsAudit={calls:[],inflight:0,maxConcurrent:0,pending:[],holdAll:false,hold:null,fail:null,unavailable:false};
    const match=(rule,message)=>rule&&Object.entries(rule).every(([key,val])=>message[key]===val);
    api.runtime.sendMessage=async(message,...args)=>{
      if(message?.type!=='LCT_SEARCH_PROBLEMS')return send(message,...args);
      audit.calls.push({...message});const grouped=Object.hasOwn(message,'groupTopic');
      if(grouped){audit.inflight++;audit.maxConcurrent=Math.max(audit.maxConcurrent,audit.inflight);}
      try{
        if(match(audit.fail,message)){audit.fail=null;return{ok:false,error:'Injected group page failure. Try again.'};}
        const hold=grouped&&(audit.holdAll||match(audit.hold,message));if(hold&&audit.hold)audit.hold=null;
        const response=await send(message,...args);
        if(hold)await new Promise(resolve=>{const entry={message,release:()=>{audit.pending.splice(audit.pending.indexOf(entry),1);resolve();}};audit.pending.push(entry);});
        if(audit.unavailable&&!grouped)return{...response,problems:[],total:0,topics:[],topicGroups:[],hasMore:false,available:false,windowAvailable:false};
        return response;
      }finally{if(grouped)audit.inflight--;}
    };audit.restore=()=>{audit.holdAll=false;for(const entry of audit.pending.slice())entry.release();api.runtime.sendMessage=send;};`);
  try {
    stage('flat filters and complete counts');
    const baseline = await assertFlat();
    assert.ok(baseline.total > 50 && baseline.topics.length > 20);
    await ui.click('#load-more'); await assertFlat(100);
    await selectTopics(['Array', 'Linked List']);
    await ui.select('#problem-difficulty-select', 'Medium'); options.difficulty = 'Medium';
    const any = await assertFlat();
    await ui.select('#topic-match-select', 'all'); options.topicMatch = 'all';
    const all = await assertFlat();
    assert.ok(any.total > all.total && all.total > 0);
    assert.deepEqual(all.topics, baseline.topics, 'Topic catalog must describe the full window, not just filtered results.');
    await assertCatalog();
    report.anyTotal = any.total; report.allTotal = all.total;
    await ui.click('#problem-view-topics'); await assertGroups();
    await expectRead(ui, "Array.from(document.querySelectorAll('#topic-groups .topic-group-toggle')).every(node=>node.getAttribute('aria-expanded')==='false')", true);
    for (const topic of options.topics) { await toggleGroup(topic, true); await assertGroupRows(topic); }
    const array = source({ groupTopic: 'Array', limit: 100 }), linked = source({ groupTopic: 'Linked List', limit: 100 });
    assert.deepEqual(array.problems.map(row => row.slug), linked.problems.map(row => row.slug), 'All-matching problems must legitimately appear in both selected topic groups.');
    assert.ok(await ui.read(visible('#topic-group-note')));
    await ui.click('#problem-view-list');
    await ui.select('#sort-select', 'name-desc'); options.sort = 'name-desc';
    await ui.fill('#global-search', 'list'); options.query = 'list';
    await ui.select('#window-select', '3m'); options.window = '3m';
    await assertFlat(); await assertCatalog();
    await ui.fill('#global-search', 'no-such-company-lens-problem'); options.query = 'no-such-company-lens-problem';
    assert.equal((await assertFlat()).total, 0);
    assert.equal(await ui.read("document.querySelector('#topic-picker-trigger').disabled"), false);
    assert.equal(await ui.read("document.querySelector('#problem-difficulty-select-trigger').disabled"), false);
    assert.match(await ui.read(text('#search-message')), /no .*match/i);
    await ui.fill('#global-search', ''); options.query = '';
    await ui.select('#window-select', 'all'); options.window = 'all';
    await ui.select('#sort-select', 'name-asc'); options.sort = 'name-asc';
    await ui.select('#topic-match-select', 'any'); options.topicMatch = 'any';

    stage('group concurrency, state preservation and retry');
    await selectTopics(['Array', 'Hash Table', 'Linked List', 'String']);
    await ui.click('#problem-view-topics'); const counts = await assertGroups();
    assert.ok(counts.total > 50 && counts.topicGroups.some(item => item.topic === 'Array' && item.total > 50));
    await ui.mutate('__problemTopicsAudit.calls=[];__problemTopicsAudit.maxConcurrent=0;__problemTopicsAudit.holdAll=true;');
    await ui.click('#expand-topic-groups');
    await expectRead(ui, '__problemTopicsAudit.pending.length', 3);
    assert.equal(await ui.read('__problemTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic")).length'), 3);
    assert.equal(await ui.read('__problemTopicsAudit.maxConcurrent'), 3);
    await ui.mutate('__problemTopicsAudit.holdAll=false;for(const entry of __problemTopicsAudit.pending.slice())entry.release();');
    for (const topic of options.topics) await assertGroupRows(topic);
    const expansionCalls = await ui.read('__problemTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic"))');
    assert.equal(expansionCalls.length, 4); assert.equal(new Set(expansionCalls.map(call => call.groupTopic)).size, 4);
    assert.ok(expansionCalls.every(call => call.offset === 0 && call.limit === 20));
    assert.ok((await ui.read('__problemTopicsAudit.maxConcurrent')) <= 3);
    await ui.mutate("globalThis.__retainedTopicRows=Array.from(document.querySelectorAll('#topic-groups .topic-group-results > .question-row'));");
    await ui.click('#collapse-topic-groups');
    await expectRead(ui, "Array.from(document.querySelectorAll('#topic-groups .topic-group-toggle')).every(node=>node.getAttribute('aria-expanded')==='false')", true);
    assert.equal(await ui.read('__retainedTopicRows.every(node=>node.isConnected)'), true);
    await toggleGroup('Array', true); await assertGroupRows('Array');
    assert.equal(await ui.read('__problemTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic")).length'), 4, 'Reopening loaded groups must not refetch or duplicate rows.');
    await ui.mutate("__problemTopicsAudit.fail={groupTopic:'Array',offset:20};");
    await ui.click(`${group('Array')} .topic-group-load-more`);
    await expectRead(ui, visible(`${group('Array')} .topic-group-retry`), true);
    await assertGroupRows('Array');
    assert.match(await ui.read(text(group('Array'))), /Injected group page failure/);
    await ui.click(`${group('Array')} .topic-group-retry`); await assertGroupRows('Array', 40);
    await ui.mutate("__problemTopicsAudit.hold={groupTopic:'Array',offset:40};");
    await ui.click(`${group('Array')} .topic-group-load-more`);
    await expectRead(ui, '__problemTopicsAudit.pending.length', 1);
    await ui.select('#problem-difficulty-select', 'Easy'); options.difficulty = 'Easy';
    await assertGroups();
    await ui.mutate('for(const entry of __problemTopicsAudit.pending.slice())entry.release();');
    await expectRead(ui, '__problemTopicsAudit.pending.length', 0);
    await toggleGroup('Array', true); await assertGroupRows('Array');
    report.groupCounts = counts.topicGroups.filter(item => options.topics.includes(item.topic));
    report.maxConcurrent = await ui.read('__problemTopicsAudit.maxConcurrent');

    stage('navigation restoration and untagged problems');
    const first = `${group('Array')} .topic-group-results > .question-row:first-child button[data-action=problem]`;
    await ui.click(first); await expectRead(ui, visible('#detail-view'), true); await expectRead(ui, visible('#problem-filters'), false);
    await ui.click('#detail-back'); await expectRead(ui, visible('#problem-filters'), true);
    await expectRead(ui, selectedTopics, options.topics.slice().sort()); await assertGroups();
    await ui.click('#mode-companies'); await expectRead(ui, visible('#problem-filters'), false); await expectRead(ui, visible('#topic-groups'), false);
    await ui.click('#mode-problems'); await expectRead(ui, visible('#problem-filters'), true);
    await expectRead(ui, value('#problem-difficulty-select'), 'Easy'); await expectRead(ui, selectedTopics, options.topics.slice().sort());
    await assertGroups();
    await selectTopics([]); await ui.select('#problem-difficulty-select', ''); options.difficulty = '';
    const unfilteredGroups = await assertGroups();
    const untagged = unfilteredGroups.topicGroups.find(item => item.topic === null);
    assert.ok(untagged?.total > 0);
    await toggleGroup(null, true); await assertGroupRows(null);
    assert.ok((await ui.read('__problemTopicsAudit.calls')).some(call => Object.hasOwn(call, 'groupTopic') && call.groupTopic === null));
    assert.equal(source({ groupTopic: null, limit: 100 }).problems.every(row => row.topics.length === 0), true);
    report.noTopicsTotal = untagged.total;

    stage('unavailable versus empty results and keyboard');
    await ui.mutate('__problemTopicsAudit.unavailable=true;');
    await ui.fill('#global-search', 'unavailable-audit'); options.query = 'unavailable-audit';
    await expectRead(ui, "document.querySelector('#topic-picker-trigger').disabled", true);
    assert.equal(await ui.read("document.querySelector('#problem-difficulty-select-trigger').disabled"), true);
    assert.match(await ui.read(text('#search-message')), /not available|being updated/i);
    await ui.mutate('__problemTopicsAudit.unavailable=false;');
    await ui.fill('#global-search', ''); options.query = '';
    await expectRead(ui, "document.querySelector('#topic-picker-trigger').disabled", false);
    await assertGroups();
    await preparePicker(); await ui.activateWithKeyboard('#topic-picker-trigger');
    await expectRead(ui, visible('#topic-picker-menu'), true);
    assert.equal(await ui.read("document.querySelector('#topic-picker-menu').getAttribute('role')"), 'dialog');
    assert.equal(await ui.read("document.querySelector('#topic-picker-trigger').getAttribute('aria-expanded')"), 'true');
    await ui.fill('#topic-picker-search', 'Linked List');
    const checkbox = '#topic-picker-options input[data-topic="Linked List"]';
    if (ui.keyboard.startsWith('Native Chromium')) await ui.press(checkbox, 'Space'); else await ui.click(checkbox);
    await expectRead(ui, `document.querySelector(${JSON.stringify(checkbox)}).checked`, true);
    await expectRead(ui, selectedTopics, ['Linked List'], 'Checkbox changes apply immediately.');
    await ui.press('#topic-picker-search', 'Escape');
    await expectRead(ui, visible('#topic-picker-menu'), false);
    assert.equal(await ui.read("document.activeElement===document.querySelector('#topic-picker-trigger')"), true);
    await expectRead(ui, selectedTopics, ['Linked List'], 'Escape closes the picker without reverting applied changes.');
    await preparePicker(); await ui.activateWithKeyboard('#topic-picker-trigger');
    await ui.fill('#topic-picker-search', 'Linked List');
    await expectRead(ui, `document.querySelector(${JSON.stringify(checkbox)}).checked`, true);
    await ui.press(checkbox, 'Escape');
    await expectRead(ui, visible('#topic-picker-menu'), false);
    options.topics = ['Linked List']; await assertGroups();

    stage('light, dark and narrow layout');
    await selectTopics(['Array', 'Linked List']); await ui.select('#problem-difficulty-select', 'Medium'); options.difficulty = 'Medium';
    await assertGroups();
    if (ui.setViewport && ui.setColorScheme && ui.screenshot) {
      for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
        await ui.setViewport({ width, height: 900 }); await ui.setColorScheme(theme);
        await ui.mutate('scrollTo(0,0);');
        const overflow = await ui.read('({document:document.documentElement.scrollWidth,viewport:innerWidth})');
        assert.ok(overflow.document <= overflow.viewport);
        const filename = path.join(output, `${browserName}-problem-topics-${theme}-${width}.png`);
        await ui.screenshot(filename, { fullPage: false }); report.screenshots.push(filename);
        await preparePicker(); await ui.click('#topic-picker-trigger');
        const menu = await ui.read("(()=>{const r=document.querySelector('#topic-picker-menu').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
        assert.ok(menu.left >= 0 && menu.right <= menu.width + 1 && menu.top >= 0 && menu.bottom <= menu.height + 1);
        if (width === 375) {
          const picker = path.join(output, `${browserName}-problem-topic-picker-${theme}-375.png`);
          await ui.screenshot(picker, { fullPage: false }); report.screenshots.push(picker);
        }
        await ui.press('#topic-picker-search', 'Escape');
      }
    }
    report.checks.push('Flat50 paging and topic OR/AND with difficulty/query/sort/window match the bundled source; catalog and group counts come from complete results.',
      'All-match problems legitimately appear in both topic groups; each group has unique rows and exposes correct metadata, including untagged problems.',
      'Expand all is bounded to3 concurrent requests of20 rows; collapse/reopen preserves existing nodes and avoids duplicate fetches.',
      'Group paging retry preserves rows; a delayed old-filter response cannot append into the new selection.',
      'Problem Back and Companies navigation preserve Problems filters; unavailable windows disable filters while valid no-match searches keep them usable.',
      'Topic picker keyboard/dialog semantics and available theme/viewport checks pass using the reported browser input mechanism.');
    return report;
  } finally {
    await ui.mutate('globalThis.__problemTopicsAudit?.restore();delete globalThis.__retainedTopicRows;');
  }
}
