(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome, core = globalThis.LCTCore;
  const $ = id => document.getElementById(id), popup = Boolean($('popup-browse'));
  const controls = globalThis.LCTSelectControls.create();
  const panel = document.createElement('section'); panel.id = 'target-view'; panel.className = 'target-view'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'target-title'); if (popup) panel.dataset.popup = '';
  panel.innerHTML = `<div class="target-heading"><h2 id="target-title">Target</h2><button id="target-expand" class="target-expand" type="button" title="Open Target full page" aria-label="Open Target full page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 12 21 3M15 3h6v6"/></svg></button></div>
    <p class="target-help" id="target-help">Pick your next problem, or build a company prep list.</p>
    <div class="target-kind" role="group" aria-label="Target mode"><button id="target-random" type="button" aria-pressed="true">Random problem</button><button id="target-plan" type="button" aria-pressed="false">Company prep</button></div>
    <div class="target-controls">
      <label class="target-company-search"><span>Find a company</span><input id="target-company-search" type="search" placeholder="e.g. Microsoft" aria-label="Find a target company" maxlength="200" autocomplete="off"></label>
      <label class="target-company-wrap"><span id="target-company-label">Company (optional)</span><select id="target-company" aria-label="Target company"><option value="">Any company</option></select></label>
      <label><span>Difficulty</span><select id="target-difficulty" aria-label="Target difficulty"><option value="">All difficulties</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label>
      <label><span>Topic</span><select id="target-topic" aria-label="Target topic"><option value="">All topics</option></select></label>
      <label><span>Status</span><select id="target-status" aria-label="Target problem status"><option value="all">All problems</option><option value="solved">Solved</option><option value="not-solved">Not solved</option></select></label>
      <label id="target-count-wrap" hidden><span>List size</span><select id="target-count" aria-label="Target list size"><option value="12">12 questions</option><option value="20" selected>20 questions</option><option value="30">30 questions</option><option value="50">50 questions</option></select></label>
    </div><button id="target-generate" type="button" class="target-submit">Pick a problem</button>
    <p id="target-message" class="target-message" role="status" aria-live="polite">Choose optional filters, then pick a problem.</p>
    <details id="target-coverage" class="target-coverage" hidden><summary id="target-coverage-title"></summary><p id="target-coverage-topics"></p></details>
    <ul id="target-results" class="target-results" aria-label="Target problems"></ul>`;
  if (popup) document.querySelector('.problem').after(panel); else $('detail-view').after(panel);
  $('target-expand').hidden = !popup;
  controls.enhance(['target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count']);
  let initialized = false, initializing = null, companies = [], kind = 'random', generation = 0, catalogGeneration = 0;
  let recent = [], recentContext = '', lastResult = null, hasPlan = false, saveQueue = Promise.resolve();
  const visible = () => document.body.hasAttribute('data-target');
  function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
  function message(text, error = false) { $('target-message').textContent = text; $('target-message').toggleAttribute('data-error', error); }
  function clearResults(text) { generation++; $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); lastResult = null; $('target-results').replaceChildren(); $('target-coverage').hidden = true; if (text) message(text); }
  function preferences() { return { targetMode: kind, company: $('target-company').value, difficulty: $('target-difficulty').value, topic: $('target-topic').value, completionFilter: $('target-status').value, count: Number($('target-count').value), hasPlan }; }
  function save() { const value = preferences(); saveQueue = saveQueue.then(() => api.storage.local.set({ lctTargetPreferences: value })).catch(() => {}); return saveQueue; }
  function setKind(value) {
    kind = value; $('target-random').setAttribute('aria-pressed', String(kind === 'random')); $('target-plan').setAttribute('aria-pressed', String(kind === 'plan'));
    $('target-count-wrap').hidden = kind !== 'plan'; $('target-company-search').closest('label').hidden = kind !== 'plan'; $('target-company').closest('label').hidden = kind !== 'plan'; $('target-company-label').textContent = kind === 'plan' ? 'Target company' : 'Company (optional)';
    $('target-generate').textContent = kind === 'plan' ? 'Build prep list' : 'Pick a problem';
    $('target-help').textContent = kind === 'plan' ? 'Prioritize company frequency while covering different topics.' : 'Choose optional filters. Recent picks are skipped while you keep picking.';
  }
  function request(targetMode = kind) { return { type: 'LCT_TARGET', targetMode, company: kind === 'plan' ? $('target-company').value : '',
    difficulty: $('target-difficulty').value, topics: $('target-topic').value ? [$('target-topic').value] : [],
    completionFilter: $('target-status').value, count: Number($('target-count').value), window: $('window-select').value }; }
  function companyOptions() {
    const selected = $('target-company').value, q = $('target-company-search').value.trim().toLocaleLowerCase();
    const exact = companies.find(c => c.name.toLocaleLowerCase() === q);
    const options = companies.filter(c => !q || c.name.toLocaleLowerCase().includes(q) || c.name === selected);
    $('target-company').replaceChildren(new Option('Any company', ''), ...options.map(c => new Option(c.name, c.name)));
    $('target-company').value = exact?.name || selected;
    controls.sync($('target-company'));
    if (exact && exact.name !== selected) { clearResults('Company changed. Generate a new target.'); void catalog(); void save(); }
  }
  async function catalog() {
    const id = ++catalogGeneration, selected = $('target-topic').value;
    try {
      const result = await api.runtime.sendMessage({ ...request('catalog'), difficulty: '', topics: [], completionFilter: 'all' });
      if (id !== catalogGeneration) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load topics.');
      $('target-topic').replaceChildren(new Option('All topics', ''), ...(result.topics || []).map(topic => new Option(topic, topic)));
      if ([...$('target-topic').options].some(option => option.value === selected)) $('target-topic').value = selected;
      controls.sync($('target-topic'));
    } catch (error) { if (id === catalogGeneration) message(error.message, true); }
  }
  async function initialize() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      for (const id of ['target-random', 'target-plan', 'target-company-search', 'target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count', 'target-generate']) { $(id).disabled = true; if ($(id).tagName === 'SELECT') controls.sync($(id)); }
      message('Loading saved companies…');
      const stored = await api.storage.local.get(['lctTargetPreferences', 'lctSettings']);
      if (core.WINDOW_FILES[stored.lctSettings?.window]) $('window-select').value = stored.lctSettings.window;
      let offset = 0;
      do {
        const result = await api.runtime.sendMessage({ type: 'LCT_SEARCH_COMPANIES', window: $('window-select').value, sort: 'name-asc', offset, limit: 100 });
        if (!result?.ok) throw new Error(result?.error || 'Could not load companies.');
        companies.push(...result.companies); offset += result.companies.length;
        if (!result.hasMore) break;
        if (!result.companies.length) throw new Error('Could not continue loading companies.');
      } while (offset < 25000);
      const pref = stored.lctTargetPreferences || {};
      companyOptions(); if (companies.some(c => c.name === pref.company)) $('target-company').value = pref.company;
      if (['', 'Easy', 'Medium', 'Hard'].includes(pref.difficulty)) $('target-difficulty').value = pref.difficulty;
      if (['all', 'solved', 'not-solved'].includes(pref.completionFilter)) $('target-status').value = pref.completionFilter;
      if ([12, 20, 30, 50].includes(pref.count)) $('target-count').value = String(pref.count);
      setKind(pref.targetMode === 'plan' ? 'plan' : 'random'); hasPlan = pref.hasPlan === true;
      await catalog(); if ([...$('target-topic').options].some(option => option.value === pref.topic)) $('target-topic').value = pref.topic;
      for (const id of ['target-company', 'target-difficulty', 'target-status', 'target-topic', 'target-count']) controls.sync($(id));
      initialized = true; message(kind === 'plan' ? 'Choose a company, then build your prep list.' : 'Choose optional filters, then pick a problem.');
      if (kind === 'plan' && hasPlan && $('target-company').value && visible()) await generate();
    })().finally(() => { initializing = null; for (const id of ['target-random', 'target-plan', 'target-company-search', 'target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count', 'target-generate']) { $(id).disabled = false; if ($(id).tagName === 'SELECT') controls.sync($(id)); } });
    return initializing;
  }
  function render(result) {
    lastResult = result;
    const rows = result.questions || [];
    $('target-results').replaceChildren(...rows.map((row, index) => {
      const li = node('li', 'target-question'), info = node('div', 'target-question-info'), title = node('h3', '', (kind === 'plan' ? (index + 1) + '. ' : '') + row.title);
      if (row.completed === true) { const check = node('span', 'completion-indicator'); check.setAttribute('role', 'img'); check.setAttribute('aria-label', 'Completed on LeetCode'); check.title = 'Completed on LeetCode'; check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/></svg>'; title.append(check); }
      const rate = core.formatAcceptanceRate(row.acceptanceRate);
      const parts = [row.difficulty || 'Difficulty unavailable']; if (rate !== null) parts.push('Acceptance ' + rate);
      if (Number.isFinite(row.frequency)) parts.push('Frequency ' + row.frequency);
      if (Number.isInteger(row.rank)) parts.push('Company rank #' + row.rank);
      info.append(title, node('p', 'target-question-meta', parts.join(' · ')), node('p', 'target-question-topics', (row.topics || []).join(' · ')));
      if (kind === 'plan' && row.newTopics?.length) info.append(node('p', 'target-reason', 'Adds ' + row.newTopics.join(', ')));
      const link = node('a', 'target-open'); link.href = 'https://leetcode.com/problems/' + encodeURIComponent(row.slug) + '/'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', 'Solve ' + row.title + ' on LeetCode'); link.title = 'Solve on LeetCode';
      const icon = node('img'); icon.src = api.runtime.getURL('icons/leetcode.svg'); icon.alt = ''; link.append(icon); li.append(info, link); return li;
    }));
    $('target-coverage').hidden = kind !== 'plan' || !rows.length;
    if (kind === 'plan') { $('target-coverage-title').textContent = (result.coveredTopics || []).length + ' of ' + result.availableTopicCount + ' matching topics covered'; $('target-coverage-topics').textContent = (result.coveredTopics || []).join(' · '); }
    message(rows.length ? kind === 'plan' ? rows.length + ' questions · ' + (result.coveredTopics || []).length + ' topics · ' + $('target-company').value : 'Picked from ' + result.total.toLocaleString() + ' matching problems.' : 'No matching problems. Try another difficulty, topic, status, or time window.');
    if (result.completion?.unknownCount > 0) message($('target-message').textContent + ' ' + result.completion.unknownCount + ' unknown statuses excluded.');
  }
  async function generate() {
    controls.close();
    if (kind === 'plan' && !$('target-company').value) { message('Choose a target company first.', true); $('target-company-trigger').focus(); return; }
    const query = request(), context = JSON.stringify(query);
    if (recentContext !== context) { recent = []; recentContext = context; }
    clearResults(); const id = generation; $('target-generate').disabled = true; panel.setAttribute('aria-busy', 'true'); message(kind === 'plan' ? 'Building your prep list…' : 'Picking a problem…');
    try {
      const result = await api.runtime.sendMessage({ ...query, ...(kind === 'random' ? { excludeSlugs: recent.slice(-100) } : {}), ...(query.completionFilter !== 'all' ? { refreshCompletion: true } : {}) });
      if (id !== generation) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not build your target. Try again.');
      if (query.completionFilter !== 'all' && result.completion?.state !== 'ready') throw new Error(result.completion?.state === 'signed-out' ? 'Sign in to LeetCode, then try again.' : result.completion?.state === 'no-tab' ? 'Open a signed-in LeetCode tab, then try again.' : 'Could not check completion status. Refresh your LeetCode tab or choose All problems.');
      if (!result.available) throw new Error('The saved dataset is unavailable for this time window. Refresh the dataset or choose another window.');
      if (kind === 'random' && result.questions?.length) recent.push(result.questions[0].slug);
      hasPlan = kind === 'plan' && Boolean(result.questions?.length); render(result); void save();
    } catch (error) { if (id === generation) message(error.message, true); }
    finally { if (id === generation) { $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); } }
  }
  function show(active) {
    if (active) invalidatePrivate();
    document.body.toggleAttribute('data-target', active); panel.hidden = !active; controls.close();
    $('mode-target').setAttribute('aria-selected', String(active)); $('mode-target').tabIndex = active ? 0 : -1;
    if (popup) { $('popup-browse').setAttribute('aria-selected', String(!active)); $('popup-browse').tabIndex = active ? -1 : 0; }
    else if (active) for (const id of ['mode-problems', 'mode-companies']) { $(id).setAttribute('aria-selected', 'false'); $(id).tabIndex = -1; }
    if (active) void initialize().catch(error => { companies = []; message(error.message + ' Switch tabs to retry.', true); });
    else { generation++; $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); }
  }
  $('mode-target').addEventListener('click', () => show(true));
  for (const id of popup ? ['popup-browse'] : ['mode-problems', 'mode-companies']) $(id).addEventListener('click', () => show(false), true);
  const tabs = popup ? ['popup-browse', 'mode-target'] : ['mode-problems', 'mode-companies', 'mode-target'];
  document.querySelector(popup ? '.popup-mode-tabs' : '.mode-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation(); const index = tabs.indexOf(document.activeElement.id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    $(tabs[next]).click(); $(tabs[next]).focus();
  }, true);
  for (const [id, value] of [['target-random', 'random'], ['target-plan', 'plan']]) $(id).addEventListener('click', () => { clearResults(); setKind(value); void catalog(); message(value === 'plan' ? 'Choose a company, then build your prep list.' : 'Pick a problem using these filters.'); void save(); });
  $('target-company-search').addEventListener('input', companyOptions);
  for (const id of ['target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count']) $(id).addEventListener('change', () => { clearResults('Filters changed. Generate a new target.'); $('target-generate').disabled = false; if (id === 'target-company') void catalog(); void save(); });
  $('window-select').addEventListener('change', () => { if (initialized) { clearResults('Time window changed. Generate a new target.'); void catalog(); } });
  $('target-generate').addEventListener('click', () => void generate());
  $('target-expand').addEventListener('click', async () => { try { await save(); const result = await api.runtime.sendMessage({ type: 'LCT_OPEN_EXPLORER', mode: 'target' }); if (!result?.ok) throw new Error(result?.error || 'Could not expand Target.'); } catch (error) { message(error.message, true); } });
  function invalidatePrivate() { if ($('target-status').value !== 'all' && (lastResult || (visible() && panel.getAttribute('aria-busy') === 'true'))) { clearResults('Generate again to refresh your LeetCode status.'); $('target-generate').disabled = false; } }
  window.addEventListener('focus', invalidatePrivate); document.addEventListener('visibilitychange', () => { if (!document.hidden) invalidatePrivate(); });
  setInterval(() => { if (!document.hidden) invalidatePrivate(); }, 60000);
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.lctStatus && initialized && lastResult && changes.lctStatus.newValue?.commit && changes.lctStatus.newValue.commit !== lastResult.sourceRevision) clearResults('Dataset updated. Generate a fresh target.'); });
  if (!popup && new URLSearchParams(location.search).get('mode') === 'target') show(true);
})();
