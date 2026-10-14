import assert from 'node:assert/strict';
import path from 'node:path';
import { verifyBadges, exerciseBrokenLogo } from './browser-logos.mjs';
import { acceptanceLabel, exerciseAcceptanceControl } from './browser-first-install.mjs';

// Both drivers operate the actual packaged document. Firefox extension-process
// tabs are unavailable to Playwright, so its driver uses Mozilla's DOM console.
export function chromiumExplorerDriver(page) {
  const settleScroll = async locator => {
    await locator.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  return {
    read: (expression) => page.evaluate(expression),
    click: async selector => {
      const locator=page.locator(selector);
      if(await locator.getAttribute('data-select-for')!==null)await settleScroll(locator);
      return locator.click();
    },
    fill: (selector, value) => page.locator(selector).fill(value),
    select: async (selector, value) => {
      const field = page.locator(selector), id = await field.getAttribute('id');
      const trigger = page.locator(`[data-select-for=${JSON.stringify(id)}]`);
      if (!await trigger.count()) return field.selectOption(value);
      // Let the page-scroll dismissal settle before opening the positioned menu.
      await settleScroll(trigger);
      await trigger.click();
      if (await field.evaluate(node => node.multiple)) {
        await page.locator(`#${id}-clear`).click();
        for (const item of (Array.isArray(value) ? value : value.split(',')).filter(Boolean)) await page.locator(`#${id}-options input[data-value=${JSON.stringify(item)}]`).check();
        await page.locator(`#${id}-apply`).click();
      } else await page.locator(`#${id}-menu [role=option][data-value=${JSON.stringify(value)}]`).click();
    },
    press: async (selector,key) => { const locator=page.locator(selector);await settleScroll(locator);return locator.press(key); },
    activateWithKeyboard: async (selector) => { await page.locator(selector).focus(); await page.locator(selector).press('Enter'); },
    mutate: (source) => page.evaluate(source),
    screenshot: (filename, options = {}) => page.screenshot({ path: filename, fullPage: true, animations: 'disabled', ...options }),
    setColorScheme: (colorScheme) => page.emulateMedia({ colorScheme }),
    setViewport: (viewport) => page.setViewportSize(viewport),
    viewport: () => page.viewportSize(),
    reload: () => page.reload(),
    keyboard: 'Native Chromium keyboard events',
  };
}

export function firefoxExplorerDriver(evaluate) {
  const mutate = async (source) => evaluate(`(() => { ${source}; return 'changed'; })()`);
  return {
    read: async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`)),
    click: async (selector) => {
      await mutate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
      await wait(50); return mutate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    fill: (selector, value) => mutate(`const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true }))`),
    select: async (selector, value) => {
      const custom = JSON.parse(await evaluate(`JSON.stringify(Boolean(document.querySelector('[data-select-for="' + document.querySelector(${JSON.stringify(selector)}).id + '"]')))`));
      if (!custom) return mutate(`const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}))`);
      await mutate(`document.querySelector('[data-select-for="'+document.querySelector(${JSON.stringify(selector)}).id+'"]').scrollIntoView({block:'nearest'})`);
      await wait(50);
      await mutate(`document.querySelector('[data-select-for="'+document.querySelector(${JSON.stringify(selector)}).id+'"]').click()`);
      if (JSON.parse(await evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).multiple)`))) {
        await mutate(`const id=document.querySelector(${JSON.stringify(selector)}).id;document.getElementById(id+'-clear').click();const values=${JSON.stringify(value)};for(const input of document.getElementById(id+'-options').querySelectorAll('input'))if((Array.isArray(values)?values:values.split(',')).includes(input.value))input.click();document.getElementById(id+'-apply').click()`);
        return;
      }
      await mutate(`const menu=document.getElementById(document.querySelector(${JSON.stringify(selector)}).id+'-menu');const option=Array.from(menu.querySelectorAll('[role=option]')).find(node=>node.dataset.value===${JSON.stringify(value)});if(!option)throw new Error('Missing visible select option');option.scrollIntoView({block:'nearest'});option.click()`);
    },
    press: (selector, key) => mutate(`const node=document.querySelector(${JSON.stringify(selector)});node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key === 'Space' ? ' ' : key)},bubbles:true,cancelable:true}))`),
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

async function chooseCompanyTopics(ui, topics) {
  await ui.mutate("document.querySelector('#detail-topic-picker-trigger').scrollIntoView({block:'nearest'});");
  await wait(60);
  await ui.click('#detail-topic-picker-trigger');
  await ui.click('#topic-picker-reset');
  for (const topic of topics) {
    await ui.fill('#topic-picker-search', topic);
    await ui.click(`#topic-picker-options input[data-topic=${JSON.stringify(topic)}]`);
  }
  await ui.click('#topic-picker-apply');
  await expectRead(ui, visible('#topic-picker-menu'), false);
  await expectRead(ui, "Array.from(document.querySelectorAll('#detail-topic-picker-selected button[data-topic]'),node=>node.dataset.topic).sort()", topics.slice().sort());
}

async function exerciseCompanyPicker(ui) {
  await ui.mutate("document.querySelector('#detail-topic-picker-trigger').scrollIntoView({block:'nearest'});");
  await wait(60);
  await ui.activateWithKeyboard('#detail-topic-picker-trigger');
  const opened = await ui.read("(()=>{const trigger=document.querySelector('#detail-topic-picker-trigger'),menu=document.querySelector('#topic-picker-menu'),r=menu.getBoundingClientRect();return{role:menu.getAttribute('role'),expanded:trigger.getAttribute('aria-expanded'),controls:trigger.getAttribute('aria-controls'),options:menu.querySelectorAll('input[type=checkbox][data-topic]').length,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
  assert.equal(opened.role, 'dialog'); assert.equal(opened.expanded, 'true'); assert.equal(opened.controls, 'topic-picker-menu'); assert.ok(opened.options > 0);
  assert.ok(opened.left >= 0 && opened.right <= opened.width + 1 && opened.top >= 0 && opened.bottom <= opened.height + 1);
  await ui.press('#topic-picker-search', 'Escape');
  await expectRead(ui, visible('#topic-picker-menu'), false);
  await expectRead(ui, "document.activeElement===document.querySelector('#detail-topic-picker-trigger')", true);
  return { ...opened, keyboard: ui.keyboard };
}


async function exerciseMenu(ui, selector, { output, browserName, capture, commit = false } = {}) {
  const id = selector.slice(1), trigger = `#${id}-trigger`, menu = `#${id}-menu`;
  const before = await ui.read(`document.querySelector(${JSON.stringify(selector)}).value`);
  const state = () => ui.read(`(()=>{const field=document.querySelector(${JSON.stringify(selector)}),button=document.querySelector(${JSON.stringify(trigger)}),menu=document.querySelector(${JSON.stringify(menu)}),active=menu.querySelector('[data-active]'),css=getComputedStyle(menu),r=menu.getBoundingClientRect();return{value:field.value,selectedLabel:field.selectedOptions[0]?.textContent,label:button.querySelector('.select-value').textContent,expanded:button.getAttribute('aria-expanded'),visible:!!menu.getClientRects().length,role:menu.getAttribute('role'),radius:css.borderRadius,background:css.backgroundColor,border:css.borderTopColor,viewport:{width:innerWidth,height:innerHeight},rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},selected:Array.from(menu.querySelectorAll('[aria-selected="true"]'),n=>n.dataset.value),options:Array.from(menu.querySelectorAll('[role=option]'),n=>({value:n.dataset.value,label:n.textContent})),active:active?{value:active.dataset.value,id:active.id,background:getComputedStyle(active).backgroundColor,radius:getComputedStyle(active).borderRadius,top:active.getBoundingClientRect().top,bottom:active.getBoundingClientRect().bottom}:null,descendant:button.getAttribute('aria-activedescendant'),focused:document.activeElement===button};})()`);
  const gray = color => { const rgb = color.match(/[\d.]+/g).slice(0,3).map(Number); assert.equal(rgb[0],rgb[1]);assert.equal(rgb[1],rgb[2]); };
  const closed = async () => {
    await expectRead(ui, visible(menu), false); await expectRead(ui, `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')`, 'false');
  };
  await ui.click(trigger); const opened = await state();
  assert.equal(opened.visible,true);assert.equal(opened.expanded,'true');assert.equal(opened.role,'listbox');assert.equal(opened.focused,true);
  assert.equal(opened.label,opened.selectedLabel);assert.deepEqual(opened.selected,[before]);
  assert.ok(parseFloat(opened.radius)>=8);assert.ok(parseFloat(opened.active.radius)>=4);gray(opened.background);gray(opened.active.background);gray(opened.border);
  assert.equal(opened.descendant,opened.active.id);
  assert.ok(opened.rect.left>=0&&opened.rect.right<=opened.viewport.width+1&&opened.rect.top>=0&&opened.rect.bottom<=opened.viewport.height+1,'Opened dropdown must fit its actual viewport.');
  if(capture&&ui.screenshot)await ui.screenshot(path.join(output,`${browserName}-${capture}.png`),{fullPage:false});
  await ui.press(trigger,'End');let moved=await state();assert.equal(moved.active.value,opened.options.at(-1).value);assert.equal(moved.value,before);
  assert.ok(moved.active.top>=moved.rect.top-1&&moved.active.bottom<=moved.rect.bottom+2,'Keyboard endpoint must scroll into view.');
  await ui.press(trigger,'Home');moved=await state();assert.equal(moved.active.value,opened.options[0].value);
  await ui.press(trigger,'ArrowDown');moved=await state();assert.equal(moved.active.value,opened.options[Math.min(1,opened.options.length-1)].value);
  await ui.press(trigger,'Escape');await closed();assert.equal((await state()).value,before);assert.equal((await state()).focused,true);
  await ui.press(trigger,'Enter');await expectRead(ui,visible(menu),true);await ui.press(trigger,'Tab');await closed();
  if(ui.keyboard.startsWith('Native Chromium'))assert.equal((await state()).focused,false,'Native Tab must leave the trigger without a focus trap.');
  await ui.click(trigger);
  const outside=await ui.read(visible('#detail-view'))?'#detail-title':'#search-heading';
  if(ui.keyboard.startsWith('Native Chromium'))await ui.click(outside);
  else await ui.mutate(`document.querySelector(${JSON.stringify(outside)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`);
  await closed();assert.equal((await state()).value,before);
  if(commit){
    await ui.press(trigger,'Space');await expectRead(ui,visible(menu),true);await ui.press(trigger,'Home');
    const prefix=opened.options.at(-1).label[0].toLowerCase();await ui.press(trigger,prefix);moved=await state();assert.ok(moved.options.find(n=>n.value===moved.active.value).label.toLowerCase().startsWith(prefix));
    await ui.press(trigger,'End');await ui.press(trigger,'Enter');await closed();
    const chosen=await state();assert.equal(chosen.value,opened.options.at(-1).value);assert.equal(chosen.label,chosen.selectedLabel);assert.equal(chosen.focused,true);
    await ui.select(selector,before);await closed();
  }
  return{selector,opened,keyboard:ui.keyboard,commit};
}

async function exerciseSorting(ui, { data, core, output, browserName }) {
  const checks = [], result = {};
  const selected = selector => `document.querySelector(${JSON.stringify(selector)}).value`;
  const problemIds = values('#results [data-action="problem"]', 'data-slug');
  const companyIds = values('#results .company-title', 'data-company');
  const questionIds = values('#detail-results .question-row', 'data-slug');
  const tagIds = values('#detail-results .company-row', 'data-company');
  const globalProblems = options => core.searchProblems(data, { window: 'all', limit: 50, ...options }).problems;
  const globalCompanies = options => core.searchCompanies(data, { window: 'all', limit: 50, ...options }).companies;
  const practice = options => core.practiceQuestions(data, { company: 'Amazon', window: 'all', limit: 50, ...options }).questions;
  const expectRows = async (expression, rows, key) => {
    await expectRead(ui, expression, rows.map(row => row[key]));
    const ids = await ui.read(expression); assert.equal(new Set(ids).size, ids.length);
  };
  const choose = async (selector, sort) => { await ui.select(selector, sort); await expectRead(ui, selected(selector), sort); };
  const options = async (selector, allowed, label) => {
    const actual = await ui.read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),button=document.getElementById(n.id+'-trigger');button.focus();return{tag:n.tagName,label:button.getAttribute('aria-label'),values:Array.from(n.options,o=>o.value),focused:document.activeElement===button,hidden:!n.getClientRects().length,buttonTag:button.tagName,role:button.getAttribute('role'),controls:button.getAttribute('aria-controls')};})()`);
    assert.equal(actual.tag, 'SELECT'); assert.equal(actual.label, label); assert.equal(actual.focused, true); assert.deepEqual(actual.values, allowed);
    assert.equal(actual.hidden,true);assert.equal(actual.buttonTag,'BUTTON');assert.equal(actual.role,'combobox');assert.equal(actual.controls,selector.slice(1)+'-menu');
  };
  const monotonic = (rows, field, direction) => {
    const known = rows.map(row => row[field]).filter(value => Number.isFinite(value));
    assert.ok(known.length > 1);
    for (let index = 1; index < known.length; index++) assert.ok(direction * (known[index] - known[index - 1]) >= 0, `${field} must respect the selected direction.`);
  };
  const verifyPractice = async expected => {
    await expectRows(questionIds, expected, 'slug');
    const metadata = await ui.read(texts('#detail-results .question-meta'));
    for (let index = 0; index < expected.length; index++) {
      const row = expected[index], source = data.files['Amazon/' + core.WINDOW_FILES[currentWindow]].records.find(record => record.slug === row.slug);
      assert.equal(row.rank, source.rank); assert.equal(row.frequency, source.frequency);
      assert.ok(metadata[index].includes(source.rank == null ? 'rank unavailable' : `company rank #${source.rank}`));
      assert.ok(metadata[index].includes(`score ${source.frequency == null ? 'unavailable' : source.frequency}`));
      assert.ok(metadata[index].includes(`${row.companyCount} ${row.companyCount === 1 ? 'company' : 'companies'} in this window`));
    }
  };
  let currentWindow = 'all';
  await ui.select('#window-select', 'all'); await ui.fill('#global-search', '');
  await options('#sort-select', core.SORT_OPTIONS.searchProblems, 'Sort problems');
  result.globalSortMenu=await exerciseMenu(ui,'#sort-select',{output,browserName,capture:'explorer-sort-menu-desktop',commit:true});
  result.windowMenu=await exerciseMenu(ui,'#window-select');
  await choose('#sort-select', 'name-desc'); await expectRows(problemIds, globalProblems({ sort: 'name-desc' }), 'slug');
  await ui.click('#load-more'); await expectRows(problemIds, globalProblems({ sort: 'name-desc', limit: 100 }), 'slug');
  await choose('#sort-select', 'companies-desc');
  const popularProblems = globalProblems({ sort: 'companies-desc' }); await expectRows(problemIds, popularProblems, 'slug'); monotonic(popularProblems, 'companyCount', -1);
  assert.ok(new Set(popularProblems.map(row => row.companyCount)).size > 1);
  await ui.click('#load-more'); await expectRows(problemIds, globalProblems({ sort: 'companies-desc', limit: 100 }), 'slug');
  await choose('#sort-select', 'companies-asc');
  const sparseProblems = globalProblems({ sort: 'companies-asc' }); await expectRows(problemIds, sparseProblems, 'slug'); monotonic(sparseProblems, 'companyCount', 1);
  await ui.fill('#global-search', 'sum'); await choose('#sort-select', 'difficulty-desc');
  const hardFirst = globalProblems({ query: 'sum', sort: 'difficulty-desc' }); await expectRows(problemIds, hardFirst, 'slug');
  monotonic(hardFirst.map(row => ({ difficulty: { Easy: 0, Medium: 1, Hard: 2 }[row.difficulty] })), 'difficulty', -1);
  await ui.fill('#global-search', ''); await choose('#sort-select', 'companies-desc'); await expectRows(problemIds, popularProblems, 'slug');
  await ui.mutate(`document.querySelector('#load-more').click();const n=document.querySelector('#sort-select');for(const value of ['name-desc','companies-asc','companies-desc']){n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await expectRows(problemIds, popularProblems, 'slug'); await wait(350); await expectRows(problemIds, popularProblems, 'slug');
  await expectRead(ui, 'document.querySelector("#results").getAttribute("aria-busy")', 'false');
  checks.push('Problem sorts cover name, difficulty and both company-count directions; changing sort resets pagination and sorted Load more returns the complete first 100 without duplicates.');

  await ui.click('#mode-companies'); await ui.fill('#global-search', '');
  await options('#sort-select', core.SORT_OPTIONS.searchCompanies, 'Sort companies');
  await choose('#sort-select', 'questions-desc');
  const popularCompanies = globalCompanies({ sort: 'questions-desc' }); await expectRows(companyIds, popularCompanies, 'name'); monotonic(popularCompanies, 'problemCount', -1);
  assert.ok(new Set(popularCompanies.map(row => row.problemCount)).size > 1);
  await ui.click('#load-more'); await expectRows(companyIds, globalCompanies({ sort: 'questions-desc', limit: 100 }), 'name');
  await choose('#sort-select', 'name-desc'); await expectRows(companyIds, globalCompanies({ sort: 'name-desc' }), 'name');
  await choose('#sort-select', 'questions-asc');
  const fewestCompanies = globalCompanies({ sort: 'questions-asc' }); await expectRows(companyIds, fewestCompanies, 'name'); monotonic(fewestCompanies, 'problemCount', 1);
  await ui.select('#window-select', '30d'); await expectRows(companyIds, globalCompanies({ sort: 'questions-asc', window: '30d' }), 'name'); await expectRead(ui, selected('#sort-select'), 'questions-asc');
  assert.equal(globalCompanies({ sort: 'questions-asc', window: '30d' })[0].problemCount, 0);
  await ui.select('#window-select', 'all'); await choose('#sort-select', 'questions-desc');
  await ui.fill('#global-search', 'Amazon'); await expectRows(companyIds, globalCompanies({ query: 'Amazon', sort: 'questions-desc' }), 'name');
  await ui.click('#results .company-title[data-company="Amazon"]');
  await expectRead(ui, text('#detail-title'), 'Amazon'); await options('#detail-sort-select', core.SORT_OPTIONS.practiceQuestions, 'Sort company questions');
  result.detailSortMenu=await exerciseMenu(ui,'#detail-sort-select');
  result.difficultyMenu=await exerciseMenu(ui,'#difficulty-select');
  result.topicMenu=await exerciseCompanyPicker(ui);
  await choose('#detail-sort-select', 'frequency-asc');
  const leastFrequent = practice({ sort: 'frequency-asc' }); await verifyPractice(leastFrequent); monotonic(leastFrequent, 'frequency', 1);
  await ui.click('#detail-load-more'); await verifyPractice(practice({ sort: 'frequency-asc', limit: 100 }));
  await choose('#detail-sort-select', 'companies-desc'); const popularQuestions = practice({ sort: 'companies-desc' }); await verifyPractice(popularQuestions); monotonic(popularQuestions, 'companyCount', -1);
  await choose('#detail-sort-select', 'companies-asc'); const sparseQuestions = practice({ sort: 'companies-asc' }); await verifyPractice(sparseQuestions); monotonic(sparseQuestions, 'companyCount', 1);
  await ui.fill('#question-search', 'sum'); await choose('#detail-sort-select', 'name-desc'); await verifyPractice(practice({ query: 'sum', sort: 'name-desc' }));
  await choose('#detail-sort-select', 'difficulty-asc'); await verifyPractice(practice({ query: 'sum', sort: 'difficulty-asc' }));
  await choose('#detail-sort-select', 'companies-desc'); await ui.select('#difficulty-select', 'Easy'); await chooseCompanyTopics(ui, ['Array']);
  const filter = { query: 'sum', difficulty: 'Easy', topics: ['Array'], sort: 'companies-desc' };
  await verifyPractice(practice(filter));
  await ui.select('#window-select', '30d'); currentWindow = '30d'; await verifyPractice(practice({ ...filter, window: '30d' })); await expectRead(ui, selected('#detail-sort-select'), 'companies-desc');
  await ui.select('#window-select', 'all'); currentWindow = 'all'; await verifyPractice(practice(filter));
  await ui.select('#difficulty-select', ''); await chooseCompanyTopics(ui, []); await ui.fill('#question-search', ''); await verifyPractice(popularQuestions);
  await ui.mutate(`document.querySelector('#detail-load-more').click();const n=document.querySelector('#detail-sort-select');for(const value of ['frequency-asc','name-desc','companies-desc']){n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await verifyPractice(popularQuestions); await wait(350); await verifyPractice(popularQuestions);
  await ui.click('#detail-results [data-action="problem"][data-slug="two-sum"]');
  await expectRead(ui, text('#detail-title'), 'Two Sum'); await options('#detail-sort-select', core.SORT_OPTIONS.sortCompanies, 'Sort problem companies');
  const tags = sort => core.sortCompanies(core.companiesForSlug(data, 'two-sum', currentWindow), sort);
  const verifyTags = async sort => {
    const expected = tags(sort); await expectRows(tagIds, expected, 'name');
    await expectRead(ui, texts('#detail-results .company-rank'), expected.map(row => row.rank == null ? 'Rank unavailable' : `Company rank #${row.rank}`));
    await expectRead(ui, texts('#detail-results .frequency-score'), expected.map(row => row.frequency == null ? '—' : String(row.frequency)));
    await expectRead(ui, texts('#detail-results .company-question-count'), expected.map(row => `${row.problemCount.toLocaleString('en')} ${row.problemCount === 1 ? 'question' : 'questions'} in this window`));
    return expected;
  };
  await choose('#detail-sort-select', 'frequency-asc'); monotonic(await verifyTags('frequency-asc'), 'frequency', 1);
  await choose('#detail-sort-select', 'name-desc'); await verifyTags('name-desc');
  await choose('#detail-sort-select', 'questions-desc'); monotonic(await verifyTags('questions-desc'), 'problemCount', -1);
  await choose('#detail-sort-select', 'questions-asc'); monotonic(await verifyTags('questions-asc'), 'problemCount', 1);
  await ui.select('#window-select', '30d'); currentWindow = '30d'; await verifyTags('questions-asc'); await expectRead(ui, selected('#detail-sort-select'), 'questions-asc');
  await ui.select('#window-select', 'all'); currentWindow = 'all'; await verifyTags('questions-asc');
  await ui.click('#detail-back'); await expectRead(ui, text('#detail-title'), 'Amazon'); await expectRead(ui, selected('#detail-sort-select'), 'companies-desc'); await verifyPractice(popularQuestions);
  await ui.click('#detail-back'); await expectRead(ui, selected('#sort-select'), 'questions-desc');
  await ui.click('#mode-problems'); await ui.fill('#global-search', ''); await choose('#sort-select', 'name-desc'); await expectRows(problemIds, globalProblems({ sort: 'name-desc' }), 'slug');
  const stored = { problems: 'name-desc', companies: 'questions-desc', companyQuestions: 'companies-desc', problemCompanies: 'questions-asc' };
  // Read real storage after queued saves settle; only test globals are written.
  for (let attempt = 0; attempt < 40; attempt++) {
    await ui.mutate(`globalThis.__lctSortRead=null;(globalThis.browser||globalThis.chrome).storage.local.get('lctExplorerSorts').then(value=>{globalThis.__lctSortRead=value.lctExplorerSorts;});`);
    await wait(50); if (JSON.stringify(await ui.read('globalThis.__lctSortRead')) === JSON.stringify(stored)) break;
  }
  await expectRead(ui, 'globalThis.__lctSortRead', stored); result.storedPreferences = stored;
  if (ui.reload) {
    await ui.reload(); await expectRead(ui, selected('#sort-select'), 'name-desc'); await expectRows(problemIds, globalProblems({ sort: 'name-desc' }), 'slug');
    await ui.click('#mode-companies'); await ui.fill('#global-search', 'Amazon'); await expectRead(ui, selected('#sort-select'), 'questions-desc');
    await expectRows(companyIds, ['Amazon'].map(name => ({ name })), 'name'); await ui.click('#results .company-title[data-company="Amazon"]');
    await expectRead(ui, selected('#detail-sort-select'), 'companies-desc'); await verifyPractice(popularQuestions);
    await ui.click('#detail-results [data-action="problem"][data-slug="two-sum"]'); await expectRead(ui, selected('#detail-sort-select'), 'questions-asc'); await verifyTags('questions-asc');
    await ui.click('#detail-back'); await ui.click('#detail-back'); result.reload = 'Actual packaged document reload preserves all four independent sort choices.';
  } else result.reload = 'Stored preferences verified plus mode/window/drilldown/Back roundtrips; Firefox console driver cannot reacquire a navigated tab.';
  checks.push('Company question and problem-company sorts use real selected-window counts while retaining source frequency/rank, composed filters and independent sort choices through windows and Back.');
  checks.push('Pending Load more followed by rapid sort changes cannot append an old-order page; all four validated preferences are saved independently.');
  checks.push('The dropdown menus retain synchronized labels, rounded options and keyboard/dismissal behavior; the company checkbox topic dialog opens by keyboard, fits its viewport and restores focus on Escape.');
  if (ui.reload) checks.push('A real explorer document reload restores global problem/company and both detail sort preferences from extension storage.');

  if (ui.setViewport && ui.setColorScheme) {
    const previous = ui.viewport(); await ui.setViewport({ width: 375, height: 720 });
    for (const scheme of ['light', 'dark']) {
      await ui.setColorScheme(scheme);
      const geometry = async selectors => {
        const measured = await ui.read(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:${JSON.stringify(selectors)}.map(selector=>{const field=document.querySelector(selector),n=field.tagName==='SELECT'?document.getElementById(field.id+'-trigger')||field:field,r=n.getBoundingClientRect();return{selector,left:r.left,right:r.right,width:r.width,height:r.height};})})`);
        assert.equal(measured.width,375); assert.ok(measured.scrollWidth<=375);
        for (const row of measured.controls) assert.ok(row.width>0&&row.height>0&&row.left>=0&&row.right<=375,`${row.selector} must fit375px in ${scheme}.`);
        return measured;
      };
      await ui.click('#mode-problems'); await ui.fill('#global-search',''); await expectRows(problemIds,globalProblems({sort:'name-desc'}),'slug');
      result[`${scheme}Search375`] = await geometry(['#global-search','#window-select','#sort-select','#results a.leetcode-link']);
      result[`${scheme}SortMenu375`]=await exerciseMenu(ui,'#sort-select',{output,browserName,capture:`explorer-sort-menu-375-${scheme}`});
      if(ui.screenshot)await ui.screenshot(path.join(output,`${browserName}-explorer-sort-375-${scheme}.png`));
      await ui.click('#mode-companies'); await ui.fill('#global-search','Amazon'); await expectRows(companyIds,[{name:'Amazon'}],'name'); await ui.click('#results .company-title[data-company="Amazon"]'); await verifyPractice(popularQuestions);
      result[`${scheme}Detail375`] = await geometry(['#detail-back','#window-select','#detail-sort-select','#difficulty-select','#detail-topic-picker-trigger','#question-search','#detail-results a.leetcode-link']);
      result[`${scheme}DetailMenu375`]=await exerciseMenu(ui,'#detail-sort-select',{output,browserName,capture:`explorer-detail-menu-375-${scheme}`});
      if(ui.screenshot)await ui.screenshot(path.join(output,`${browserName}-explorer-question-sort-375-${scheme}.png`));
      await ui.click('#detail-back');
    }
    await ui.setViewport(previous); await ui.setColorScheme('light');
    checks.push('Labelled sort comboboxes and action links fit375px in both light/dark search and company detail views without horizontal overflow.');
  }
  // Do not let intentionally persisted nondefault choices affect subsequent checks.
  await ui.click('#mode-companies'); await ui.fill('#global-search','Amazon'); await choose('#sort-select','name-asc'); await expectRows(companyIds,[{name:'Amazon'}],'name');
  await ui.click('#results .company-title[data-company="Amazon"]'); await choose('#detail-sort-select','frequency-desc'); await verifyPractice(practice());
  await ui.click('#detail-results [data-action="problem"][data-slug="two-sum"]'); await choose('#detail-sort-select','frequency-desc'); await verifyTags('frequency-desc');
  await ui.click('#detail-back'); await ui.click('#detail-back'); await ui.click('#mode-problems'); await ui.fill('#global-search',''); await choose('#sort-select','relevance'); await expectRows(problemIds,globalProblems({}),'slug');
  if(ui.screenshot)await ui.screenshot(path.join(output,`${browserName}-explorer-sort-desktop.png`),{fullPage:false});
  return { checks, ...result };
}

export async function exerciseExplorer(ui, { data, core, output, browserName }) {
  const checks = [];
  const acceptance = {};
  const logos = {};
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
  const expectQuestions = async (expected) => {
    await expectRead(ui, texts(questionTitles), expected.map(({ title }) => title));
    await expectRead(ui, texts('#detail-results .acceptance-rate'), expected.map(question => acceptanceLabel(core, core.problemForSlug(data, question.slug)?.acceptanceRate)));
  };
  const expectCompanies = async (expected) => {
    await expectRead(ui, texts(companyNames), expected.map(({ name }) => name));
    await expectRead(ui, texts(companyScores), expected.map(({ frequency }) => frequency == null ? '—' : String(frequency)));
    await expectRead(ui, texts(companyRanks), expected.map(({ rank }) => rank == null ? 'Rank unavailable' : `Company rank #${rank}`));
  };
  await expectRead(ui, visible('#global-search'), true);
  await expectRead(ui, 'document.querySelector("#window-select").value', 'all');
  await expectRead(ui, 'document.querySelector("#mode-problems").getAttribute("aria-selected")', 'true');
  await expectRead(ui, 'document.querySelector("#sort-select").value', 'relevance');

  // Every catalog comes from the selected complete window, including questions
  // and companies that are absent from the current LeetCode problem's tags.
  const coverage = {};
  for (const window of ['all', '30d', '3m', '6m', 'older', 'all']) {
    await ui.select('#window-select', window);
    await ui.fill('#global-search', '');
    const expected = core.searchProblems(data, { window, limit: 50 });
    await expectRead(ui, problemSlugs(), expected.problems.map(({ slug }) => slug));
    await expectRead(ui, texts('#results .acceptance-rate'), expected.problems.map(problem => acceptanceLabel(core, problem.acceptanceRate)));
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
  const twoSumLabel = acceptanceLabel(core, core.problemForSlug(data, 'two-sum').acceptanceRate);
  const globalAcceptance = '#results .question-row[data-slug="two-sum"] .acceptance-rate';
  acceptance.global = await exerciseAcceptanceControl(ui, { selector: globalAcceptance, label: twoSumLabel, core });
  if (ui.screenshot) {
    await ui.click(globalAcceptance);
    await ui.screenshot(path.join(output, `${browserName}-acceptance-explorer-help.png`));
    await ui.press(globalAcceptance, 'Escape');
  }
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-problems.png`));
  await ui.activateWithKeyboard('#results [data-action="problem"][data-slug="two-sum"]');
  await expectRead(ui, visible('#detail-view'), true);
  await expectRead(ui, text('#detail-title'), 'Two Sum');
  acceptance.problem = await exerciseAcceptanceControl(ui, { selector: '#detail-context .acceptance-rate', label: twoSumLabel, core });
  const expectedTags = core.companiesForSlug(data, 'two-sum', 'all');
  await expectCompanies(expectedTags);
  await expectSummary(ui, '#detail-summary', expectedTags.length);
  logos.twoSum = await verifyBadges(ui, { selector: '#detail-results .company-title > .company-logo', names: expectedTags.map(company => company.name), label: 'View questions for {name}' });
  assert.ok(logos.twoSum.initials.length > 0, 'Real unmapped source companies must display initials.');
  if (ui.setColorScheme) {
    await ui.setColorScheme('dark');
    await verifyBadges(ui, { selector: '#detail-results .company-title > .company-logo', names: expectedTags.map(company => company.name) });
    await ui.setColorScheme('light');
  }
  logos.brokenLocalImage = await exerciseBrokenLogo(ui);
  await ui.activateWithKeyboard('#detail-results .company-title[data-company="Amazon"]');
  await expectRead(ui, text('#detail-title'), 'Amazon');
  await expectQuestions(questions('Amazon').questions);
  acceptance.company = await exerciseAcceptanceControl(ui, { selector: '#detail-results .question-row[data-slug="two-sum"] .acceptance-rate', label: twoSumLabel, core });
  logos.amazonHeading = await verifyBadges(ui, { selector: '#detail-name > .company-logo', names: ['Amazon'], size: 24, known: true });
  await ui.activateWithKeyboard('#detail-back');
  await expectRead(ui, text('#detail-title'), 'Two Sum');
  await expectCompanies(expectedTags);
  await expectRead(ui, 'document.activeElement?.getAttribute("data-company")', 'Amazon');
  assert.equal(expectedTags.length, 115);
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-two-sum.png`));
  await ui.select('#window-select', '30d');
  await expectCompanies(core.companiesForSlug(data, 'two-sum', '30d'));
  await expectRead(ui, texts('#detail-context .acceptance-rate'), [twoSumLabel]);
  await ui.select('#window-select', 'all');
  await expectCompanies(expectedTags);
  await ui.activateWithKeyboard('#detail-back');
  await expectRead(ui, visible('#results'), true);
  await expectRead(ui, problemSlugs(), twoSumSearch.problems.map(({ slug }) => slug));
  checks.push('Global Two Sum lookup opens all 115 companies sorted by source score with ranks and correctly refreshes its selected window.');
  checks.push('Explorer renders saved acceptance beside difficulty in global and company question rows, preserves the same global rate in problem/company/window views, and reveals the submission-rate explanation by click/keyboard with Escape dismissal.');

  await ui.activateWithKeyboard('#mode-companies');
  await ui.fill('#global-search', 'Acko');
  await expectRead(ui, companyNamesGlobal(), ['Acko']);
  logos.ackoRow = await verifyBadges(ui, { selector: '#results .company-title > .company-logo', names: ['Acko'], known: true, label: 'View questions for {name}' });
  const acko = core.searchCompanies(data, { query: 'Acko', window: 'all' }).companies[0];
  assert.equal(acko.problemCount, 4);
  assert.equal(expectedTags.some(({ name }) => name === 'Acko'), false);
  await ui.click('#results .company-title[data-action="company"][data-company="Acko"]');
  await expectRead(ui, text('#detail-title'), 'Acko');
  await expectQuestions(questions('Acko').questions);
  await expectSummary(ui, '#detail-summary', 4);
  logos.ackoHeading = await verifyBadges(ui, { selector: '#detail-name > .company-logo', names: ['Acko'], size: 24, known: true });
  if (ui.screenshot) await ui.screenshot(path.join(output, `${browserName}-explorer-acko.png`));
  if (ui.setViewport) {
    const previousViewport = ui.viewport();
    await ui.setViewport({ width: 375, height: 667 });
    const geometry = await ui.read(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: ['#detail-back', '#window-select', '#difficulty-select', '#detail-topic-picker-trigger', '#question-search', '#detail-results a[href*=problems]', '#detail-results .acceptance-rate'].map(selector => {
        const field=document.querySelector(selector);const node=field.tagName==='SELECT'?document.getElementById(field.id+'-trigger')||field:field;const rect=node.getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      }) })`);
    await verifyBadges(ui, { selector: '#detail-name > .company-logo', names: ['Acko'], size: 24, known: true });
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
  await chooseCompanyTopics(ui, ['Math']);
  await expectQuestions(questions('Acko', { difficulty: 'Hard', topics: ['Math'] }).questions);
  await ui.fill('#question-search', 'parallel');
  await expectQuestions([]);
  await chooseCompanyTopics(ui, []);
  await expectQuestions(questions('Acko', { difficulty: 'Hard', query: 'parallel' }).questions);
  await ui.select('#difficulty-select', 'Easy');
  await expectQuestions([]);
  await ui.fill('#question-search', '');
  await expectQuestions(questions('Acko', { difficulty: 'Easy' }).questions);
  await chooseCompanyTopics(ui, ['Database']);
  await expectQuestions(questions('Acko', { difficulty: 'Easy', topics: ['Database'] }).questions);
  await ui.select('#difficulty-select', '');
  await chooseCompanyTopics(ui, []);
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
  logos.companySearch = await verifyBadges(ui, { selector: '#results .company-title > .company-logo', names: first100Companies, label: 'View questions for {name}' });
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
  const finalFilters = await ui.read('({ difficulty: document.querySelector("#difficulty-select").value, topics: Array.from(document.querySelectorAll("#detail-topic-picker-selected button[data-topic]"),node=>node.dataset.topic), topicMatch: document.querySelector("#detail-topic-match-select").value, query: document.querySelector("#question-search").value })');
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
  checks.push('Explorer decodes local SVG/PNG company logos in real search rows and company headings, preserves accessible names, and shows readable initials when a brand is unmapped or a packaged image fails.');
  const sorting = await exerciseSorting(ui, { data, core, output, browserName });
  checks.push(...sorting.checks);
  return { checks, acceptance, logos, coverage, sorting, twoSumCompanies: expectedTags.length, ackoQuestions: 4, amazonQuestions: 2011, keyboardVerification: ui.keyboard };
}
