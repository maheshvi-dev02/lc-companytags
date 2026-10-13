(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const logos = globalThis.LCTCompanyLogos;
  const $ = id => document.getElementById(id);
  const defaults = { enabled: true, collapsed: false, window: 'all' };
  const windowLabels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  let settings = { ...defaults };
  let status = {};
  let companies = [];
  let slug = null;
  let activeTabId = null;
  let problem = null;
  let problemLoaded = false;
  let error = '';
  let loading = false;
  let requestId = 0;
  let companiesExpanded = false;
  let windowAvailable = false;
  let practiceCompany = null;
  let practiceQuestions = [];
  let practiceTotal = 0;
  let practiceAvailable = false;
  let practiceLoading = false;
  let practiceLoadingAll = false;
  let practiceHasMore = false;
  let practiceRevision = null;
  let practiceCompletion = null;
  let practiceCompletionRevision = null;
  let practiceRefreshScheduled = false;
  const completionTTL = 60_000;
  let practiceNeedsRetry = false;
  let practiceError = '';
  let practiceRequestId = 0;
  let practiceOpening = false;
  let practiceOpenError = '';
  let practiceOpenContext = '';
  let topicTimer;
  const previewCount = 5;
  const frequencyHelp = 'Scores come from the selected source window. They are not interview counts and may not be directly comparable between companies.';
  const selectedWindow = () => Object.hasOwn(windowLabels, settings.window) ? settings.window : 'all';

  const companySortOptions = [
    ['frequency-desc', 'Highest frequency'], ['frequency-asc', 'Lowest frequency'],
    ['name-asc', 'Company name A–Z'], ['name-desc', 'Company name Z–A']
  ];
  let companySort = 'frequency-desc';
  let companySortSave = Promise.resolve();
  let sortMenuOpen = false;
  let sortActiveIndex = 0;
  let sortTypeahead = '';
  let sortTypedAt = 0;
  const validCompanySort = value => companySortOptions.some(([key]) => key === value) ? value : 'frequency-desc';

  function closeCompanySort(returnFocus = false) {
    sortMenuOpen = false;
    $('company-sort-menu').hidden = true;
    $('company-sort-trigger').setAttribute('aria-expanded', 'false');
    $('company-sort-trigger').removeAttribute('aria-activedescendant');
    sortTypeahead = '';
    if (returnFocus) $('company-sort-trigger').focus();
  }
  function syncCompanySort() {
    $('company-sort-value').textContent = companySortOptions.find(([key]) => key === companySort)[1];
    $('company-sort-trigger').title = `Sort companies: ${$('company-sort-value').textContent}`;
    Array.from($('company-sort-menu').children).forEach(option => {
      option.setAttribute('aria-selected', String(option.dataset.value === companySort));
    });
  }
  function setSortActive(index) {
    const options = Array.from($('company-sort-menu').children);
    sortActiveIndex = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, i) => option.toggleAttribute('data-active', i === sortActiveIndex));
    const active = options[sortActiveIndex];
    $('company-sort-trigger').setAttribute('aria-activedescendant', active.id);
    const menu = $('company-sort-menu');
    if (active.offsetTop < menu.scrollTop) menu.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = active.offsetTop + active.offsetHeight - menu.clientHeight;
    }
  }
  function openCompanySort(edge) {
    const trigger = $('company-sort-trigger');
    if (trigger.hidden) return;
    const menu = $('company-sort-menu');
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 190), document.documentElement.clientWidth - 16);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upward = below < 160 && above > below;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(220, upward ? above : below))}px`;
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8))}px`;
    menu.style.top = `${upward ? Math.max(8, rect.top - 6 - menu.getBoundingClientRect().height) : rect.bottom + 6}px`;
    sortMenuOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.focus();
    setSortActive(edge === 'first' ? 0 : edge === 'last' ? companySortOptions.length - 1 : companySortOptions.findIndex(([key]) => key === companySort));
  }
  function changeCompanySort(value, save = false) {
    const next = validCompanySort(value);
    if (next === companySort) return;
    companySort = next;
    renderCompanies();
    $('companies').scrollTop = 0;
    if (save) {
      companySortSave = companySortSave.then(() => api.storage.local.set({ lctPopupCompanySort: next })).catch(() => {
        error = 'Could not save your sort preference. The current view still works.';
        renderStatus();
      });
    }
  }
  function pickCompanySort(option) {
    if (!option) return;
    closeCompanySort(true);
    changeCompanySort(option.dataset.value, true);
  }
  function setupCompanySort() {
    const menu = document.createElement('div');
    menu.id = 'company-sort-menu';
    menu.className = 'company-sort-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Sort companies');
    menu.hidden = true;
    menu.append(...companySortOptions.map(([value, label], index) => {
      const option = document.createElement('div');
      option.id = `company-sort-option-${index}`;
      option.className = 'company-sort-option';
      option.setAttribute('role', 'option');
      option.dataset.value = value;
      option.textContent = label;
      return option;
    }));
    document.body.append(menu);
    syncCompanySort();
    const trigger = $('company-sort-trigger');
    trigger.addEventListener('click', () => sortMenuOpen ? closeCompanySort() : openCompanySort());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Tab') { closeCompanySort(); return; }
      if (event.key === 'Escape') { if (sortMenuOpen) { event.preventDefault(); closeCompanySort(true); } return; }
      if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); closeCompanySort(true); return; }
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Enter' || event.key === ' ') {
          if (sortMenuOpen) pickCompanySort(menu.children[sortActiveIndex]);
          else openCompanySort();
        } else if (!sortMenuOpen) openCompanySort(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
        else setSortActive(event.key === 'Home' ? 0 : event.key === 'End' ? companySortOptions.length - 1 : sortActiveIndex + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!sortMenuOpen) openCompanySort();
        const now = Date.now();
        sortTypeahead = (now - sortTypedAt < 700 ? sortTypeahead : '') + event.key.toLocaleLowerCase();
        sortTypedAt = now;
        const repeated = Array.from(sortTypeahead).every(letter => letter === sortTypeahead[0]);
        const prefix = repeated ? sortTypeahead[0] : sortTypeahead;
        const start = repeated ? sortActiveIndex + 1 : sortActiveIndex;
        for (let step = 0; step < companySortOptions.length; step++) {
          const index = (start + step) % companySortOptions.length;
          if (companySortOptions[index][1].toLocaleLowerCase().startsWith(prefix)) { setSortActive(index); break; }
        }
      }
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[role="option"]');
      if (option?.parentNode === menu) pickCompanySort(option);
    });
    menu.addEventListener('pointermove', event => {
      const option = event.target.closest('[role="option"]');
      if (option?.parentNode === menu) setSortActive(Array.from(menu.children).indexOf(option));
    });
    document.addEventListener('pointerdown', event => {
      if (sortMenuOpen && !trigger.contains(event.target) && !menu.contains(event.target)) closeCompanySort();
    });
    document.addEventListener('focusin', event => {
      if (sortMenuOpen && event.target !== trigger && !menu.contains(event.target)) closeCompanySort();
    });
    window.addEventListener('resize', () => closeCompanySort());
    window.addEventListener('scroll', event => {
      if (sortMenuOpen && !menu.contains(event.target)) closeCompanySort();
    }, true);
  }

  const selectMenus = globalThis.LCTSelectControls.create();
  const practiceSortOptions = [
    ['frequency-desc', 'Highest frequency'], ['frequency-asc', 'Lowest frequency'],
    ['name-asc', 'Title A–Z'], ['name-desc', 'Title Z–A'],
    ['difficulty-asc', 'Easy → hard'], ['difficulty-desc', 'Hard → easy'],
    ['companies-desc', 'Most companies'], ['companies-asc', 'Fewest companies']
  ];
  let practiceSort = 'frequency-desc';
  let practiceSortSave = Promise.resolve();
  const validPracticeSort = value => practiceSortOptions.some(([key]) => key === value) ? value : 'frequency-desc';
  const practiceOrderLabel = () => practiceSortOptions.find(([key]) => key === practiceSort)[1];
  const practiceCompletionFilter = () => ['solved', 'not-solved'].includes($('practice-status-select').value)
    ? $('practice-status-select').value : 'all';
  function syncPracticeSort() {
    $('practice-sort-select').value = practiceSort;
    selectMenus.sync($('practice-sort-select'));
  }
  function changePracticeSort() {
    const next = validPracticeSort($('practice-sort-select').value);
    if (next === practiceSort) return;
    practiceSort = next;
    syncPracticeSort();
    void loadPractice();
    practiceSortSave = practiceSortSave.then(() => api.storage.local.set({ lctPopupPracticeSort: next })).catch(() => {
      practiceError = 'Could not save your sort preference. The current view still works.';
      renderPracticeSummary();
    });
  }

  let acceptanceHelpId = 0;
  function closeAcceptanceHelp(except = null) {
    document.querySelectorAll('.acceptance-rate[aria-expanded="true"]').forEach(button => {
      if (button === except) return;
      button.setAttribute('aria-expanded', 'false');
      const help = document.getElementById(button.getAttribute('aria-controls'));
      if (help) help.hidden = true;
    });
  }
  function acceptanceInfo(value) {
    const formatted = core.formatAcceptanceRate(value);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'acceptance-rate';
    button.textContent = formatted === null ? 'Acceptance unavailable' : `Acceptance ${formatted}`;
    const help = document.createElement('span');
    help.className = 'acceptance-help';
    help.id = `acceptance-help-${++acceptanceHelpId}`;
    help.textContent = core.ACCEPTANCE_TOOLTIP + (formatted === null ? ' No valid acceptance rate is available in the saved dataset.' : '');
    help.hidden = true;
    button.title = help.textContent;
    button.dataset.acceptanceControl = '';
    help.dataset.acceptanceControl = '';
    button.setAttribute('aria-describedby', help.id);
    button.setAttribute('aria-controls', help.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      const show = help.hidden;
      closeAcceptanceHelp(button);
      help.hidden = !show;
      button.setAttribute('aria-expanded', String(show));
    });
    return { button, help };
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-acceptance-control]')) closeAcceptanceHelp();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAcceptanceHelp();
  });

  function dateLabel(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function safeSource(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith('/liquidslr/leetcode-company-wise-problems/')) return parsed.href;
    } catch (_) { /* Use the known repository link. */ }
    return core.SOURCE_URL;
  }

  function renderCompanies() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const ordered = core.sortCompanies(companies, companySort);
    const filtered = ordered.filter(company => company.name.toLocaleLowerCase().includes(query));
    const shown = query || companiesExpanded ? filtered : filtered.slice(0, previewCount);
    $('companies').toggleAttribute('data-scrollable', shown.length > previewCount);
    const hasFrequency = companies.some(company => Number.isFinite(company.frequency) && company.frequency >= 0);
    $('frequency-heading').hidden = companies.length === 0;
    $('company-tools').hidden = companies.length === 0;
    $('company-sort-trigger').hidden = companies.length < 2;
    if (companies.length < 2) closeCompanySort();
    syncCompanySort();
    $('companies').setAttribute('aria-label', `Companies listed for this problem, sorted by ${companySortOptions.find(([key]) => key === companySort)[1].toLocaleLowerCase()}`);
    $('frequency-heading').textContent = hasFrequency ? 'Frequency score' : 'Frequency unavailable';
    $('frequency-heading').title = hasFrequency ? frequencyHelp : `Refresh to check for frequency scores. ${frequencyHelp}`;
    $('frequency-heading').setAttribute('aria-label', `${$('frequency-heading').textContent}. ${$('frequency-heading').title}`);
    $('show-companies').hidden = Boolean(query) || companies.length <= previewCount;
    $('show-companies').setAttribute('aria-expanded', String(companiesExpanded));
    $('show-companies-label').textContent = companiesExpanded ? 'Show fewer' : `Show all ${companies.length} companies`;
    $('companies').replaceChildren(...shown.map((company, index) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const companyName = document.createElement('span');
      companyName.className = 'company-name';
      companyName.textContent = company.name;
      const knownFrequency = Number.isFinite(company.frequency) && company.frequency >= 0;
      const frequency = document.createElement('span');
      frequency.className = 'frequency-score';
      frequency.textContent = knownFrequency ? String(company.frequency) : '—';
      frequency.id = `company-frequency-${index}`;
      frequency.title = knownFrequency ? `Frequency score: ${company.frequency}` : 'Frequency score unavailable';
      frequency.setAttribute('aria-label', frequency.title);
      const companyInfo = document.createElement('span');
      companyInfo.className = 'company-info';
      const rank = document.createElement('span');
      rank.className = 'company-rank';
      rank.textContent = Number.isInteger(company.rank) && company.rank > 0 ? `Company rank #${company.rank}` : 'Rank unavailable';
      rank.title = `This problem’s frequency rank within ${company.name} for ${windowLabels[selectedWindow()].toLowerCase()}. Equal scores share a rank.`;
      companyInfo.append(companyName, rank);
      const identity = document.createElement('span');
      identity.className = 'company-identity';
      identity.append(logos.createBadge(company.name), companyInfo);
      link.append(identity, frequency);
      link.href = safeSource(company.sourceUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${company.name}, view source`);
      link.setAttribute('aria-describedby', frequency.id);
      const practiceButton = document.createElement('button');
      practiceButton.type = 'button';
      practiceButton.className = 'practice-company';
      practiceButton.textContent = 'Practice';
      practiceButton.setAttribute('aria-label', `Practice ${company.name}`);
      practiceButton.dataset.company = company.name;
      practiceButton.addEventListener('click', () => openPractice(company.name));
      item.append(link, practiceButton);
      return item;
    }));
    $('search-wrap').hidden = companies.length < 6 && !query;
    renderCompanyMessage(filtered.length > 0);
  }

  function renderCompanyMessage(hasMatches = $('companies').childElementCount > 0) {
    const query = $('search').value.trim();
    $('empty').hidden = !slug || hasMatches;
    if (query && companies.length) $('empty').textContent = 'No company names match your search.';
    else if (loading && !status.hasData) $('empty').textContent = 'Loading company tags…';
    else if (!status.hasData && status.phase === 'syncing') $('empty').textContent = 'Preparing company tags…';
    else if (!windowAvailable) $('empty').textContent = status.phase === 'syncing' ? 'This time window is syncing. It will appear when the updated dataset is ready.' : 'This time window is not downloaded yet. Refresh to load it.';
    else $('empty').textContent = 'No company matches in this dataset. Coverage may be incomplete.';
  }

  function renderStatus() {
    const revision = /^[a-f0-9]{40}$/i.test(status.commit || '') ? status.commit : '';
    $('source').href = revision ? `${core.SOURCE_URL.replace(/\/$/, '')}/tree/${revision}` : core.SOURCE_URL;
    $('source').title = revision ? `Dataset revision ${revision.slice(0, 7)}` : 'Public company dataset';
    const syncedDate = new Date(status.lastSyncedAt);
    $('status').title = status.lastSyncedAt && Number.isFinite(syncedDate.getTime()) ? `Last synced: ${syncedDate.toLocaleString()}` : '';
    const snapshot = status.dataSource === 'bundled' ? 'Bundled snapshot · ' : '';
    $('window-note').textContent = status.sourceUpdatedAt ? `${snapshot}Windows relative to source updated ${dateLabel(status.sourceUpdatedAt)}` : 'Time windows follow the dates in the source dataset.';
    const failure = error || (status.phase === 'error' ? status.message || 'Refresh failed. Check your connection and try again.' : '');
    const stale = status.lastCheckedAt && Date.now() - new Date(status.lastCheckedAt).getTime() > 48 * 60 * 60 * 1000;
    $('dataset-state').textContent = status.phase === 'syncing' ? 'Syncing' : failure ? 'Needs attention' : stale ? 'Saved data' : status.hasData ? 'Ready' : 'Not synced';
    $('dataset-state').dataset.state = status.phase === 'syncing' ? 'syncing' : failure || stale ? 'warning' : status.hasData ? 'ready' : 'idle';
    $('dataset-state').toggleAttribute('data-warning', Boolean(failure || stale));
    $('dataset-summary').textContent = status.hasData ? `${Number(status.companyCount || 0).toLocaleString()} companies · ${Number(status.problemCount || 0).toLocaleString()} problems indexed` : 'Live data from liquidslr’s public GitHub repository.';
    $('status').toggleAttribute('data-warning', Boolean(failure || stale));
    if (failure) $('status').textContent = `${status.hasData ? 'Showing saved data. ' : ''}${failure}`;
    else if (status.phase === 'syncing') $('status').textContent = status.total > 0 ? `${snapshot}Syncing dataset · ${status.completed || 0} of ${status.total}` : `${snapshot}Checking the latest dataset…`;
    else if (stale) $('status').textContent = `${snapshot}Last checked ${dateLabel(status.lastCheckedAt)}. Refresh for updates.`;
    else if (status.sourceUpdatedAt) $('status').textContent = `${snapshot}Source updated ${dateLabel(status.sourceUpdatedAt)} · checked ${dateLabel(status.lastCheckedAt || status.lastSyncedAt)}`;
    else if (status.lastCheckedAt || status.lastSyncedAt) $('status').textContent = `${snapshot}Last checked ${dateLabel(status.lastCheckedAt || status.lastSyncedAt)}`;
    else $('status').textContent = 'Refresh to save the latest company index for offline use.';
    $('refresh').disabled = status.phase === 'syncing';
    $('refresh').textContent = status.phase === 'syncing' ? 'Syncing…' : 'Refresh dataset';
    $('progress').hidden = status.phase !== 'syncing';
    if (status.total > 0) {
      $('progress').max = status.total;
      $('progress').value = Math.min(status.completed || 0, status.total);
    } else $('progress').removeAttribute('value');
    renderCompanyMessage();
    renderPracticeSummary();
  }

  function render() {
    $('enabled').checked = settings.enabled;
    const title = typeof problem?.title === 'string' && problem.title.trim() ? problem.title : core.formatProblemTitle(slug);
    $('problem-title').textContent = slug ? title : 'Open a LeetCode problem';
    renderProblemAcceptance();
    $('problem-summary').textContent = slug ? `${companies.length} ${companies.length === 1 ? 'company' : 'companies'} · ${windowLabels[selectedWindow()].toLowerCase()}` : 'Company tags appear as you browse problem pages.';
    $('window-select').value = selectedWindow();
    selectMenus.sync($('window-select'));
    $('company-view').hidden = Boolean(practiceCompany);
    $('practice-view').hidden = !practiceCompany;
    $('open-problems').hidden = Boolean(slug);
    renderCompanies();
    renderPractice();
    renderStatus();
  }

  function renderProblemAcceptance() {
    const line = $('problem-acceptance');
    line.hidden = !slug || !problemLoaded;
    line.replaceChildren();
    if (line.hidden) return;
    const acceptance = acceptanceInfo(problem?.acceptanceRate);
    line.append(acceptance.button, acceptance.help);
  }

  function resetWindow() {
    closeCompanySort();
    selectMenus.close();
    requestId++;
    companies = [];
    problem = null;
    problemLoaded = false;
    windowAvailable = false;
    companiesExpanded = false;
    error = '';
    if (practiceCompany) { practiceRequestId++; practiceLoading = false; practiceLoadingAll = false; clearPracticeQuestions(); }
    render();
    void load();
    if (practiceCompany) void loadPractice();
  }

  function openPractice(company) {
    practiceOpenError = '';
    closeCompanySort();
    selectMenus.close();
    practiceRequestId++;
    practiceLoading = false;
    practiceLoadingAll = false;
    clearPracticeQuestions();
    practiceCompany = company;
    $('difficulty-select').value = '';
    selectMenus.sync($('difficulty-select'));
    $('topic-input').value = '';
    render();
    $('back-companies').focus();
    void loadPractice();
  }

  function practiceContext() {
    return JSON.stringify([practiceCompany, selectedWindow(), $('difficulty-select').value, $('topic-input').value.trim(), practiceSort, practiceCompletionFilter(), slug]);
  }

  function clearPracticeQuestions() {
    practiceQuestions = [];
    practiceTotal = 0;
    practiceAvailable = false;
    practiceHasMore = false;
    practiceRevision = null;
    practiceCompletion = null;
    practiceCompletionRevision = null;
    practiceNeedsRetry = false;
    practiceError = '';
    renderPracticeRows([]);
  }

  function renderPracticeSummary() {
    if (!practiceCompany) return;
    const summary = $('practice-summary');
    const count = Number.isInteger(practiceTotal) ? `${practiceQuestions.length} of ${practiceTotal} questions` : '';
    renderPracticeCompletionStatus();
    if (practiceError) summary.textContent = `${practiceQuestions.length ? count + ' · ' : ''}${practiceError}`;
    else if (practiceLoading) summary.textContent = practiceQuestions.length
      ? `${count} · ${practiceLoadingAll ? 'Loading all questions…' : 'Loading more…'}` : 'Loading practice questions…';
    else if (!practiceAvailable) summary.textContent = status.phase === 'syncing' ? 'Practice questions are syncing for this window.' : 'Practice questions are not downloaded for this window. Refresh the dataset.';
    else if (practiceCompletionFilter() !== 'all' && practiceCompletion?.state !== 'ready') summary.textContent = 'Completion status unavailable.';
    else if (!practiceTotal) summary.textContent = 'No questions match these filters in this time window.';
    else {
      const order = practiceSort === 'frequency-desc' && !practiceQuestions.some(question => Number.isFinite(question.frequency) && question.frequency >= 0)
        ? 'frequency unavailable' : practiceOrderLabel().toLocaleLowerCase();
      summary.textContent = `${count} · ${order}`;
    }
    const more = $('practice-load-more'), all = $('practice-show-all'), retry = $('practice-retry');
    const focusedControl = [more, all, retry].includes(document.activeElement);
    more.hidden = all.hidden = !practiceHasMore;
    retry.hidden = !practiceNeedsRetry;
    $('practice-pagination').hidden = !practiceHasMore && !practiceNeedsRetry;
    more.disabled = all.disabled = retry.disabled = practiceLoading;
    more.textContent = practiceLoading && !practiceLoadingAll ? 'Loading…' : 'Load more';
    all.textContent = practiceLoadingAll ? 'Loading all…' : `Show all ${practiceTotal ?? ''} questions`;
    retry.textContent = practiceCompletionFilter() !== 'all' && practiceCompletion?.state !== 'ready' ? 'Retry status' : 'Reload questions';
    $('practice-questions').setAttribute('aria-label', practiceCompany + ' questions sorted by ' + practiceOrderLabel().toLocaleLowerCase());
    $('practice-questions').setAttribute('aria-busy', String(practiceLoading));
    $('practice-pagination').setAttribute('aria-busy', String(practiceLoading));
    if (focusedControl && !practiceHasMore && !practiceNeedsRetry && practiceQuestions.length) {
      $('practice-questions').focus({ preventScroll: true });
    } else if (focusedControl && practiceNeedsRetry && !practiceLoading) {
      retry.focus({ preventScroll: true });
    } else if (focusedControl && retry.hidden && practiceHasMore && !practiceLoading) {
      more.focus({ preventScroll: true });
    }
  }

  function renderPracticeCompletionStatus() {
    const line = $('practice-completion-status');
    line.hidden = practiceCompletionFilter() === 'all';
    if (line.hidden) { line.textContent = ''; return; }
    const state = practiceLoading && !practiceCompletion ? 'checking' : practiceCompletion?.state;
    line.dataset.state = state || 'unavailable';
    const unknown = Number.isInteger(practiceCompletion?.unknownCount) && practiceCompletion.unknownCount > 0
      ? practiceCompletion.unknownCount : 0;
    line.textContent = state === 'checking' ? 'Checking LeetCode completion status…'
      : state === 'signed-out' ? 'Sign in to LeetCode, then retry. All problems remains available.'
      : state === 'no-tab' ? 'Open a signed-in LeetCode tab, then retry. All problems remains available.'
      : state === 'ready' ? (unknown ? `${unknown} ${unknown === 1 ? 'problem has' : 'problems have'} unknown status and ${unknown === 1 ? 'is' : 'are'} excluded from this filter.` : '')
      : 'Could not check completion status. Refresh your LeetCode tab, then retry. All problems remains available.';
    line.hidden ||= !line.textContent;
  }

  function completionIndicator() {
    const indicator = document.createElement('span');
    indicator.className = 'completion-indicator';
    indicator.title = 'Completed on LeetCode';
    indicator.setAttribute('role', 'img');
    indicator.setAttribute('aria-label', 'Completed on LeetCode');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9');
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    check.setAttribute('d', 'm7.5 12 3 3 6-6');
    icon.append(circle, check); indicator.append(icon);
    return indicator;
  }

  function renderPracticeRows(questions, append = false) {
    const list = $('practice-questions');
    const scroll = list.scrollTop;
    const items = questions.map(question => {
      const item = document.createElement('li');
      item.dataset.slug = question.slug;
      const link = document.createElement('a');
      link.href = `https://leetcode.com/problems/${encodeURIComponent(question.slug)}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const title = document.createElement('span');
      title.className = 'question-title';
      title.textContent = question.title;
      const titleLine = document.createElement('span');
      titleLine.className = 'question-title-line';
      titleLine.append(title);
      if (question.completed === true) titleLine.append(completionIndicator());
      link.append(titleLine);
      if (question.slug === slug) {
        const current = document.createElement('span');
        current.className = 'current-problem';
        current.textContent = 'Current problem';
        titleLine.append(current);
      }
      const score = Number.isFinite(question.frequency) && question.frequency >= 0 ? String(question.frequency) : 'unavailable';
      const rank = Number.isInteger(question.rank) && question.rank > 0 ? `company rank #${question.rank}` : 'rank unavailable';
      const meta = document.createElement('span');
      meta.className = 'question-meta';
      const acceptance = acceptanceInfo(question.acceptanceRate);
      meta.append(document.createTextNode(`${question.difficulty || 'Difficulty unavailable'} · `), acceptance.button, document.createTextNode(` · score ${score} · ${rank}`));
      if (practiceSort === 'companies-desc' || practiceSort === 'companies-asc') {
        const count = Number.isInteger(question.companyCount) && question.companyCount >= 0
          ? question.companyCount + ' ' + (question.companyCount === 1 ? 'company' : 'companies') : 'Company count unavailable';
        const companies = document.createElement('span');
        companies.className = 'question-company-count';
        companies.textContent = count;
        companies.title = 'Number of companies listing this problem in the selected time window.';
        meta.append(document.createTextNode(' · '), companies);
      }
      item.append(link, meta, acceptance.help);
      if (Array.isArray(question.topics) && question.topics.length) {
        const topics = document.createElement('span');
        topics.className = 'question-topics';
        topics.textContent = question.topics.slice(0, 3).join(' · ');
        topics.title = question.topics.join(', ');
        item.append(topics);
      }
      return item;
    });
    if (append) list.append(...items); else list.replaceChildren(...items);
    list.scrollTop = append ? scroll : 0;
  }

  function renderPracticeOpenState() {
    if (practiceOpenContext !== practiceContext()) practiceOpenError = '';
    const button = $('expand-practice');
    button.disabled = practiceOpening || !practiceCompany;
    button.setAttribute('aria-busy', String(practiceOpening));
    $('practice-open-status').textContent = practiceOpenError;
    $('practice-open-status').hidden = !practiceOpenError;
  }

  async function expandPractice() {
    if (!practiceCompany || practiceOpening) return;
    const context = practiceContext();
    const request = { type: 'LCT_OPEN_EXPLORER', mode: 'companies', company: practiceCompany,
      window: selectedWindow(), difficulty: $('difficulty-select').value,
      topic: $('topic-input').value.trim(), sort: practiceSort, completionFilter: practiceCompletionFilter() };
    selectMenus.close();
    closeCompanySort();
    practiceOpening = true;
    practiceOpenError = '';
    practiceOpenContext = context;
    renderPracticeOpenState();
    try {
      const result = await api.runtime.sendMessage(request);
      if (!result?.ok) throw new Error('Explorer unavailable');
    } catch (_) {
      // An old request must not add feedback to a different company's filters.
      if (practiceCompany && context === practiceContext()) practiceOpenError = 'Could not open Company Lens. Try again.';
    } finally {
      practiceOpening = false;
      renderPracticeOpenState();
    }
  }

  function renderPractice() {
    renderPracticeOpenState();
    if (!practiceCompany) return;
    syncPracticeSort();
    selectMenus.sync($('difficulty-select'));
    selectMenus.sync($('practice-status-select'));
    $('practice-title').textContent = practiceCompany;
    $('practice-heading').replaceChildren(logos.createBadge(practiceCompany), $('practice-title'));
    renderPracticeSummary();
  }

  function practiceSourceRevision(result) {
    if (typeof result.sourceRevision === 'string' && result.sourceRevision) return result.sourceRevision;
    // The source link is made from the actual data revision. It is more reliable
    // than status, which can be sampled immediately before a dataset publication.
    if (typeof result.sourceUrl === 'string') {
      try {
        const source = new URL(result.sourceUrl);
        if (source.protocol === 'https:' && source.hostname === 'github.com' &&
            /^\/liquidslr\/leetcode-company-wise-problems\/blob\/[a-f0-9]{40}\//i.test(source.pathname)) return source.href;
      } catch (_) { /* Fall back to the response status revision. */ }
    }
    return core.SHA_PATTERN.test(result.status?.commit || '') ? `commit:${result.status.commit.toLowerCase()}` : null;
  }

  function practiceRestart(message) {
    const cause = new Error(message);
    cause.restartPractice = true;
    return cause;
  }

  function completionFingerprint(completion) {
    if (completion?.state !== 'ready' || typeof completion.sessionKey !== 'string' || !completion.sessionKey ||
        typeof completion.revision !== 'string' || !completion.revision ||
        !['https://leetcode.com', 'https://www.leetcode.com', 'https://leetcode.cn', 'https://www.leetcode.cn'].includes(completion.site)) return null;
    return JSON.stringify([completion.sessionKey, completion.revision, completion.site]);
  }

  async function loadPractice({ append = false, all = false, refreshCompletion = false } = {}) {
    if (!practiceCompany || (append && (practiceLoading || !practiceHasMore))) return;
    clearTimeout(topicTimer);
    selectMenus.close();
    const id = ++practiceRequestId;
    const context = practiceContext();
    const request = { type: 'LCT_PRACTICE', company: practiceCompany, window: selectedWindow(), sort: practiceSort, completionFilter: practiceCompletionFilter() };
    if ($('difficulty-select').value) request.difficulty = $('difficulty-select').value;
    if ($('topic-input').value.trim()) request.topic = $('topic-input').value.trim();
    const current = () => id === practiceRequestId && Boolean(practiceCompany) && context === practiceContext();
    if (!append) clearPracticeQuestions();
    practiceLoading = true;
    practiceLoadingAll = all;
    practiceNeedsRetry = false;
    practiceError = '';
    renderPractice();
    let restarted = false;
    try {
      while (current()) {
        const offset = practiceQuestions.length;
        const result = await api.runtime.sendMessage({ ...request, offset, limit: all ? 100 : 20,
          ...(request.completionFilter !== 'all' && refreshCompletion && offset === 0 ? { refreshCompletion: true } : {}) });
        refreshCompletion = false;
        if (!current()) return;
        if (!result?.ok) throw new Error(result?.error || 'Could not load practice questions. Try again.');
        const revision = practiceSourceRevision(result);
        const filtered = request.completionFilter !== 'all';
        const nextCompletionRevision = filtered ? completionFingerprint(result.completion) : null;
        if (filtered && result.completion?.state !== 'ready') {
          clearPracticeQuestions();
          practiceCompletion = result.completion || { state: 'unavailable' };
          practiceTotal = null;
          practiceAvailable = result.available !== false;
          practiceNeedsRetry = true;
          break;
        }
        if (filtered && !nextCompletionRevision) throw practiceRestart('Completion status changed. Reload questions to check your current account.');
        if (offset > 0 && ((!practiceRevision || !revision || revision !== practiceRevision) ||
            (filtered && nextCompletionRevision !== practiceCompletionRevision))) {
          if (restarted) throw practiceRestart('This question list changed again. Reload questions to use the latest status.');
          restarted = true;
          clearPracticeQuestions();
          practiceLoading = true; practiceLoadingAll = all;
          renderPracticeSummary();
          continue;
        }
        if (offset > 0 && result.available === false) {
          throw practiceRestart('This time window changed. Reload questions to check its availability.');
        }
        const questions = Array.isArray(result.questions) ? result.questions : [];
        const total = Number(result.total);
        const known = new Set(practiceQuestions.map(question => question.slug));
        const seen = new Set();
        const invalidQuestion = questions.some(question => {
          if (!question || typeof question.slug !== 'string' || !core.SLUG_PATTERN.test(question.slug) ||
              known.has(question.slug) || seen.has(question.slug) || (filtered &&
                question.completed !== (request.completionFilter === 'solved'))) return true;
          seen.add(question.slug);
          return false;
        });
        if (!Number.isInteger(total) || total < offset + questions.length ||
            (result.offset !== undefined && result.offset !== offset) || invalidQuestion ||
            (result.available !== false && Boolean(result.hasMore) !== (offset + questions.length < total))) {
          throw new Error('Could not continue this question list. Try again.');
        }
        if (questions.length === 0 && (result.hasMore || total > offset)) {
          throw new Error('No questions were returned for this page. Try again.');
        }
        practiceQuestions.push(...questions);
        practiceTotal = total;
        practiceAvailable = result.available !== false;
        practiceHasMore = Boolean(result.hasMore) && practiceQuestions.length < practiceTotal;
        practiceRevision = revision;
        practiceCompletion = filtered ? result.completion : null;
        practiceCompletionRevision = nextCompletionRevision;
        renderPracticeRows(questions, offset > 0);
        renderPracticeSummary();
        // Each page advances the offset; an empty or rejected page stops above.
        if (!all || !practiceHasMore) break;
      }
    } catch (cause) {
      if (!current()) return;
      if (request.completionFilter !== 'all') {
        const available = practiceAvailable;
        clearPracticeQuestions();
        practiceAvailable = available;
        practiceTotal = null;
        practiceCompletion = { state: 'unavailable' };
      } else if (cause.restartPractice) clearPracticeQuestions();
      practiceError = cause.message || 'Could not load practice questions. Try again.';
      practiceNeedsRetry = practiceQuestions.length === 0;
    } finally {
      if (current()) {
        practiceLoading = false;
        practiceLoadingAll = false;
        renderPracticeSummary();
      }
    }
  }

  function refreshPracticeCompletion() {
    if (!practiceCompany || practiceCompletionFilter() === 'all' || document.hidden || practiceRefreshScheduled) return;
    // Invalidate the displayed account snapshot before any asynchronous request.
    practiceRequestId++;
    practiceLoading = false; practiceLoadingAll = false;
    clearPracticeQuestions();
    practiceLoading = true;
    renderPracticeSummary();
    practiceRefreshScheduled = true;
    Promise.resolve().then(() => {
      practiceRefreshScheduled = false;
      if (practiceCompany && practiceCompletionFilter() !== 'all' && !document.hidden) void loadPractice({ refreshCompletion: true });
    });
  }

  async function load() {
    const id = ++requestId;
    loading = true;
    problem = null;
    problemLoaded = false;
    renderProblemAcceptance();
    renderStatus();
    try {
      const result = await api.runtime.sendMessage(slug ? { type: 'LCT_GET', slug, window: selectedWindow() } : { type: 'LCT_STATUS' });
      if (id !== requestId) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load the dataset. Try Refresh.');
      status = result.status || status;
      if (Array.isArray(result.companies)) companies = result.companies;
      problem = result.problem && typeof result.problem === 'object' ? result.problem : null;
      problemLoaded = Boolean(slug);
      windowAvailable = result.available ?? Boolean(result.status?.hasData && selectedWindow() === 'all');
      error = '';
    } catch (cause) {
      if (id !== requestId) return;
      error = cause.message || 'Could not connect. Check your connection and try again.';
    } finally {
      if (id === requestId) { loading = false; render(); }
    }
  }

  $('explore-dataset').addEventListener('click', async () => {
    const button = $('explore-dataset');
    button.disabled = true;
    try {
      const query = $('search').value.trim();
      const result = await api.runtime.sendMessage({ type: 'LCT_OPEN_EXPLORER', mode: query ? 'companies' : 'problems', query });
      if (!result?.ok) throw new Error(result?.error || 'Could not open the dataset explorer.');
    } catch (cause) {
      error = cause.message || 'Could not open the dataset explorer.';
      renderStatus();
    } finally { button.disabled = false; }
  });
  $('expand-practice').addEventListener('click', () => void expandPractice());
  $('search').addEventListener('input', renderCompanies);
  $('window-select').addEventListener('change', () => {
    settings.window = $('window-select').value;
    resetWindow();
    api.storage.local.set({ lctSettings: settings }).catch(() => { error = 'Could not save your time window preference.'; render(); });
  });
  $('back-companies').addEventListener('click', () => {
    selectMenus.close();
    const previousCompany = practiceCompany;
    practiceCompany = null;
    practiceRequestId++;
    practiceLoading = false;
    practiceLoadingAll = false;
    clearTimeout(topicTimer);
    clearPracticeQuestions();
    render();
    const returnButton = Array.from($('companies').querySelectorAll('.practice-company')).find(button => button.dataset.company === previousCompany);
    (returnButton || $('window-select-trigger')).focus();
  });
  $('difficulty-select').addEventListener('change', () => void loadPractice());
  $('practice-sort-select').addEventListener('change', changePracticeSort);
  $('practice-status-select').addEventListener('change', () => void loadPractice());
  $('practice-load-more').addEventListener('click', () => void loadPractice({ append: true }));
  $('practice-show-all').addEventListener('click', () => void loadPractice({ append: true, all: true }));
  $('practice-retry').addEventListener('click', () => void loadPractice({ refreshCompletion: true }));
  $('topic-input').addEventListener('input', () => {
    clearTimeout(topicTimer);
    practiceRequestId++;
    practiceLoading = true;
    practiceLoadingAll = false;
    clearPracticeQuestions();
    renderPractice();
    topicTimer = setTimeout(() => void loadPractice(), 250);
  });
  $('show-companies').addEventListener('click', () => {
    companiesExpanded = !companiesExpanded;
    renderCompanies();
    if (!companiesExpanded) $('companies').scrollTop = 0;
  });
  $('enabled').addEventListener('change', async () => {
    const previousEnabled = settings.enabled;
    settings.enabled = $('enabled').checked;
    try { await api.storage.local.set({ lctSettings: settings }); }
    catch (_) { settings.enabled = previousEnabled; error = 'Could not save your display preference. Try again.'; render(); }
  });
  $('refresh').addEventListener('click', async () => {
    error = '';
    status = { ...status, phase: 'syncing', total: 0, completed: 0 };
    renderStatus();
    try {
      const result = await api.runtime.sendMessage({ type: 'LCT_REFRESH' });
      if (!result?.ok) throw new Error(result?.error || 'Refresh failed. Check your connection and try again.');
      status = result.status || status;
      await load();
      if (practiceCompany) await loadPractice();
    } catch (cause) {
      status = { ...status, phase: 'error' };
      error = cause.message || 'Refresh failed. Check your connection and try again.';
      renderStatus();
    }
  });
  api.storage.onChanged.addListener((changes, area) => {
    // The open popup owns its selected order. Read the saved preference on the
    // next open; delayed echoes from our queued writes must not undo a newer choice.
    if (area !== 'local' || (!changes.lctSettings && !changes.lctStatus && !changes.lctData)) return;
    if (changes.lctSettings) {
      const previousWindow = selectedWindow();
      settings = { ...defaults, ...changes.lctSettings.newValue };
      $('enabled').checked = settings.enabled;
      if (previousWindow !== selectedWindow()) resetWindow();
    }
    let dataChanged = Boolean(changes.lctData?.newValue);
    if (changes.lctStatus) {
      const previous = status;
      status = changes.lctStatus.newValue || {};
      if (status.phase !== 'error') error = '';
      dataChanged ||= Boolean(status.hasData && (!previous.hasData || status.commit !== previous.commit || status.lastSyncedAt !== previous.lastSyncedAt));
      // Status-only changes leave company and practice DOM nodes intact.
      renderStatus();
    }
    if (dataChanged) {
      void load();
      if (practiceCompany) void loadPractice();
    }
  });

  api.tabs.onUpdated?.addListener((tabId, change) => {
    if (tabId !== activeTabId || typeof change.url !== 'string') return;
    const nextSlug = core.getProblemSlug(change.url);
    if (nextSlug === slug) return;
    slug = nextSlug;
    $('search').value = '';
    resetWindow();
  });

  window.addEventListener('focus', refreshPracticeCompletion);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPracticeCompletion(); });
  setInterval(refreshPracticeCompletion, completionTTL);

  async function start() {
    try {
      const stored = await api.storage.local.get(['lctSettings', 'lctStatus', 'lctPopupCompanySort', 'lctPopupPracticeSort']);
      settings = { ...settings, ...stored.lctSettings };
      status = stored.lctStatus || {};
      companySort = validCompanySort(stored.lctPopupCompanySort);
      practiceSort = validPracticeSort(stored.lctPopupPracticeSort);
    } catch (_) { /* The background request will report a usable error if needed. */ }
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id !== undefined) {
        activeTabId = tabs[0].id;
        const contextRequest = requestId;
        const context = await api.tabs.sendMessage(tabs[0].id, { type: 'LCT_CONTEXT' });
        if (contextRequest === requestId) slug = typeof context?.slug === 'string' ? context.slug : null;
      }
    } catch (_) { /* Other sites and tabs opened before installation have no content script. */ }
    render();
    await load();
  }
  setupCompanySort();
  selectMenus.enhance(['window-select', 'difficulty-select', 'practice-status-select', 'practice-sort-select'], { iconIds: ['practice-sort-select'] });
  syncPracticeSort();
  void start();
})();
