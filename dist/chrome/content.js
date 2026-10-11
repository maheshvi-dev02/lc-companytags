(() => {
  'use strict';
  if (globalThis.__companyLensActive) return;
  globalThis.__companyLensActive = true;
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.LCTCore;
  const logos = globalThis.LCTCompanyLogos;
  const defaults = { enabled: true, window: 'all' };
  const labels = { all: 'All time', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', older: 'Older than 6 months' };
  let settings = { ...defaults };
  let status = {};
  let slug = null;
  let companies = [];
  let available = false;
  let loading = false;
  let error = '';
  let requestId = 0;
  let host = null;
  let view = null;
  let renderedKey = null;
  let disposed = false;
  let scheduled = false;
  let companyLoadQueued = false;
  let popupOpening = false;
  let popupFeedback = '';
  let popupFeedbackTimer;
  const companyOpenings = new Set();
  let companyFeedback = '';
  let companyFeedbackName = '';
  let companyFeedbackTimer;
  let openContextId = 0;
  const companyOpenKey = (name, currentSlug, window) => JSON.stringify([name, currentSlug, window]);
  const selectedWindow = () => Object.hasOwn(labels, settings.window) ? settings.window : 'all';
  const css = `
    :host { all:initial; display:block; width:100%; min-width:0; margin:10px 0 14px; color-scheme:light; font:12px/1.4 "Segoe UI",sans-serif; --ink:#262626; --muted:#737373; --line:#e5e5e5; --wash:#fafafa; }
    :host([data-dark]) { color-scheme:dark; --ink:#dedede; --muted:#a3a3a3; --line:#3a3a3a; --wash:#262626; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    .company-bar { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--line); border-radius:12px; color:var(--ink); }
    .caption { flex:none; min-width:0; max-width:112px; color:var(--muted); }
    .company-label { display:block; font-size:12px; font-weight:600; white-space:nowrap; }
    .window-row { display:flex; align-items:center; gap:4px; }
    .window-label { display:block; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .open-extension { display:inline-flex; align-items:center; justify-content:center; flex:0 0 28px; width:28px; height:28px; padding:1px; border:1px solid transparent; border-radius:8px; color:var(--muted); background:transparent; cursor:pointer; }
    .open-extension:hover { color:var(--ink); background:var(--wash); border-color:var(--line); }
    .open-extension:disabled { opacity:.5; cursor:wait; }
    .open-extension svg { display:block; width:16px; height:16px; }
    .open-feedback { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    .companies { display:flex; flex:1; min-width:0; gap:6px; list-style:none; margin:0; padding:5px 4px 7px; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
    .companies li { display:block; flex:none; }
    .company-chip { display:inline-flex; align-items:center; gap:6px; height:40px; padding:6px 10px; color:var(--ink); background:var(--wash); border:1px solid var(--line); border-radius:8px; text-decoration:none; white-space:nowrap; font:inherit; text-align:left; cursor:pointer; }
    .company-chip:hover { border-color:var(--muted); }
    .company-chip:disabled { opacity:.5; cursor:wait; }
    .company-chip:focus-visible,.companies:focus-visible,.open-extension:focus-visible { outline:2px solid var(--muted); outline-offset:2px; }
    .company-name { font-size:13px; font-weight:500; }
    .frequency-score { flex:none; padding-left:2px; color:var(--ink); font-size:14px; font-weight:600; line-height:1.4; font-variant-numeric:tabular-nums; }
    .company-logo { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; flex:0 0 24px; overflow:hidden; border:1px solid #d4d4d4; border-radius:5px; background:#fff; color:#4b4b4b; }
    .company-logo-fallback { display:block; color:#4b4b4b; font:600 11px/1 Consolas,monospace; letter-spacing:-.25px; }
    .company-logo img { display:none; width:100%; height:100%; padding:2px; object-fit:contain; }
    .company-logo[data-loaded] img { display:block; }
    .company-logo[data-loaded] .company-logo-fallback { display:none; }
    .status-message { flex:1; min-width:0; margin:0; color:var(--muted); font-size:12px; }
    @media(max-width:480px) { .company-bar { gap:8px; } .caption { max-width:100px; } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '';
  }
  function rendered(node) {
    return Boolean(node?.isConnected && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  }
  function normalizedTitle(value) {
    return value.normalize('NFKC').trim().replace(/^(?:Q\s*)?\d+\s*[.)：:]\s*/i, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function titleMatches(title, currentSlug) {
    const anchors = title.matches('a[href]') ? [title] : Array.from(title.querySelectorAll('a[href]'));
    const identity = anchors.map(anchor => core.getProblemSlug(anchor.href)).find(Boolean);
    if (identity) return identity === currentSlug;
    const explicit = title.dataset.problemSlug || title.dataset.slug;
    if (explicit) return explicit === currentSlug;
    return normalizedTitle(title.textContent || '') === normalizedTitle(core.formatProblemTitle(currentSlug));
  }
  function findPlacement() {
    if (!slug || !settings.enabled) return null;
    const descriptionButton = document.querySelector('#description_tab')?.closest('.flexlayout__tab_button');
    if (descriptionButton?.getAttribute('aria-selected') === 'false') return null;
    if (descriptionButton && !descriptionButton.hasAttribute('aria-selected') && document.querySelector('.flexlayout__tab_button--selected') && !descriptionButton.classList.contains('flexlayout__tab_button--selected')) return null;
    const targets = document.querySelectorAll('[data-track-load="description_content"], [data-cy="question-content"], [data-key="description-content"]');
    for (const target of targets) {
      if (!rendered(target) || host?.contains(target)) continue;
      const tab = target.closest('.flexlayout__tab, [role="tabpanel"]');
      const scopes = [];
      if (tab) scopes.push(tab);
      else {
        let parent = target.parentElement;
        for (let depth = 0; parent && parent !== document.body && depth < 8; depth++, parent = parent.parentElement) scopes.push(parent);
      }
      for (const scope of scopes) {
        const candidates = Array.from(scope.querySelectorAll('.text-title-large, [data-cy="question-title"]'));
        const headings = candidates.length ? candidates : Array.from(scope.querySelectorAll('h1, h2'));
        const title = headings.find(node => rendered(node) && !host?.contains(node));
        if (!title || !titleMatches(title, slug)) continue;
        const statement = target.contains(title) ? target.querySelector('[data-cy="question-content"], [data-key="description-content"], .elfjS') : target;
        if (!statement || !rendered(statement) || statement.contains(title) || !statement.parentElement) continue;
        if (!(title.compareDocumentPosition(statement) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        return { parent: statement.parentElement, statement };
      }
    }
    return null;
  }
  function updateTheme() {
    if (!host) return;
    const html = document.documentElement;
    const dark = html.classList.contains('dark') || html.dataset.theme === 'dark' || (!html.classList.contains('light') && html.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    host.toggleAttribute('data-dark', dark);
  }
  function unmount() {
    if (host) host.remove();
    clearOpenFeedback();
    host = null; view = null; renderedKey = null;
  }
  function mount(placement) {
    if (!placement || host) return;
    host = element('div'); host.id = 'company-lens-root';
    const shadow = host.attachShadow({ mode:'open' });
    const bar = element('section', 'company-bar');
    const caption = element('div', 'caption');
    const label = element('span', 'company-label');
    const windowRow = element('div', 'window-row');
    const windowLabel = element('span', 'window-label');
    const openExtensionButton = element('button', 'open-extension');
    openExtensionButton.type = 'button';
    openExtensionButton.title = 'Open Company Lens popup';
    openExtensionButton.setAttribute('aria-label', 'Open Company Lens popup');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '24'); icon.setAttribute('height', '24');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.6'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.setAttribute('d', 'M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M12 12 21 3M15 3h6v6');
    icon.append(outline, arrow); openExtensionButton.append(icon);
    const openFeedback = element('span', 'open-feedback popup-feedback');
    openFeedback.setAttribute('role', 'status'); openFeedback.setAttribute('aria-live', 'polite');
    const companyOpenFeedback = element('span', 'open-feedback company-feedback');
    companyOpenFeedback.setAttribute('role', 'status'); companyOpenFeedback.setAttribute('aria-live', 'polite');
    windowRow.append(windowLabel, openExtensionButton);
    caption.append(label, windowRow, openFeedback, companyOpenFeedback);
    const list = element('ul', 'companies');
    list.id = 'company-lens-companies'; list.tabIndex = 0;
    list.setAttribute('aria-label', 'Companies ordered by frequency. Scroll horizontally for more.');
    const message = element('p', 'status-message'); message.setAttribute('role', 'status');
    bar.append(caption, list, message);
    shadow.append(element('style', '', css), bar);
    view = { bar, caption, label, windowLabel, openExtensionButton, openFeedback, companyOpenFeedback, list, message };
    placement.parent.insertBefore(host, placement.statement);
    openExtensionButton.addEventListener('click', openExtension);
    list.addEventListener('keydown', event => {
      if (event.target !== list || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') list.scrollLeft = 0;
      else if (event.key === 'End') list.scrollLeft = list.scrollWidth;
      else list.scrollLeft += event.key === 'ArrowRight' ? 140 : -140;
    });
    updateTheme(); renderCompanies();
  }
  function clearOpenFeedback() {
    openContextId++;
    clearTimeout(popupFeedbackTimer); popupFeedback = '';
    clearTimeout(companyFeedbackTimer); companyFeedback = ''; companyFeedbackName = '';
  }
  function openContextCurrent(origin, currentSlug, window, context) {
    return context === openContextId && view === origin && !disposed && settings.enabled && currentSlug === slug &&
      window === selectedWindow() && core.getProblemSlug(location.href) === currentSlug;
  }
  async function openExtension() {
    if (popupOpening || !view) return;
    const currentSlug = core.getProblemSlug(location.href);
    if (!currentSlug || currentSlug !== slug) return;
    const origin = view;
    const window = selectedWindow();
    const context = openContextId;
    clearTimeout(popupFeedbackTimer); popupFeedback = '';
    popupOpening = true; renderStatus();
    try {
      const result = await api.runtime.sendMessage({ type:'LCT_OPEN_POPUP' });
      if (!result?.ok) throw new Error('Popup unavailable');
    } catch (_) {
      if (openContextCurrent(origin, currentSlug, window, context)) {
        popupFeedback = 'Could not open the popup. Click Company Lens in the browser toolbar.';
        popupFeedbackTimer = setTimeout(() => { popupFeedback = ''; renderStatus(); }, 6000);
      }
    } finally {
      popupOpening = false; renderStatus();
    }
  }
  async function openCompany(name, currentSlug, window) {
    const context = openContextId;
    if (!view || !openContextCurrent(view, currentSlug, window, context)) return;
    const key = companyOpenKey(name, currentSlug, window);
    if (companyOpenings.has(key)) return;
    const origin = view;
    clearTimeout(companyFeedbackTimer); companyFeedback = ''; companyFeedbackName = '';
    companyOpenings.add(key); renderStatus();
    try {
      const result = await api.runtime.sendMessage({ type:'LCT_OPEN_EXPLORER', mode:'companies',
        company:name, window, sort:'frequency-desc' });
      if (!result?.ok) throw new Error('Company questions unavailable');
    } catch (_) {
      if (openContextCurrent(origin, currentSlug, window, context)) {
        companyFeedback = `Could not open ${name} questions. Try again.`;
        companyFeedbackName = name;
        companyFeedbackTimer = setTimeout(() => { companyFeedback = ''; companyFeedbackName = ''; renderStatus(); }, 6000);
      }
    } finally {
      companyOpenings.delete(key); renderStatus();
    }
  }
  function renderStatus() {
    if (!view) return;
    const windowLabel = labels[selectedWindow()];
    const sourceDate = date(status.sourceUpdatedAt);
    const provenance = `${status.dataSource === 'bundled' ? 'Bundled snapshot. ' : ''}${sourceDate ? `Source updated ${sourceDate}. ` : ''}${status.phase === 'syncing' ? 'Updating in the background. ' : ''}${status.phase === 'error' ? 'Refresh failed; saved data is shown. ' : ''}Click a company for its questions. Open the Company Lens popup for filters and refresh.`;
    view.label.textContent = `Companies${available ? ` · ${companies.length}` : ''}`;
    view.windowLabel.textContent = windowLabel;
    view.windowLabel.title = windowLabel;
    view.openExtensionButton.title = popupFeedback || 'Open Company Lens popup';
    view.openExtensionButton.disabled = popupOpening;
    view.openExtensionButton.setAttribute('aria-busy', String(popupOpening));
    if (view.openFeedback.textContent !== popupFeedback) view.openFeedback.textContent = popupFeedback;
    if (view.companyOpenFeedback.textContent !== companyFeedback) view.companyOpenFeedback.textContent = companyFeedback;
    for (const chip of view.list.querySelectorAll('.company-chip')) {
      const pending = companyOpenings.has(companyOpenKey(chip.dataset.company, slug, selectedWindow()));
      chip.disabled = pending;
      chip.setAttribute('aria-busy', String(pending));
      chip.title = chip.dataset.description + (companyFeedbackName === chip.dataset.company && companyFeedback ? ` ${companyFeedback}` : '');
    }
    view.caption.title = provenance;
    view.bar.setAttribute('aria-label', `Company Lens company reports for ${core.formatProblemTitle(slug)}. ${windowLabel}. ${provenance}`);
    view.bar.dataset.phase = status.phase || 'idle';
    view.list.hidden = companies.length === 0;
    view.message.hidden = companies.length > 0;
    if (loading) view.message.textContent = 'Loading company tags…';
    else if (error || (!status.hasData && status.phase === 'error')) view.message.textContent = 'Company data unavailable. Open the Company Lens popup to refresh.';
    else if (!available) view.message.textContent = status.phase === 'syncing' ? 'Company tags are updating…' : 'This window is unavailable. Open the Company Lens popup to refresh.';
    else view.message.textContent = 'No company reports in this window. More options in the Company Lens popup.';
  }
  function renderCompanies() {
    if (!view) return;
    const ordered = core.sortCompanies(companies);
    const key = JSON.stringify([slug, selectedWindow(), ordered.map(company => [company.name, company.frequency, company.rank, company.sourceUrl])]);
    if (key !== renderedKey) {
      const currentSlug = slug;
      const window = selectedWindow();
      const windowLabel = labels[window].toLowerCase();
      view.list.replaceChildren(...ordered.map((company, index) => {
        const item = element('li');
        const chip = element('button', 'company-chip');
        chip.type = 'button';
        chip.dataset.company = company.name;
        chip.dataset.window = window;
        const score = Number.isFinite(company.frequency) && company.frequency >= 0 ? String(company.frequency) : 'unavailable';
        const rank = Number.isInteger(company.rank) && company.rank > 0 ? `Company rank #${company.rank}. ` : '';
        const help = element('span', 'chip-description', `Frequency score ${score} for ${windowLabel}. ${rank}Scores are not interview counts and may not be directly comparable between companies.`);
        help.id = `company-lens-score-${index}`; help.hidden = true;
        const frequency = element('span', 'frequency-score', score === 'unavailable' ? '—' : score);
        frequency.setAttribute('aria-hidden', 'true');
        chip.append(logos.createBadge(company.name), element('span', 'company-name', company.name), frequency, help);
        chip.setAttribute('aria-label', `${company.name}, open company questions`);
        chip.setAttribute('aria-describedby', help.id);
        chip.dataset.description = `${company.name}, open company questions. ${help.textContent}`;
        chip.addEventListener('click', () => void openCompany(company.name, currentSlug, window));
        item.append(chip); return item;
      }));
      renderedKey = key;
    }
    renderStatus();
  }
  function requestIsStale(id, currentSlug, window) {
    return id !== requestId || disposed || currentSlug !== slug || window !== selectedWindow() ||
      core.getProblemSlug(location.href) !== currentSlug;
  }
  function applyCompaniesResult(result, window) {
    companies = Array.isArray(result.companies) ? result.companies : [];
    available = result.available ?? result.windowAvailable ?? Boolean(result.status?.hasData && window === 'all');
    status = result.status || status;
  }
  async function readCachedCompanies(currentSlug, window) {
    const lookup = globalThis.LCTLookup;
    if (!lookup || typeof lookup.readProblem !== 'function') return null;
    try {
      const result = await lookup.readProblem(api.storage.local, currentSlug, window);
      return result && result.ok === true ? result : null;
    } catch (_) {
      return null;
    }
  }
  async function loadCompanies() {
    const currentSlug = slug;
    const window = selectedWindow();
    const id = ++requestId;
    if (!currentSlug || !settings.enabled) return;
    loading = true; error = ''; renderStatus();
    try {
      let result = await readCachedCompanies(currentSlug, window);
      if (requestIsStale(id, currentSlug, window)) return;
      if (!result) {
        result = await api.runtime.sendMessage({ type:'LCT_GET', slug:currentSlug, window });
        if (requestIsStale(id, currentSlug, window)) return;
      }
      if (!result?.ok) throw new Error(result?.error || 'Could not load company tags.');
      applyCompaniesResult(result, window);
    } catch (cause) {
      if (requestIsStale(id, currentSlug, window)) return;
      error = cause.message || 'Could not load company tags.';
    } finally {
      if (!requestIsStale(id, currentSlug, window)) { loading = false; renderCompanies(); scheduleCheck(); }
    }
  }
  function queueCompanyLoad() {
    if (companyLoadQueued || !slug || !settings.enabled) return;
    companyLoadQueued = true;
    Promise.resolve().then(() => {
      companyLoadQueued = false;
      if (slug && settings.enabled) void loadCompanies();
    });
  }
  function lookupRevision(value) {
    if (!value || typeof value !== 'object') return '';
    return String(value.revision || value.commit || value.schema || value.updatedAt || value.lastSyncedAt || value.sourceUpdatedAt || '');
  }
  function lookupMetaChanged(change) {
    if (!change?.newValue) return false;
    const previous = lookupRevision(change.oldValue);
    const next = lookupRevision(change.newValue);
    return previous !== next || (!previous && change.oldValue !== change.newValue);
  }
  function checkPage() {
    scheduled = false;
    if (disposed) return;
    const nextSlug = core.getProblemSlug(location.href);
    if (nextSlug !== slug) {
      requestId++; unmount(); slug = nextSlug;
      companies = []; available = false; error = ''; loading = false;
      if (slug && settings.enabled) void loadCompanies();
    }
    if (!slug || !settings.enabled) { unmount(); return; }
    const placement = findPlacement();
    if (!placement) { unmount(); return; }
    if (!host) mount(placement);
    else if (!host.isConnected || host.parentElement !== placement.parent || host.nextElementSibling !== placement.statement) placement.parent.insertBefore(host, placement.statement);
    updateTheme();
  }
  function scheduleCheck() {
    if (scheduled || disposed) return;
    scheduled = true; requestAnimationFrame(checkPage);
  }
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'LCT_CONTEXT') return false;
    sendResponse({ slug:core.getProblemSlug(location.href) }); return false;
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.lctSettings && !changes.lctStatus && !changes.lctData && !changes.lctLookupMeta)) return;
    let reload = Boolean(changes.lctData?.newValue || lookupMetaChanged(changes.lctLookupMeta));
    if (changes.lctSettings) {
      const previousWindow = selectedWindow(); const previousEnabled = settings.enabled;
      settings = { ...defaults, ...changes.lctSettings.newValue };
      if (!settings.enabled) { requestId++; unmount(); }
      if (previousWindow !== selectedWindow()) { clearOpenFeedback(); requestId++; companies = []; available = false; error = ''; renderCompanies(); }
      reload ||= settings.enabled && (previousEnabled !== settings.enabled || previousWindow !== selectedWindow());
      scheduleCheck();
    }
    if (changes.lctStatus) {
      const previous = status; status = changes.lctStatus.newValue || {};
      reload ||= Boolean(status.hasData && (!previous.hasData || previous.commit !== status.commit || previous.lastSyncedAt !== status.lastSyncedAt));
      renderStatus();
    }
    if (reload) queueCompanyLoad();
  });
  async function start() {
    try {
      const stored = await api.storage.local.get(['lctSettings','lctStatus']);
      settings = { ...defaults, ...stored.lctSettings }; status = stored.lctStatus || {};
    } catch (_) { /* Cache queries report a compact usable error. */ }
    checkPage();
    const interval = setInterval(checkPage, 700);
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.documentElement, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class','style','hidden','href','aria-selected','data-slug','data-problem-slug'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
    addEventListener('popstate', scheduleCheck);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleCheck(); });
    addEventListener('pagehide', event => { if (!event.persisted) { disposed = true; clearInterval(interval); observer.disconnect(); } }, { once:true });
  }
  void start();
})();
