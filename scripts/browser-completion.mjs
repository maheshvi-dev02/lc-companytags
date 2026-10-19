import assert from 'node:assert/strict';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = selector => `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`;
const text = selector => `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`;
async function expectRead(ui, expression, expected, label) {
  let actual;
  for (let attempt = 0; attempt < 200; attempt++) {
    actual = await ui.read(expression);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await pause(50);
  }
  assert.deepEqual(actual, expected, label || expression);
}

// Intercepts only the isolated browser's synthetic LeetCode origin. Responses
// pass through the packaged content bridge, background service and Explorer.
// Neither extension storage nor completion icons are seeded by this fixture.
export function createCompletionFixture({ html, background = 'allow' }) {
  const fixture = {
    state: { account: 'alpha', statuses: new Map(), failure: null, holdNext: false, blockDocument: false },
    calls: [], pending: [], pendingDocuments: [], forbidden: [],
    setAccount(account) { this.state.account = account; },
    setStatus(slug, status, account = this.state.account) { this.state.statuses.set(`${account}:${slug}`, status); },
    status(slug, account = this.state.account) { return this.state.statuses.has(`${account}:${slug}`) ? this.state.statuses.get(`${account}:${slug}`) : null; },
    completed(slug) { return Boolean(this.state.account) && String(this.status(slug)).toLowerCase() === 'ac'; },
    releaseAll() { for (const entry of [...this.pending, ...this.pendingDocuments]) entry.release(); },
  };
  fixture.route = async route => {
    const request = route.request(), url = new URL(request.url());
    if (background === 'block' && request.serviceWorker?.()) { await route.abort(); return; }
    if (request.isNavigationRequest() && request.method() === 'GET') {
      const body = fixture.state.blockDocument ? html.replace(/<head([^>]*)>/i, '<head$1><script src="/completion-fixture-loader.js"></script>') : html;
      await route.fulfill({ contentType: 'text/html', body }); return;
    }
    if (url.pathname === '/completion-fixture-loader.js' && request.method() === 'GET') {
      await new Promise(resolve => {
        const entry = { release: () => { fixture.pendingDocuments.splice(fixture.pendingDocuments.indexOf(entry), 1); resolve(); } };
        fixture.pendingDocuments.push(entry);
      });
      await route.fulfill({ contentType: 'application/javascript', body: 'void 0;' }).catch(() => {}); return;
    }
    if (!/^\/graphql\/?$/.test(url.pathname) || request.method() !== 'POST') {
      if (request.method() !== 'GET') fixture.forbidden.push({ url: url.pathname, method: request.method() });
      await route.abort(); return;
    }
    let body;
    try { body = request.postDataJSON(); } catch { body = null; }
    const query = body?.query;
    const aliases = typeof query === 'string' ? [...query.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*question\s*\(\s*titleSlug\s*:\s*\$(\w+)\s*\)/g)] : [];
    const variables = body?.variables || {};
    const catalog = body?.operationName === 'CompanyLensCompletionCatalog' && typeof query === 'string' &&
      query.replace(/\s+/g, ' ').trim() === 'query CompanyLensCompletionCatalog { userStatus { isSignedIn username } allQuestions { titleSlug status } }' && Object.keys(variables).length === 0;
    const valid = catalog || typeof query === 'string' && /\buserStatus\b/.test(query) && !/\b(?:allQuestions|mutation|subscription|__schema|__type)\b/.test(query) &&
      Object.keys(variables).every(key => /^s\d+$/.test(key) && typeof variables[key] === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(variables[key])) &&
      aliases.every(match => Object.hasOwn(variables, match[2])) && aliases.length <= 25;
    if (!valid) {
      fixture.forbidden.push({ url: url.pathname, method: request.method(), query, variables });
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Unapproved fixture operation' }] }) }); return;
    }
    const account = fixture.state.account, failure = fixture.state.failure;
    const slugs = aliases.map(match => variables[match[2]]);
    const call = { account, slugs, catalog, site: url.origin, variables, query, method: request.method(), failure };
    fixture.calls.push(call);
    const data = { userStatus: { isSignedIn: Boolean(account), username: account } };
    if (catalog) data.allQuestions = [...fixture.state.statuses].filter(([key]) => key.startsWith(`${account}:`))
      .filter(([, status]) => status !== '__missing__').map(([key, status]) => ({ titleSlug: key.slice(String(account).length + 1), status }));
    for (const match of aliases) {
      const slug = variables[match[2]], status = fixture.status(slug, account);
      if (status === '__missing__') continue;
      data[match[1]] = { titleSlug: slug, status };
    }
    if (fixture.state.holdNext && (catalog || aliases.length)) {
      fixture.state.holdNext = false;
      await new Promise(resolve => {
        const entry = { call, release: () => { fixture.pending.splice(fixture.pending.indexOf(entry), 1); resolve(); } };
        fixture.pending.push(entry);
      });
    }
    const response = failure === 'http' ? { status: 503, body: { errors: [{ message: 'Fixture temporarily unavailable' }] } }
      : failure === 'graphql' ? { status: 200, body: { errors: [{ message: 'Fixture GraphQL error' }] } }
        : failure === 'schema' ? { status: 200, body: { data: { userStatus: null } } }
          : { status: 200, body: { data } };
    try { await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) }); }
    catch (error) { call.aborted = true; call.abortReason = error.message; }
  };
  return fixture;
}

async function queryCompletion(ui, slugs) {
  await ui.mutate(`globalThis.__completionProbe=undefined;void(globalThis.browser||globalThis.chrome).runtime.sendMessage({type:'LCT_COMPLETION',slugs:${JSON.stringify(slugs)}}).then(value=>{globalThis.__completionProbe=value;},error=>{globalThis.__completionProbe={probeError:error.message};});`);
  await expectRead(ui, 'globalThis.__completionProbe!==undefined', true);
  const result = await ui.read('globalThis.__completionProbe');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

export async function exerciseCompletion(ui, { fixture, data, core, output, browserName = 'chromium',
  openLeetCode, closeLeetCode, refresh = () => ui.mutate("window.dispatchEvent(new Event('focus'));"), onProgress = () => {} }) {
  const report = { checks: [], stages: [], screenshots: [], keyboard: ui.keyboard };
  const stage = name => { report.stages.push(name); onProgress(name); };
  const status = state => expectRead(ui, "document.querySelector('#completion-status')?.dataset.state", state);
  const rows = '#results > .question-row';
  const globalRows = extra => core.searchProblems(data, { window: 'all', limit: 50, ...extra }).problems;
  const companyRows = extra => core.practiceQuestions(data, { company: 'Amazon', window: 'all', limit: 50, ...extra }).questions;
  const allSlugs = Object.keys(data.windows.all.index);
  for (const slug of allSlugs) {
    const hash = [...slug].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 4;
    fixture.setStatus(slug, hash === 0 ? 'ac' : hash === 1 ? 'notac' : hash === 2 ? null : '__missing__', 'alpha');
    fixture.setStatus(slug, hash === 1 ? 'ac' : null, 'beta');
  }
  fixture.setStatus('two-sum', 'AC', 'alpha');
  fixture.setStatus('add-two-numbers', 'notac', 'alpha');
  fixture.setStatus('3sum', null, 'alpha');
  fixture.setStatus('4sum', '__missing__', 'alpha');
  fixture.setStatus('two-sum', null, 'beta'); fixture.setStatus('add-two-numbers', 'ac', 'beta');
  async function assertRows(selector, expected) {
    await expectRead(ui, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.dataset.slug)`, expected.map(row => row.slug));
    await expectRead(ui, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}),node=>node.querySelector('h3')?.textContent)`, expected.map(row => row.title));
    for (const row of expected) if (Object.hasOwn(row, 'rank')) {
      const metadata = await ui.read(`document.querySelector(${JSON.stringify(`${selector}[data-slug=${JSON.stringify(row.slug)}] .question-meta`)})?.textContent||''`);
      assert.ok(metadata.includes(row.rank == null ? 'rank unavailable' : `company rank #${row.rank}`));
      assert.ok(metadata.includes(`score ${row.frequency == null ? 'unavailable' : row.frequency}`));
    }
  }
  async function assertMarks(selector, expectedRows, completed = slug => fixture.completed(slug)) {
    await assertRows(selector, expectedRows);
    const expected = expectedRows.filter(row => completed(row.slug)).map(row => row.slug).sort();
    await expectRead(ui, `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(row=>row.querySelector('.completion-indicator')?.getClientRects().length).map(row=>row.dataset.slug).sort()`, expected);
    const semantics = await ui.read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row=>row.querySelector('.completion-indicator')).filter(node=>node?.getClientRects().length).map(node=>{const r=node.querySelector('svg')?.getBoundingClientRect();return{tag:node.tagName,role:node.getAttribute('role'),label:node.getAttribute('aria-label'),title:node.title,tabIndex:node.tabIndex,width:r?.width,height:r?.height};})`);
    for (const icon of semantics) {
      assert.equal(icon.role, 'img'); assert.equal(icon.label, 'Completed on LeetCode'); assert.equal(icon.title, icon.label);
      assert.notEqual(icon.tag, 'BUTTON'); assert.equal(icon.tabIndex, -1); assert.equal(icon.width, 16); assert.equal(icon.height, 16);
    }
  }
  const noMarks = () => expectRead(ui, "Array.from(document.querySelectorAll('.completion-indicator')).every(node=>node.hidden||getComputedStyle(node).display==='none')", true);
  let contentPage;
  try {
    stage('no-tab and real same-origin completion bridge');
    await assertRows(rows, globalRows()); await status('unavailable');
    await assertMarks(rows, globalRows(), () => false);
    assert.match(await ui.read(text('#completion-status')), /completed status|LeetCode/i);
    contentPage = await openLeetCode('https://leetcode.com/problemset/');
    await refresh(); await status('ready'); await assertMarks(rows, globalRows());
    assert.ok(fixture.calls.length > 0, 'The packaged bridge must make real intercepted same-origin requests.');
    const direct = await queryCompletion(ui, ['two-sum', 'add-two-numbers', '3sum', '4sum']);
    assert.equal(direct.state, 'ready'); assert.equal(direct.site, 'https://leetcode.com');
    assert.equal(direct.completed['two-sum'], true); assert.equal(direct.completed['add-two-numbers'], false);
    assert.equal(direct.completed['3sum'], false); assert.equal(direct.completed['4sum'], null);
    const firstSession = direct.sessionKey; assert.equal(typeof firstSession, 'string');
    await ui.click('#load-more'); await assertMarks(rows, globalRows({ limit: 100 }));

    stage('company and topic rows preserve dataset order and cached Back');
    await ui.click('#mode-companies'); await ui.fill('#global-search', 'Amazon');
    await expectRead(ui, "Boolean(document.querySelector('#results .company-title[data-company=\"Amazon\"]'))", true);
    await ui.click('#results .company-title[data-company="Amazon"]');
    const companySelector = '#detail-results > .question-row';
    await assertMarks(companySelector, companyRows());
    await ui.click('#detail-load-more'); await assertMarks(companySelector, companyRows({ limit: 100 }));
    await ui.click(`${companySelector}:first-child button[data-action=problem]`);
    await expectRead(ui, text('#detail-kind'), 'Problem companies');
    await ui.click('#detail-back'); await assertMarks(companySelector, companyRows({ limit: 100 }));
    await ui.click('#detail-view-topics');
    await expectRead(ui, "Boolean(document.querySelector('#detail-topic-groups .topic-group[data-topic=\"Array\"]'))", true);
    await ui.click('#detail-topic-groups .topic-group[data-topic="Array"] .topic-group-toggle');
    const companyGroup = '#detail-topic-groups .topic-group[data-topic="Array"] .question-row';
    await assertMarks(companyGroup, companyRows({ groupTopic: 'Array', limit: 20 }));
    await ui.click('#detail-topic-groups .topic-group[data-topic="Array"] .topic-group-load-more');
    await assertMarks(companyGroup, companyRows({ groupTopic: 'Array', limit: 40 }));

    stage('collapsed groups probe identity and clear hidden account markers');
    await ui.click('#collapse-detail-topic-groups');
    const beforeIdentity = fixture.calls.length;
    fixture.setAccount(null); await refresh(); await status('signed-out'); await noMarks();
    assert.ok(fixture.calls.slice(beforeIdentity).some(call => call.slugs.length === 0), 'Collapsed groups must still probe account identity.');
    await ui.click('#detail-topic-groups .topic-group[data-topic="Array"] .topic-group-toggle');
    await assertMarks(companyGroup, companyRows({ groupTopic: 'Array', limit: 40 }), () => false);
    fixture.setAccount('beta'); await refresh(); await status('ready');
    await assertMarks(companyGroup, companyRows({ groupTopic: 'Array', limit: 40 }));
    const secondSession = (await queryCompletion(ui, [])).sessionKey; assert.notEqual(secondSession, firstSession);
    await ui.click('#mode-problems'); await assertMarks(rows, globalRows());
    await ui.click('#problem-view-topics');
    await expectRead(ui, "Boolean(document.querySelector('#topic-groups .topic-group[data-topic=\"Array\"]'))", true);
    await ui.click('#topic-groups .topic-group[data-topic="Array"] .topic-group-toggle');
    await assertMarks('#topic-groups .topic-group[data-topic="Array"] .question-row', globalRows({ groupTopic: 'Array', limit: 20 }));
    await ui.click('#problem-view-list'); await assertMarks(rows, globalRows());

    stage('read-only navigation updates and superseded account responses');
    await ui.fill('#global-search', 'two sum'); await assertMarks(rows, globalRows({ query: 'two sum' }));
    fixture.setStatus('two-sum', 'ac', 'beta');
    await contentPage.goto('https://leetcode.com/problems/two-sum/submissions/fixture/');
    await refresh(); await status('ready'); await assertMarks(rows, globalRows({ query: 'two sum' }));
    assert.ok(await ui.read("Boolean(document.querySelector('#results [data-slug=\"two-sum\"] .completion-indicator')?.getClientRects().length)"));
    fixture.setAccount('alpha'); fixture.state.holdNext = true; await refresh();
    for (let attempt = 0; attempt < 200 && !fixture.pending.length; attempt++) await pause(50);
    assert.equal(fixture.pending.length, 1, 'A real question-status response must be delayed for the account-race test.');
    fixture.setStatus('two-sum', null, 'beta'); fixture.setAccount('beta');
    await refresh(); await noMarks();
    await ui.mutate("globalThis.__completionPaints=[];globalThis.__completionObserver=new MutationObserver(()=>{const marks=Array.from(document.querySelectorAll('#results .question-row')).filter(row=>row.querySelector('.completion-indicator')?.getClientRects().length).map(row=>row.dataset.slug);globalThis.__completionPaints.push(marks);});__completionObserver.observe(document.querySelector('#results'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','style']});");
    fixture.releaseAll(); await status('ready'); await assertMarks(rows, globalRows({ query: 'two sum' }));
    assert.equal(await ui.read("__completionPaints.some(slugs=>slugs.includes('two-sum'))"), false, 'Late alpha completion must never repaint after beta refresh supersedes it.');
    await ui.mutate('__completionObserver.disconnect();');

    stage('progress failures never block dataset rows and recover');
    for (const failure of ['http', 'graphql', 'schema']) {
      fixture.state.failure = failure; await refresh(); await status('unavailable'); await noMarks();
      await assertRows(rows, globalRows({ query: 'two sum' }));
      assert.match(await ui.read(text('#completion-status')), /could not check completed status.*refresh your LeetCode tab/i);
    }
    fixture.state.failure = null; await refresh(); await status('ready'); await assertMarks(rows, globalRows({ query: 'two sum' }));
    await ui.fill('#global-search', 'add two numbers'); await assertMarks(rows, globalRows({ query: 'add two numbers' }));
    if (ui.setViewport && ui.setColorScheme && ui.screenshot) {
      for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
        await ui.setViewport({ width, height: 900 }); await ui.setColorScheme(theme);
        await ui.mutate("document.querySelector('#search-view').scrollIntoView({block:'start'});");
        const size = await ui.read('({width:innerWidth,scroll:document.documentElement.scrollWidth})'); assert.ok(size.scroll <= size.width);
        const screenshot = path.join(output, `${browserName}-completion-${theme}-${width}.png`);
        await ui.screenshot(screenshot, { fullPage: false }); report.screenshots.push(screenshot);
        if (width === 1280 && theme === 'dark') {
          const bounds = await ui.read("(()=>{const r=document.querySelector('#results').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()");
          const preview = path.join(output, `${browserName}-completion-preview.png`);
          await ui.screenshot(preview, { fullPage: false, clip: bounds }); report.screenshots.push(preview);
        }
      }
    }
    await closeLeetCode(); await refresh(); await status('unavailable'); await noMarks();
    await assertRows(rows, globalRows({ query: 'add two numbers' }));
    fixture.state.blockDocument = true;
    contentPage = await openLeetCode('https://leetcode.com/problemset/?bridge=pending', { waitUntil: 'commit' });
    for (let attempt = 0; attempt < 200 && !fixture.pendingDocuments.length; attempt++) await pause(50);
    assert.equal(fixture.pendingDocuments.length, 1);
    await refresh(); await status('unavailable'); await noMarks();
    await assertRows(rows, globalRows({ query: 'add two numbers' }));
    fixture.state.blockDocument = false; fixture.releaseAll();
    await contentPage.waitForLoadState('load'); await refresh(); await status('ready');
    await assertMarks(rows, globalRows({ query: 'add two numbers' }));
    assert.deepEqual(fixture.forbidden, []);
    assert.ok(fixture.calls.every(call => call.method === 'POST' && call.slugs.length <= 25 && call.site === 'https://leetcode.com'));
    report.requestCount = fixture.calls.length;
    report.checks.push('Actual same-origin read-only GraphQL bridge marks accepted statuses only; attempted, unattempted and missing records stay unmarked.',
      'Global/company flat and grouped rows preserve titles, order, ranks and scores through paging and Back.',
      'Collapsed groups probe identity; logout clears cached hidden marks and account switching uses a different session.',
      'Navigation refresh shows newly accepted work; superseded delayed account responses never repaint old completion marks.',
      'HTTP, GraphQL and schema failures clear progress without blocking company data; no-tab and not-yet-loaded bridge hints recover correctly.',
      'Informational icons are16px and accessible; available desktop/narrow light/dark layout checks pass.');
    return report;
  } finally {
    fixture.releaseAll();
    await ui.mutate('globalThis.__completionObserver?.disconnect();delete globalThis.__completionProbe;').catch(() => {});
  }
}
