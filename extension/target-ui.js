(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome, core = globalThis.LCTCore;
  const $ = id => document.getElementById(id), popup = Boolean($('popup-browse'));
  const controls = globalThis.LCTSelectControls.create();
  const panel = document.createElement('section'); panel.id = 'target-view'; panel.className = 'target-view'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'target-title'); if (popup) panel.dataset.popup = '';
  panel.innerHTML = `<div class="target-heading"><h2 id="target-title">Target</h2><button id="target-expand" class="target-expand" type="button" title="Open Target full page" aria-label="Open Target full page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 12 21 3M15 3h6v6"/></svg></button></div>
    <p class="target-help" id="target-help">Pick your next problem, or build a company prep list.</p>
    <div id="target-kind" class="target-kind" role="group" aria-label="Target mode"><button id="target-random" type="button" aria-pressed="true">Random problem</button><button id="target-plan" type="button" aria-pressed="false">Company prep</button></div>
    <div class="target-controls">
      <label class="target-company-search"><span>Find a company</span><input id="target-company-search" type="search" placeholder="e.g. Microsoft" aria-label="Find a target company" maxlength="200" autocomplete="off"></label>
      <label class="target-company-wrap"><span id="target-company-label">Company (optional)</span><select id="target-company" aria-label="Target company"><option value="">Any company</option></select></label>
      <label><span>Difficulty</span><select id="target-difficulty" aria-label="Target difficulty"><option value="">All difficulties</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label>
      <label><span>Topic</span><select id="target-topic" aria-label="Target topic"><option value="">All topics</option></select></label>
      <label><span>Status</span><select id="target-status" aria-label="Target problem status"><option value="all">All problems</option><option value="solved">Solved</option><option value="not-solved">Not solved</option></select></label>
      <label id="target-count-wrap" hidden><span>List size</span><select id="target-count" aria-label="Target list size"><option value="12">12 questions</option><option value="20" selected>20 questions</option><option value="30">30 questions</option><option value="50">50 questions</option></select></label>
    </div>
    <section id="target-editor" class="target-editor" aria-labelledby="target-editor-title" hidden>
      <h3 id="target-editor-title">Edit collection</h3><label for="target-name">Collection name</label><input id="target-name" type="text" maxlength="100" autocomplete="off">
      <p id="target-editor-help" class="target-help"></p><div class="target-editor-actions"><button id="target-rename" type="button">Save name</button><button id="target-update" type="button">Update collection</button><button id="target-cancel" type="button">Cancel</button></div>
    </section>
    <button id="target-generate" type="button" class="target-submit">Pick a problem</button>
    <p id="target-message" class="target-message" role="status" aria-live="polite">Choose optional filters, then pick a problem.</p>
    <details id="target-coverage" class="target-coverage" hidden><summary id="target-coverage-title"></summary><p id="target-coverage-topics"></p></details>
    <div id="target-actions" class="target-actions" hidden><button id="target-download" type="button">Download CSV</button><button id="target-save" type="button">Save to collection</button><button id="target-edit" type="button" hidden>Edit collection</button><span id="target-saved-status" role="status"></span></div>
    <details id="target-collection" class="target-collection"><summary id="target-collection-title">Saved targets</summary><p id="target-collection-empty" class="target-help">Company prep lists are saved here automatically.</p><ul id="target-collection-list"></ul></details>
    <ul id="target-results" class="target-results" aria-label="Target problems"></ul>`;
  if (popup) document.querySelector('.problem').after(panel); else $('detail-view').after(panel);
  $('target-expand').hidden = !popup;
  controls.enhance(['target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count']);
  let initialized = false, initializing = null, companies = [], kind = 'random', generation = 0, catalogGeneration = 0;
  let recent = [], recentContext = '', lastResult = null, hasPlan = false, saveQueue = Promise.resolve();
  let savedTargets = [], currentSaved = null, lastContext = null, saving = 0;
  let editing = null, editBusy = null;
  const visible = () => document.body.hasAttribute('data-target');
  function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
  function message(text, error = false) { $('target-message').textContent = text; $('target-message').toggleAttribute('data-error', error); }
  function clearResults(text) { generation++; if (editBusy !== 'save') editBusy = null; renderEditor(); $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); lastResult = null; currentSaved = null; lastContext = null; renderActions(); $('target-results').replaceChildren(); $('target-coverage').hidden = true; if (text) message(text); }
  function preferences() { return { targetMode: kind, company: $('target-company').value, difficulty: $('target-difficulty').value, topic: $('target-topic').value, completionFilter: $('target-status').value, count: Number($('target-count').value), hasPlan, savedTargetId: currentSaved?.id || null }; }
  function save() { const value = preferences(); saveQueue = saveQueue.then(() => api.storage.local.set({ lctTargetPreferences: value })).catch(() => {}); return saveQueue; }
  function setKind(value) {
    kind = value; $('target-random').setAttribute('aria-pressed', String(kind === 'random')); $('target-plan').setAttribute('aria-pressed', String(kind === 'plan'));
    $('target-count-wrap').hidden = kind !== 'plan'; $('target-company-label').textContent = kind === 'plan' ? 'Target company' : 'Company (optional)';
    renderEditor();
    $('target-generate').textContent = kind === 'plan' ? 'Build prep list' : 'Pick a problem';
    $('target-help').textContent = kind === 'plan' ? 'Prioritize company frequency while covering different topics.' : 'Choose optional filters. Recent picks are skipped while you keep picking.';
  }
  function request(targetMode = kind) { return { type: 'LCT_TARGET', targetMode, company: $('target-company').value,
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
      await loadCollection();
      const saved = savedTargets.find(target => target.id === pref.savedTargetId);
      if (saved && saved.context.targetMode === kind && visible()) openSaved(saved);
      else if (kind === 'plan' && hasPlan && !Object.hasOwn(pref, 'savedTargetId') && $('target-company').value && visible()) await generate();
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
    renderActions();
  }
  async function generate(editState = null) {
    controls.close();
    if (editState && (editing !== editState || editBusy)) return;
    const collectionName = editState ? $('target-name').value.trim() : null;
    if (editState && !collectionName) { message('Enter a collection name.', true); $('target-name').focus(); return; }
    if (kind === 'plan' && !$('target-company').value) { message('Choose a target company first.', true); $('target-company-trigger').focus(); return; }
    const query = request(), context = JSON.stringify(query);
    if (recentContext !== context) { recent = []; recentContext = context; }
    clearResults(); if (editState) { editBusy = 'generate'; renderEditor(); } const id = generation; $('target-generate').disabled = true; panel.setAttribute('aria-busy', 'true'); message(kind === 'plan' ? 'Building your prep list…' : 'Picking a problem…');
    try {
      const result = await api.runtime.sendMessage({ ...query, ...(kind === 'random' ? { excludeSlugs: recent.slice(-100) } : {}), ...(query.completionFilter !== 'all' ? { refreshCompletion: true } : {}) });
      if (id !== generation) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not build your target. Try again.');
      if (query.completionFilter !== 'all' && result.completion?.state !== 'ready') throw new Error(result.completion?.state === 'signed-out' ? 'Sign in to LeetCode, then try again.' : result.completion?.state === 'no-tab' ? 'Open a signed-in LeetCode tab, then try again.' : 'Could not check completion status. Refresh your LeetCode tab or choose All problems.');
      if (!result.available) throw new Error('The saved dataset is unavailable for this time window. Refresh the dataset or choose another window.');
      if (editState && !result.questions?.length) throw new Error('No matching problems. Your saved collection has been kept. Change the filters and try again.');
      if (kind === 'random' && result.questions?.length) recent.push(result.questions[0].slug);
      hasPlan = kind === 'plan' && Boolean(result.questions?.length); lastContext = query; render(result);
      if (editState) await commitEdit(editState, collectionName, { ...result, context: query });
      else if (hasPlan) await saveCurrent(true);
      if (id === generation) void save();
    } catch (error) { if (id === generation) message(error.message, true); }
    finally { if (id === generation) { $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); if (editState && editing === editState) { editBusy = null; renderEditor(); } } }
  }
  function renderActions() {
    $('target-actions').hidden = !lastResult?.questions?.length;
    $('target-save').disabled = saving || Boolean(currentSaved);
    $('target-download').disabled = !lastResult?.questions?.length;
    $('target-save').textContent = saving ? 'Saving…' : 'Save to collection';
    $('target-saved-status').textContent = currentSaved ? 'Saved to collection' : '';
    $('target-save').hidden = Boolean(currentSaved) || Boolean(editing);
    $('target-edit').hidden = !currentSaved || Boolean(editing);
    $('target-saved-status').textContent = currentSaved ? 'Saved · ' + currentSaved.name : '';
  }
  function targetSnapshot() { return { ...lastResult, context: lastContext }; }
  function download(target) {
    try {
      const blob = new Blob([globalThis.LCTTargetCollection.csv(target)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'company-lens-' + (target.name || target.context.company || 'random').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + target.context.window + '.csv';
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { message('Could not download CSV. ' + error.message, true); }
  }
  const windowLabel = value => ({ all: 'All time', '30d': '30 days', '3m': '3 months', '6m': '6 months', older: 'Older than 6 months' })[value];
  const collectionIcons = {
    Open: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    Edit: '<path d="m16 3 5 5-13 13-5 1 1-5L16 3ZM13 6l5 5"/>',
    Clone: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    CSV: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
    Remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'
  };
  function collectionIcon(action) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    svg.innerHTML = collectionIcons[action]; return svg;
  }
  function renderCollection() {
    $('target-collection-title').textContent = 'Saved targets' + (savedTargets.length ? ' · ' + savedTargets.length : '');
    $('target-collection-empty').hidden = Boolean(savedTargets.length);
    $('target-collection-list').replaceChildren(...savedTargets.map(target => {
      const li = node('li', 'target-saved-entry'), info = node('div', 'target-saved-info');
      info.append(node('h3', '', target.name), node('p', '', [target.context.company || 'Any company', target.questions.length + ' questions', windowLabel(target.context.window), target.context.difficulty || 'All difficulties', ...(target.context.topics || []), target.context.completionFilter !== 'all' ? target.context.completionFilter === 'solved' ? 'Solved' : 'Not solved' : '', new Date(target.updatedAt).toLocaleDateString()].filter(Boolean).join(' · ')));
      const actions = node('div', 'target-saved-actions');
      for (const [label, callback] of [['Open', () => openSaved(target)], ['Edit', () => startEdit(target, 'edit')], ['Clone', () => startEdit(target, 'clone')], ['CSV', () => download(target)], ['Remove', async button => {
        button.disabled = true;
        try {
          const result = await api.runtime.sendMessage({ type: 'LCT_TARGET_REMOVE', id: target.id });
          if (!result?.ok) throw new Error(result?.error || 'Could not remove saved Target.');
          if (editing?.entry.id === target.id) { editing = null; editBusy = null; renderEditor(); }
          if (currentSaved?.id === target.id) { currentSaved = null; renderActions(); void save(); }
          await loadCollection();
        } catch (error) { message(error.message, true); button.disabled = false; }
      }]]) {
        const button = node('button', 'target-saved-action'); button.type = 'button'; button.dataset.collectionAction = label;
        button.title = label === 'CSV' ? 'Download CSV' : label + ' collection';
        button.setAttribute('aria-label', button.title + ' · ' + target.name); button.append(collectionIcon(label));
        button.addEventListener('click', () => void callback(button)); actions.append(button);
      }
      li.append(info, actions); return li;
    }));
  }
  async function loadCollection() {
    const result = await api.runtime.sendMessage({ type: 'LCT_TARGET_LIST' });
    if (!result?.ok) throw new Error(result?.error || 'Could not load your saved targets.');
    savedTargets = result.targets || [];
    if (currentSaved && !savedTargets.some(target => target.id === currentSaved.id)) { currentSaved = null; renderActions(); void save(); }
    renderCollection();
  }
  async function saveCurrent(automatic = false) {
    if ((saving && !automatic) || currentSaved || !lastResult?.questions?.length) return;
    const resultRef = lastResult, id = generation, target = targetSnapshot();
    saving++; renderActions();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_TARGET_SAVE', target });
      if (!result?.ok) throw new Error(result?.error || 'Could not save your target.');
      if (id === generation && lastResult === resultRef) { currentSaved = result.target; await save(); }
      await loadCollection();
    } catch (error) { if (id === generation) message('Your questions are ready, but could not be saved. ' + error.message, true); }
    finally { saving--; renderActions(); }
  }
  function openSaved(target) {
    editing = null; editBusy = null;
    clearResults(); setKind(target.context.targetMode);
    if ($('window-select').value !== target.context.window) { $('window-select').value = target.context.window; $('window-select').dispatchEvent(new Event('change', { bubbles: true })); }
    $('target-company-search').value = ''; companyOptions();
    if (![...$('target-company').options].some(option => option.value === target.context.company) && target.context.company) $('target-company').append(new Option(target.context.company, target.context.company));
    $('target-company').value = target.context.company;
    $('target-difficulty').value = target.context.difficulty;
    $('target-status').value = target.context.completionFilter;
    const topic = target.context.topics[0] || '';
    if (topic && ![...$('target-topic').options].some(option => option.value === topic)) $('target-topic').append(new Option(topic, topic));
    $('target-topic').value = topic;
    if ([12, 20, 30, 50].includes(target.context.count)) $('target-count').value = String(target.context.count);
    for (const id of ['target-company', 'target-difficulty', 'target-topic', 'target-status', 'target-count']) controls.sync($(id));
    currentSaved = target; lastContext = target.context; hasPlan = kind === 'plan'; render(target);
    message('Saved target · ' + target.name + ' · ' + windowLabel(target.context.window) + ' · ' + new Date(target.createdAt).toLocaleDateString());
    void catalog(); void save();
  }
  function renderEditor() {
    $('target-editor').hidden = !editing;
    $('target-kind').hidden = Boolean(editing);
    $('target-generate').hidden = Boolean(editing);
    for (const id of ['target-random', 'target-plan']) $(id).disabled = Boolean(editing) || Boolean(initializing);
    if (!editing) return;
    const clone = editing.mode === 'clone';
    $('target-editor-title').textContent = clone ? 'Clone collection' : 'Edit collection';
    $('target-editor-help').textContent = clone ? 'Save an exact copy, or adjust the filters above and build a filtered copy.' : 'Adjust the filters above, then update this collection. Save name keeps the current questions.';
    $('target-rename').textContent = clone ? 'Save copy' : 'Save name';
    $('target-update').textContent = clone ? 'Build filtered copy' : 'Update collection';
    for (const id of ['target-name', 'target-rename', 'target-update']) $(id).disabled = Boolean(editBusy);
    $('target-cancel').disabled = editBusy === 'save';
  }
  function startEdit(entry, mode) {
    openSaved(entry); editing = { entry, mode }; editBusy = null;
    let name = entry.name;
    if (mode === 'clone') {
      const base = name.slice(0, 85); name = base + ' copy'; let suffix = 2;
      while (savedTargets.some(target => target.name === name)) name = base + ' copy ' + suffix++;
    }
    $('target-name').value = name; renderEditor(); renderActions();
    message(mode === 'clone' ? 'The original collection will be kept.' : 'Changes are saved only when you choose Save name or Update collection.');
    $('target-name').focus(); $('target-name').select();
  }
  async function commitEdit(state, name, target) {
    if (editing !== state) return;
    if (!name.trim()) { message('Enter a collection name.', true); $('target-name').focus(); return; }
    const stamp = generation; editBusy = 'save'; renderEditor();
    try {
      const result = await api.runtime.sendMessage({ type: state.mode === 'clone' ? 'LCT_TARGET_CLONE' : 'LCT_TARGET_UPDATE',
        id: state.entry.id, name, revision: state.entry.revision, ...(target ? { target } : {}) });
      if (!result?.ok) throw new Error(result?.error || 'Could not save collection changes.');
      await loadCollection();
      if (editing === state && stamp === generation) { openSaved(result.target); message(state.mode === 'clone' ? 'Created collection · ' + result.target.name : 'Updated collection · ' + result.target.name); }
    } catch (error) { if (editing === state) message(error.message + ' Your original collection has been kept.', true); }
    finally { if (editing === state) editBusy = null; renderEditor(); renderActions(); }
  }
  $('target-rename').addEventListener('click', () => { if (editing && !editBusy) void commitEdit(editing, $('target-name').value.trim()); });
  $('target-update').addEventListener('click', () => { if (editing && !editBusy) void generate(editing); });
  $('target-cancel').addEventListener('click', () => { if (editing && editBusy !== 'save') { const entry = savedTargets.find(target => target.id === editing.entry.id) || editing.entry; openSaved(entry); } });
  $('target-edit').addEventListener('click', () => { if (currentSaved) startEdit(currentSaved, 'edit'); });
  $('target-download').addEventListener('click', () => download(targetSnapshot()));
  $('target-save').addEventListener('click', () => void saveCurrent());
  function show(active) {
    if (active) invalidatePrivate();
    document.body.toggleAttribute('data-target', active); panel.hidden = !active; controls.close();
    $('mode-target').setAttribute('aria-selected', String(active)); $('mode-target').tabIndex = active ? 0 : -1;
    if (popup) { $('popup-browse').setAttribute('aria-selected', String(!active)); $('popup-browse').tabIndex = active ? -1 : 0; }
    else if (active) for (const id of ['mode-problems', 'mode-companies']) { $(id).setAttribute('aria-selected', 'false'); $(id).tabIndex = -1; }
    if (active) void initialize().catch(error => { companies = []; message(error.message + ' Switch tabs to retry.', true); });
    else { generation++; if (editBusy === 'generate') editBusy = null; renderEditor(); $('target-generate').disabled = false; panel.setAttribute('aria-busy', 'false'); }
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
  function invalidatePrivate() { if (!currentSaved && $('target-status').value !== 'all' && (lastResult || (visible() && panel.getAttribute('aria-busy') === 'true'))) { clearResults('Generate again to refresh your LeetCode status.'); $('target-generate').disabled = false; } }
  window.addEventListener('focus', invalidatePrivate); document.addEventListener('visibilitychange', () => { if (!document.hidden) invalidatePrivate(); });
  setInterval(() => { if (!document.hidden) invalidatePrivate(); }, 60000);
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lctTargetCollection && initialized) void loadCollection().catch(error => message(error.message, true));
    if (area === 'local' && changes.lctStatus && initialized && lastResult && !currentSaved && changes.lctStatus.newValue?.commit && changes.lctStatus.newValue.commit !== lastResult.sourceRevision) clearResults('Dataset updated. Generate a fresh target.'); });
  if (!popup && new URLSearchParams(location.search).get('mode') === 'target') show(true);
})();
