import assert from 'node:assert/strict';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = selector => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
const text = selector => `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`;
const value = selector => `document.querySelector(${JSON.stringify(selector)})?.value`;
const group = topic => `#detail-topic-groups .topic-group[data-topic=${JSON.stringify(topic ?? '')}]`;
async function expectRead(ui, expression, expected, message) {
  let actual;
  for (let attempt = 0; attempt < 160; attempt++) {
    actual = await ui.read(expression);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await pause(50);
  }
  assert.deepEqual(actual, expected, message || expression);
}

// Start on the real legacy route ?mode=companies&company=DE%20Shaw&window=all
// &topic=Array&difficulty=&sort=frequency-desc. The route must initialize the new
// picker before the remaining checks exercise its visible controls.
export async function exerciseCompanyTopics(ui, { data, core, output, browserName = 'chromium', onProgress = () => {} }) {
  const report = { keyboard: ui.keyboard, stages: [], checks: [], screenshots: [] };
  const options = { company: 'DE Shaw', window: 'all', difficulty: '', query: '', topics: ['Array'], topicMatch: 'any', sort: 'frequency-desc' };
  const source = extra => core.practiceQuestions(data, { ...options, limit: 50, ...extra });
  const selected = "Array.from(document.querySelectorAll('#detail-topic-picker-selected button[data-topic]'),node=>node.dataset.topic).sort()";
  const stage = name => { report.stages.push(name); onProgress(name); };
  async function preparePicker() {
    await ui.mutate("document.querySelector('#detail-topic-picker-trigger').scrollIntoView({block:'nearest'});");
    await pause(60);
  }
  async function selectTopics(topics) {
    if (JSON.stringify(await ui.read(selected)) === JSON.stringify(topics.slice().sort())) { options.topics = topics.slice(); return; }
    await preparePicker(); await ui.click('#detail-topic-picker-trigger');
    await ui.click('#topic-picker-reset');
    for (const topic of topics) {
      await ui.fill('#topic-picker-search', topic);
      const selector = `#topic-picker-options input[data-topic=${JSON.stringify(topic)}]`;
      await expectRead(ui, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, true);
      await ui.click(selector);
    }
    await ui.press('#topic-picker-search', 'Escape');
    await expectRead(ui, visible('#topic-picker-menu'), false);
    options.topics = topics.slice(); await expectRead(ui, selected, topics.slice().sort());
  }
  async function assertRows(selector, expected) {
    await expectRead(ui, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.dataset.slug)`, expected.map(row => row.slug));
    const rows = await ui.read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>({slug:node.dataset.slug,title:node.querySelector('.question-title')?.textContent,
      acceptance:node.querySelector('.acceptance-rate')?.textContent,meta:node.querySelector('.question-meta')?.textContent,
      topics:node.querySelector('.question-topics')?.textContent||'',href:node.querySelector('.leetcode-link')?.href}))`);
    const records = data.files[options.company + '/' + core.WINDOW_FILES[options.window]].records;
    for (const [index, row] of rows.entries()) {
      const wanted = expected[index], original = records.find(record => record.slug === row.slug);
      assert.equal(row.title, wanted.title); assert.equal(row.href, wanted.url);
      assert.equal(row.topics, wanted.topics.join(' · '), 'Company rows must expose this company file’s topics.');
      assert.equal(wanted.frequency, original.frequency); assert.equal(wanted.rank, original.rank);
      assert.ok(row.meta.includes(wanted.difficulty || 'Difficulty unavailable'));
      assert.ok(row.meta.includes(`score ${original.frequency == null ? 'unavailable' : original.frequency}`));
      assert.ok(row.meta.includes(original.rank == null ? 'rank unavailable' : `company rank #${original.rank}`));
      assert.ok(row.meta.includes(`${wanted.companyCount.toLocaleString('en')} ${wanted.companyCount === 1 ? 'company' : 'companies'} in this window`));
      const rate = core.formatAcceptanceRate(wanted.acceptanceRate);
      assert.equal(row.acceptance, rate === null ? 'Acceptance unavailable' : `Acceptance ${rate}`);
    }
    assert.equal(new Set(rows.map(row => row.slug)).size, rows.length);
  }
  async function assertFlat(limit = 50) {
    const expected = source({ limit });
    await assertRows('#detail-results > .question-row', expected.questions);
    await expectRead(ui, "document.querySelector('#detail-results').getAttribute('aria-busy')", 'false');
    assert.ok((await ui.read(text('#detail-summary'))).includes(expected.total.toLocaleString('en')));
    return expected;
  }
  async function assertCatalog() {
    await preparePicker(); await ui.click('#detail-topic-picker-trigger'); await ui.fill('#topic-picker-search', '');
    // A selection from a previous window stays available for removal even when
    // it is absent from the current company/window catalog.
    await expectRead(ui, "Array.from(document.querySelectorAll('#topic-picker-options input[data-topic]'),node=>node.dataset.topic).sort()", [...new Set([...source().topics, ...options.topics])].sort());
    const companyTopics = [...new Set(data.files[options.company + '/' + core.WINDOW_FILES[options.window]].records.flatMap(row => row.topics))].sort();
    assert.deepEqual(source().topics.slice().sort(), companyTopics, 'The catalog must be scoped to the selected company and window.');
    await ui.press('#topic-picker-search', 'Escape');
  }
  async function assertGroups() {
    const expected = source();
    const wanted = options.topics.length ? options.topics.map(topic => ({ topic, total: expected.topicGroups.find(item => item.topic?.toLowerCase() === topic.toLowerCase())?.total || 0 })) : expected.topicGroups;
    const sorted = wanted.slice().sort((a, b) => String(a.topic).localeCompare(String(b.topic), 'en'));
    await expectRead(ui, "Array.from(document.querySelectorAll('#detail-topic-groups .topic-group'),node=>({topic:node.dataset.topic||null,total:Number(node.querySelector('.topic-group-count').textContent.replace(/[^0-9]/g,''))})).sort((a,b)=>String(a.topic).localeCompare(String(b.topic),'en'))", sorted);
    assert.ok((await ui.read(text('#detail-summary'))).includes(expected.total.toLocaleString('en')));
    return expected;
  }
  async function assertGroupRows(topic, limit = 20) {
    const expected = source({ groupTopic: topic, limit });
    await assertRows(`${group(topic)} .topic-group-results > .question-row`, expected.questions);
    return expected;
  }
  async function expand(topic) {
    const selector = `${group(topic)} .topic-group-toggle`;
    if (await ui.read(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`) !== 'true') await ui.click(selector);
    await expectRead(ui, `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`, 'true');
    return assertGroupRows(topic);
  }
  await expectRead(ui, text('#detail-title'), 'DE Shaw');
  await expectRead(ui, selected, ['Array']);
  await ui.mutate(`const api=globalThis.browser||globalThis.chrome;const send=api.runtime.sendMessage.bind(api.runtime);
    const audit=globalThis.__companyTopicsAudit={calls:[],inflight:0,maxConcurrent:0,pending:[],holdAll:false,hold:null,fail:null,unavailable:false};
    const match=(rule,message)=>rule&&Object.entries(rule).every(([key,val])=>message[key]===val);
    api.runtime.sendMessage=async(message,...args)=>{
      if(message?.type!=='LCT_PRACTICE')return send(message,...args);
      audit.calls.push({...message});const grouped=Object.hasOwn(message,'groupTopic');
      if(grouped){audit.inflight++;audit.maxConcurrent=Math.max(audit.maxConcurrent,audit.inflight);}
      try{
        if(match(audit.fail,message)){audit.fail=null;return{ok:false,error:'Injected company group failure. Try again.'};}
        const hold=grouped&&(audit.holdAll||match(audit.hold,message));if(hold&&audit.hold)audit.hold=null;
        const response=await send(message,...args);
        if(hold)await new Promise(resolve=>{const entry={message,release:()=>{audit.pending.splice(audit.pending.indexOf(entry),1);resolve();}};audit.pending.push(entry);});
        if(audit.unavailable&&!grouped)return{...response,questions:[],total:0,topics:[],topicGroups:[],hasMore:false,available:false,windowAvailable:false};
        return response;
      }finally{if(grouped)audit.inflight--;}
    };audit.restore=()=>{audit.holdAll=false;for(const entry of audit.pending.slice())entry.release();api.runtime.sendMessage=send;};`);
  try {
    stage('legacy company route and complete company filters');
    await assertFlat(); await assertCatalog();
    await selectTopics([]); const baseline = await assertFlat();
    assert.ok(baseline.total > 100); report.companyTotal = baseline.total;
    await ui.click('#detail-load-more'); await assertFlat(100);
    await selectTopics(['Array', 'Linked List']);
    await ui.select('#difficulty-select', 'Medium'); options.difficulty = 'Medium';
    const any = await assertFlat();
    await ui.select('#detail-topic-match-select', 'all'); options.topicMatch = 'all';
    const all = await assertFlat(); assert.ok(any.total > all.total);
    assert.equal(all.total, 0); assert.equal(await ui.read("document.querySelector('#detail-topic-picker-trigger').disabled"), false);
    assert.match(await ui.read(text('#detail-message')), /no .*match/i);
    await assertCatalog(); report.anyTotal = any.total; report.allTotal = all.total;
    await ui.select('#detail-topic-match-select', 'any'); options.topicMatch = 'any';
    await ui.select('#detail-sort-select', 'name-desc'); options.sort = 'name-desc';
    await ui.fill('#question-search', 'sum'); options.query = 'sum';
    await ui.select('#window-select', '3m'); options.window = '3m';
    await assertFlat(); await assertCatalog();
    await ui.fill('#question-search', ''); options.query = '';
    await ui.select('#window-select', 'all'); options.window = 'all';
    await ui.select('#detail-sort-select', 'frequency-desc'); options.sort = 'frequency-desc';

    stage('company group concurrency, paging, retry and stale filters');
    await selectTopics(['Array', 'Hash Table', 'Linked List', 'String']);
    await ui.click('#detail-view-topics'); const grouped = await assertGroups();
    await expectRead(ui, "Array.from(document.querySelectorAll('#detail-topic-groups .topic-group-toggle')).every(node=>node.getAttribute('aria-expanded')==='false')", true);
    await ui.mutate('__companyTopicsAudit.calls=[];__companyTopicsAudit.maxConcurrent=0;__companyTopicsAudit.holdAll=true;');
    await ui.click('#expand-detail-topic-groups');
    await expectRead(ui, '__companyTopicsAudit.pending.length', 3);
    assert.equal(await ui.read('__companyTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic")).length'), 3);
    await ui.mutate('__companyTopicsAudit.holdAll=false;for(const entry of __companyTopicsAudit.pending.slice())entry.release();');
    for (const topic of options.topics) await assertGroupRows(topic);
    const calls = await ui.read('__companyTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic"))');
    assert.equal(calls.length, 4); assert.equal(new Set(calls.map(call => call.groupTopic)).size, 4);
    assert.ok(calls.every(call => call.limit === 20 && call.offset === 0));
    assert.equal(await ui.read('__companyTopicsAudit.maxConcurrent'), 3);
    await ui.mutate("globalThis.__retainedCompanyRows=Array.from(document.querySelectorAll('#detail-topic-groups .question-row'));");
    await ui.click('#collapse-detail-topic-groups');
    await expectRead(ui, "Array.from(document.querySelectorAll('#detail-topic-groups .topic-group-toggle')).every(node=>node.getAttribute('aria-expanded')==='false')", true);
    assert.equal(await ui.read('__retainedCompanyRows.every(node=>node.isConnected)'), true);
    await expand('Array');
    assert.equal(await ui.read('__companyTopicsAudit.calls.filter(call=>Object.hasOwn(call,"groupTopic")).length'), 4);
    if (ui.setViewport && ui.setColorScheme && ui.screenshot) {
      const previousViewport = ui.viewport();
      await ui.setViewport({ width: 1280, height: 1100 }); await ui.setColorScheme('dark');
      await ui.mutate("document.querySelector('#detail-view').scrollIntoView({block:'start'});"); await pause(60);
      const bounds = await ui.read("(()=>{const r=document.querySelector('#detail-view').getBoundingClientRect();return{x:r.x,y:Math.max(0,r.y),width:r.width,height:Math.min(1000,innerHeight-Math.max(0,r.y))};})()");
      const preview = path.join(output, `${browserName}-company-topics-de-shaw-preview.png`);
      await ui.screenshot(preview, { fullPage: false, clip: bounds }); report.screenshots.push(preview);
      await ui.setViewport(previousViewport); await ui.setColorScheme('light');
    }
    await ui.mutate("__companyTopicsAudit.fail={groupTopic:'Array',offset:20};");
    await ui.click(`${group('Array')} .topic-group-load-more`);
    await expectRead(ui, visible(`${group('Array')} .topic-group-retry`), true); await assertGroupRows('Array');
    assert.match(await ui.read(text(group('Array'))), /Injected company group failure/);
    await ui.click(`${group('Array')} .topic-group-retry`); await assertGroupRows('Array', 40);
    await ui.mutate("__companyTopicsAudit.hold={groupTopic:'Array',offset:40};");
    await ui.click(`${group('Array')} .topic-group-load-more`); await expectRead(ui, '__companyTopicsAudit.pending.length', 1);
    await ui.select('#difficulty-select', 'Easy'); options.difficulty = 'Easy'; await assertGroups();
    await ui.mutate('for(const entry of __companyTopicsAudit.pending.slice())entry.release();');
    await expectRead(ui, '__companyTopicsAudit.pending.length', 0); await expand('Array');
    report.groupCounts = grouped.topicGroups.filter(item => options.topics.includes(item.topic)); report.maxConcurrent = 3;

    stage('nested Back restoration and company isolation');
    await ui.click(`${group('Array')} .question-row:first-child button[data-action=problem]`);
    await expectRead(ui, text('#detail-kind'), 'Problem companies'); await expectRead(ui, visible('#detail-filters'), false);
    await ui.click('#detail-back'); await expectRead(ui, text('#detail-title'), 'DE Shaw');
    await expectRead(ui, selected, options.topics.slice().sort());
    await expectRead(ui, value('#difficulty-select'), 'Easy');
    await expectRead(ui, "document.querySelector('#detail-view-topics').getAttribute('aria-pressed')", 'true');
    await assertGroups(); await assertGroupRows('Array');
    await ui.click('#detail-back'); await expectRead(ui, visible('#search-view'), true);
    await ui.fill('#global-search', 'Google');
    await expectRead(ui, "Boolean(document.querySelector('#results .company-title[data-company=\"Google\"]'))", true);
    await ui.click('#results .company-title[data-company="Google"]'); options.company = 'Google';
    options.topics = []; options.difficulty = ''; options.topicMatch = 'any';
    await expectRead(ui, text('#detail-title'), 'Google'); await expectRead(ui, selected, []);
    await expectRead(ui, value('#difficulty-select'), '');
    await expectRead(ui, value('#detail-topic-match-select'), 'any');
    await expectRead(ui, "document.querySelector('#detail-view-list').getAttribute('aria-pressed')", 'true');
    await assertFlat(); await assertCatalog();
    await selectTopics(['Array', 'Linked List']); await ui.select('#difficulty-select', 'Medium'); options.difficulty = 'Medium';
    const googleAny = await assertFlat();
    await ui.select('#detail-topic-match-select', 'all'); options.topicMatch = 'all'; const googleAll = await assertFlat();
    assert.ok(googleAny.total > googleAll.total && googleAll.total > 0);
    await ui.click('#detail-view-topics'); await assertGroups();
    await expand('Array'); await expand('Linked List');
    assert.deepEqual(source({ groupTopic: 'Array', limit: 100 }).questions.map(row => row.slug), source({ groupTopic: 'Linked List', limit: 100 }).questions.map(row => row.slug));
    report.secondCompany = { company: options.company, anyTotal: googleAny.total, allTotal: googleAll.total };
    await selectTopics([]); await ui.select('#difficulty-select', ''); options.difficulty = '';
    const unfiltered = await assertGroups(); const untagged = unfiltered.topicGroups.find(item => item.topic === null);
    assert.ok(untagged.total > 0); await expand(null); report.noTopicsTotal = untagged.total;
    assert.ok((await ui.read('__companyTopicsAudit.calls')).some(call => Object.hasOwn(call, 'groupTopic') && call.groupTopic === null));

    stage('unavailable state, keyboard draft and responsive company rows');
    await ui.mutate('__companyTopicsAudit.unavailable=true;');
    await ui.fill('#question-search', 'unavailable-audit'); options.query = 'unavailable-audit';
    await expectRead(ui, "document.querySelector('#detail-topic-picker-trigger').disabled", true);
    await ui.mutate('__companyTopicsAudit.unavailable=false;');
    await ui.fill('#question-search', ''); options.query = ''; await assertGroups();
    await expectRead(ui, "document.querySelector('#detail-topic-picker-trigger').disabled", false);
    await preparePicker(); await ui.activateWithKeyboard('#detail-topic-picker-trigger');
    await expectRead(ui, visible('#topic-picker-menu'), true);
    assert.equal(await ui.read("document.querySelector('#topic-picker-menu').getAttribute('role')"), 'dialog');
    await ui.fill('#topic-picker-search', 'Linked List');
    const checkbox = '#topic-picker-options input[data-topic="Linked List"]';
    if (ui.keyboard.startsWith('Native Chromium')) await ui.press(checkbox, 'Space'); else await ui.click(checkbox);
    await expectRead(ui, `document.querySelector(${JSON.stringify(checkbox)}).checked`, true);
    await expectRead(ui, selected, ['Linked List']);
    await ui.press(checkbox, 'Escape'); await expectRead(ui, visible('#topic-picker-menu'), false);
    await expectRead(ui, "document.activeElement===document.querySelector('#detail-topic-picker-trigger')", true);
    await expectRead(ui, selected, ['Linked List']);
    await preparePicker(); await ui.activateWithKeyboard('#detail-topic-picker-trigger');
    await ui.fill('#topic-picker-search', 'Linked List');
    await expectRead(ui, `document.querySelector(${JSON.stringify(checkbox)}).checked`, true);
    await ui.press(checkbox, 'Escape'); options.topics = ['Linked List']; await assertGroups();
    await selectTopics(['Array', 'Linked List']); await ui.select('#detail-topic-match-select', 'any'); options.topicMatch = 'any';
    await ui.select('#difficulty-select', 'Medium'); options.difficulty = 'Medium';
    await assertGroups(); await expand('Linked List');
    if (ui.setViewport && ui.setColorScheme && ui.screenshot) {
      for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
        await ui.setViewport({ width, height: 900 }); await ui.setColorScheme(theme);
        await ui.mutate("document.querySelector('#detail-view').scrollIntoView({block:'start'});");
        const size = await ui.read('({document:document.documentElement.scrollWidth,viewport:innerWidth})');
        assert.ok(size.document <= size.viewport);
        const screenshot = path.join(output, `${browserName}-company-topics-${theme}-${width}.png`);
        await ui.screenshot(screenshot, { fullPage: false }); report.screenshots.push(screenshot);
        await preparePicker(); await ui.click('#detail-topic-picker-trigger');
        const bounds = await ui.read("(()=>{const r=document.querySelector('#topic-picker-menu').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1);
        if (width === 375) { const screenshot = path.join(output, `${browserName}-company-topic-picker-${theme}-375.png`); await ui.screenshot(screenshot, { fullPage: false }); report.screenshots.push(screenshot); }
        await ui.press('#topic-picker-search', 'Escape');
      }
    }
    report.checks.push('Legacy topic route populates the checkbox picker; company/window catalogs and OR/AND filtering match bundled records.',
      'Flat50 paging and grouped20 paging preserve source frequency, rank, difficulty, acceptance and company-scoped topics.',
      'Expand all stays within3 concurrent requests; collapse preserves nodes; retry and delayed old-filter pages do not corrupt rows.',
      'Nested problem Back restores company state; a new company starts with independent filters and supports positive AND matches and untagged questions.',
      'Unavailable and valid empty results remain distinct; immediate checkbox updates, keyboard dismissal and available theme/narrow checks pass.');
    return report;
  } finally { await ui.mutate('globalThis.__companyTopicsAudit?.restore();delete globalThis.__retainedCompanyRows;'); }
}
