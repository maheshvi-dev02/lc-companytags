/* Shared rounded select controls for extension pages; native selects retain state. */
(() => {
  'use strict';

  let activeMulti = null;
  function value(select, next) {
    if (arguments.length > 1) {
      if (select.multiple) {
        const normalize = entry => select.dataset.multipleNoun === 'difficulties' ? String(entry).trim().toLowerCase() : entry;
        const selected = new Set((Array.isArray(next) ? next : String(next || '').split(',')).map(normalize));
        for (const option of select.options) option.selected = Boolean(option.value) && selected.has(normalize(option.value));
      } else select.value = next;
    }
    return select.multiple ? Array.from(select.selectedOptions, option => option.value).filter(Boolean).join(',') : select.value;
  }
  function multipleControl(select) {
    const id = select.id, labels = Array.from(select.labels || []);
    const noun = select.dataset.multipleNoun || 'options', empty = select.dataset.empty || 'All options';
    const searchable = select.dataset.searchable !== 'false', limit = Number(select.dataset.limit || 500);
    const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const wrapper = make('span', 'select-control'), button = make('button', 'select-trigger'), caption = make('span', 'select-value'), arrow = make('span', 'select-chevron');
    button.id = id + '-trigger'; button.type = 'button'; button.dataset.selectFor = id;
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id + '-menu'); arrow.setAttribute('aria-hidden', 'true');
    button.append(caption, arrow); wrapper.append(button); select.before(wrapper); select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    labels.forEach(label => { label.htmlFor = button.id; });
    const menu = make('div', 'select-menu multi-select-menu'); menu.id = id + '-menu'; menu.hidden = true; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Select ' + noun);
    const searchLabel = make('label', 'multi-select-search', 'Search ' + noun), search = make('input');
    search.type = 'search'; search.id = id + '-search'; search.placeholder = 'Find ' + noun; search.autocomplete = 'off'; searchLabel.append(search); searchLabel.hidden = !searchable;
    const hint = make('p', 'multi-select-hint', select.dataset.hint || 'Changes apply immediately. No selection includes all.');
    const list = make('div', 'multi-select-options'); list.id = id + '-options'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', noun);
    const emptyMessage = make('p', 'multi-select-hint', 'No matches. Try another search.'); emptyMessage.hidden = true;
    const actions = make('div', 'multi-select-actions'), clear = make('button', '', 'Clear selection');
    clear.type = 'button'; clear.id = id + '-clear'; actions.append(clear);
    menu.append(searchLabel, hint, list, emptyMessage, actions); document.body.append(menu);
    let open = false, draft = new Set(), signature = '', positionSignature = '';
    const selectedValues = () => Array.from(select.selectedOptions, option => option.value).filter(Boolean);
    function close(focus = false) {
      open = false; menu.hidden = true; button.setAttribute('aria-expanded', 'false');
      if (activeMulti === controller) activeMulti = null;
      if (focus) button.focus({ preventScroll: true });
    }
    function position(force = false) {
      if (!open) return;
      const rect = button.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight;
      const key = [rect.left, rect.top, rect.width, rect.height, vw, vh].join(',');
      if (!force && key === positionSignature) return;
      positionSignature = key;
      const width = Math.min(Math.max(rect.width, searchable ? 320 : 250), Math.max(0, vw - 16));
      const below = vh - rect.bottom - 14, above = rect.top - 14, upward = below < 280 && above > below;
      menu.style.width = width + 'px'; menu.style.maxHeight = Math.max(0, Math.min(430, upward ? above : below)) + 'px';
      menu.style.left = Math.max(8, Math.min(rect.left, vw - width - 8)) + 'px';
      menu.style.top = (upward ? Math.max(8, rect.top - 6 - menu.getBoundingClientRect().height) : rect.bottom + 6) + 'px';
    }
    function syncDraft() {
      for (const input of list.querySelectorAll('input')) { input.checked = draft.has(input.value); input.disabled = !input.checked && draft.size >= limit; }
    }
    function renderOptions() {
      const query = search.value.trim().toLocaleLowerCase();
      list.replaceChildren(...Array.from(select.options).filter(option => option.value && !option.disabled && option.textContent.toLocaleLowerCase().includes(query)).map(option => {
        const label = make('label', 'multi-select-option'), check = make('input'); check.type = 'checkbox'; check.value = option.value; check.dataset.value = option.value;
        check.addEventListener('change', () => { if (check.checked) draft.add(option.value); else draft.delete(option.value); commit(); });
        label.append(check, make('span', '', option.textContent)); return label;
      }));
      emptyMessage.hidden = Boolean(list.children.length); syncDraft(); position(true);
    }
    function sync() {
      const selected = selectedValues(), name = select.getAttribute('aria-label') || noun;
      hint.textContent = select.dataset.hint || 'Changes apply immediately. No selection includes all.';
      caption.textContent = !selected.length ? empty : noun === 'difficulties' ? selected.join(', ') : selected.length === 1 ? selected[0] : selected.length + ' selected';
      button.title = selected.length ? selected.join(', ') : empty;
      button.setAttribute('aria-label', name + ': ' + caption.textContent); button.disabled = select.disabled;
      const nextSignature = JSON.stringify(Array.from(select.options, option => [option.value, option.textContent, option.disabled]));
      if (open && (button.disabled || signature !== nextSignature)) close();
      signature = nextSignature;
      if (open) { draft = new Set(selected); syncDraft(); }
    }
    function show() {
      if (button.disabled) return;
      activeMulti?.close(); document.dispatchEvent(new Event('lct-multi-open'));
      draft = new Set(selectedValues()); search.value = ''; menu.hidden = false; open = true; activeMulti = controller; button.setAttribute('aria-expanded', 'true');
      renderOptions(); (searchable ? search : list.querySelector('input') || clear).focus({ preventScroll: true });
    }
    button.addEventListener('click', () => open ? close() : show());
    button.addEventListener('keydown', event => { if (event.key === 'Escape' && open) { event.preventDefault(); close(true); } if (event.key === 'ArrowDown') { event.preventDefault(); show(); } });
    search.addEventListener('input', renderOptions);
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const inputs = Array.from(list.querySelectorAll('input:not(:disabled)'));
        const index = inputs.indexOf(document.activeElement), next = index + (event.key === 'ArrowDown' ? 1 : -1);
        const input = inputs[Math.max(0, Math.min(inputs.length - 1, next))];
        if (input) { event.preventDefault(); input.focus(); }
      }
    });
    function commit() {
      const previous = JSON.stringify(selectedValues()); value(select, [...draft]); sync(); syncDraft();
      if (previous !== JSON.stringify(selectedValues())) select.dispatchEvent(new Event('change', { bubbles: true }));
      position(true);
    }
    clear.addEventListener('click', () => { draft.clear(); commit(); });
    document.addEventListener('pointerdown', event => { if (open && !wrapper.contains(event.target) && !menu.contains(event.target)) close(); });
    document.addEventListener('focusin', event => { if (open && !wrapper.contains(event.target) && !menu.contains(event.target)) close(); });
    window.addEventListener('resize', () => position());
    window.addEventListener('scroll', event => { if (open && event.target !== menu && !menu.contains(event.target)) { const rect = button.getBoundingClientRect(); if (rect.bottom <= 0 || rect.top >= innerHeight) close(); else position(); } }, true);
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'aria-label'] });
    const controller = { multi: true, close, sync }; sync(); return controller;
  }

  function create() {
    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    }
    const selectControls = new Map();
    let openSelect = null;
    let listenersBound = false;
    function closeSelectMenu(returnFocus = false) {
      if (!openSelect) return;
      const control = openSelect;
      openSelect = null;
      control.menu.hidden = true;
      control.button.setAttribute('aria-expanded', 'false');
      control.button.removeAttribute('aria-activedescendant');
      control.typeahead = '';
      if (returnFocus) control.button.focus();
    }
    function setActiveOption(control, index) {
      const options = Array.from(control.menu.children);
      const enabled = options.map((option, position) => option.getAttribute('aria-disabled') === 'true' ? -1 : position).filter(position => position >= 0);
      if (!enabled.length) return;
      const next = enabled.includes(index) ? index : enabled[0];
      control.activeIndex = next;
      options.forEach((option, position) => option.toggleAttribute('data-active', position === next));
      const active = options[next];
      control.button.setAttribute('aria-activedescendant', active.id);
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < control.menu.scrollTop) control.menu.scrollTop = top;
      else if (bottom > control.menu.scrollTop + control.menu.clientHeight) control.menu.scrollTop = bottom - control.menu.clientHeight;
    }
    function syncSelectControl(select) {
      const control = selectControls.get(select.id);
      if (!control) return;
      if (control.multi) { control.sync(); return; }
      const options = Array.from(select.options);
      const signature = JSON.stringify(options.map(option => [option.value, option.textContent, option.disabled]));
      if (signature !== control.signature) {
        if (openSelect === control) closeSelectMenu();
        control.signature = signature;
        control.menu.replaceChildren(...options.map((option, index) => {
          const item = node('div', 'select-option', option.textContent);
          item.id = `${select.id}-option-${index}`;
          item.dataset.value = option.value;
          item.setAttribute('role', 'option');
          if (option.disabled) item.setAttribute('aria-disabled', 'true');
          return item;
        }));
      }
      const selected = options[select.selectedIndex];
      control.value.textContent = selected?.textContent || 'Choose an option';
      const name = select.getAttribute('aria-label') || 'Choose an option';
      control.button.title = control.button.hasAttribute('data-sort-icon') ? `${name}: ${control.value.textContent}` : control.value.textContent;
      control.button.setAttribute('aria-label', name);
      control.menu.setAttribute('aria-label', name);
      control.button.disabled = select.disabled || !options.some(option => !option.disabled);
      Array.from(control.menu.children).forEach(item => item.setAttribute('aria-selected', String(item.dataset.value === select.value)));
      if (control.button.disabled && openSelect === control) closeSelectMenu();
    }
    function positionSelectMenu(control) {
      const rect = control.button.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      // Firefox action popups emit resize while negotiating their preferred size,
      // even when the final viewport is unchanged. Keep the menu open and avoid
      // rewriting identical styles, which can trigger another sizing pass.
      const positionSignature = [rect.left, rect.top, rect.width, rect.height, viewportWidth, viewportHeight].join(',');
      if (control.positionSignature === positionSignature) return;
      control.positionSignature = positionSignature;
      const width = Math.min(Math.max(rect.width, 220), Math.max(0, viewportWidth - margin * 2));
      control.menu.style.width = `${width}px`;
      const below = viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const upward = below < 180 && above > below;
      const space = Math.max(0, upward ? above : below);
      control.menu.style.maxHeight = `${Math.min(320, space)}px`;
      const height = control.menu.getBoundingClientRect().height;
      control.menu.style.left = `${Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))}px`;
      control.menu.style.top = `${upward ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap}px`;
    }
    function openSelectMenu(control, edge) {
      if (control.button.disabled) return;
      activeMulti?.close();
      syncSelectControl(control.select);
      closeSelectMenu();
      openSelect = control;
      control.menu.hidden = false;
      control.button.setAttribute('aria-expanded', 'true');
      control.button.focus();
      control.positionSignature = null;
      positionSelectMenu(control);
      const options = Array.from(control.menu.children);
      const selected = options.findIndex(option => option.dataset.value === control.select.value);
      setActiveOption(control, edge === 'first' ? 0 : edge === 'last' ? options.length - 1 : selected);
    }
    function pickSelectOption(control, option) {
      if (!option || option.getAttribute('aria-disabled') === 'true') return;
      const changed = control.select.value !== option.dataset.value;
      control.select.value = option.dataset.value;
      closeSelectMenu(true);
      syncSelectControl(control.select);
      if (changed) control.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function selectKeydown(control, event) {
      if (control.button.disabled) return;
      const expanded = openSelect === control;
      if (event.key === 'Tab') { closeSelectMenu(); return; }
      if (event.key === 'Escape') {
        if (expanded) { event.preventDefault(); closeSelectMenu(true); }
        return;
      }
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Enter' || event.key === ' ') {
          if (expanded) pickSelectOption(control, control.menu.children[control.activeIndex]);
          else openSelectMenu(control);
          return;
        }
        if (event.altKey && event.key === 'ArrowUp') { closeSelectMenu(true); return; }
        if (!expanded) { openSelectMenu(control, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined); return; }
        const options = Array.from(control.menu.children);
        const enabled = options.map((option, index) => option.getAttribute('aria-disabled') === 'true' ? -1 : index).filter(index => index >= 0);
        const position = enabled.indexOf(control.activeIndex);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
        setActiveOption(control, enabled[next]);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!expanded) openSelectMenu(control);
        const now = Date.now();
        const previous = now - control.typedAt < 700 ? control.typeahead : '';
        control.typeahead = previous + event.key.toLocaleLowerCase();
        control.typedAt = now;
        const repeated = Array.from(control.typeahead).every(letter => letter === control.typeahead[0]);
        const prefix = repeated ? control.typeahead[0] : control.typeahead;
        const options = Array.from(control.menu.children);
        const start = repeated ? control.activeIndex + 1 : control.activeIndex;
        for (let step = 0; step < options.length; step++) {
          const index = (start + step) % options.length;
          const option = options[index];
          if (option.getAttribute('aria-disabled') !== 'true' && option.textContent.toLocaleLowerCase().startsWith(prefix)) { setActiveOption(control, index); break; }
        }
      }
    }
    function enhanceSelects(ids, { iconIds = [] } = {}) {
      for (const id of ids) {
        const select = document.getElementById(id);
        if (!select || selectControls.has(id)) continue;
        if (select.multiple) { selectControls.set(id, multipleControl(select)); continue; }
        const labels = Array.from(select.labels || []);
        const wrapper = node('span', 'select-control');
        const button = node('button', 'select-trigger');
        button.id = `${id}-trigger`;
        button.type = 'button';
        button.dataset.selectFor = id;
        button.setAttribute('role', 'combobox');
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', `${id}-menu`);
        const value = node('span', 'select-value');
        const chevron = node('span', 'select-chevron');
        chevron.setAttribute('aria-hidden', 'true');
        if (iconIds.includes(id)) {
          button.dataset.sortIcon = '';
          value.classList.add('sr-only');
          value.id = `${id}-value`;
          button.setAttribute('aria-describedby', value.id);
          const ns = 'http://www.w3.org/2000/svg';
          const icon = document.createElementNS(ns, 'svg');
          for (const [name, attribute] of Object.entries({ class: 'sort-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, attribute);
          const path = document.createElementNS(ns, 'path');
          path.setAttribute('d', 'M4 5h16l-6 7v6l-4 2v-8L4 5Z');
          icon.append(path);
          button.append(icon, value);
        } else button.append(value, chevron);
        wrapper.append(button);
        select.before(wrapper);
        const menu = node('div', 'select-menu');
        menu.id = `${id}-menu`;
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        document.body.append(menu);
        const control = { select, wrapper, button, value, menu, signature: null, activeIndex: -1, typeahead: '', typedAt: 0 };
        selectControls.set(id, control);
        labels.forEach(label => { label.htmlFor = button.id; });
        select.hidden = true;
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        button.addEventListener('click', () => openSelect === control ? closeSelectMenu() : openSelectMenu(control));
        button.addEventListener('keydown', event => selectKeydown(control, event));
        menu.addEventListener('click', event => {
          const option = event.target.closest('[role="option"]');
          if (option?.parentNode === menu) pickSelectOption(control, option);
        });
        menu.addEventListener('pointermove', event => {
          const option = event.target.closest('[role="option"]');
          if (option?.parentNode === menu && option.getAttribute('aria-disabled') !== 'true') setActiveOption(control, Array.from(menu.children).indexOf(option));
        });
        select.addEventListener('change', () => syncSelectControl(select));
        new MutationObserver(() => syncSelectControl(select)).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'disabled', 'value', 'label', 'selected'] });
        syncSelectControl(select);
      }
      if (listenersBound) return;
      listenersBound = true;
      document.addEventListener('lct-multi-open', () => closeSelectMenu());
      document.addEventListener('pointerdown', event => {
        if (openSelect && !openSelect.wrapper.contains(event.target) && !openSelect.menu.contains(event.target)) closeSelectMenu();
      });
      document.addEventListener('focusin', event => {
        if (openSelect && event.target !== openSelect.button && !openSelect.menu.contains(event.target)) closeSelectMenu();
      });
      window.addEventListener('resize', () => {
        if (openSelect) positionSelectMenu(openSelect);
      });
      window.addEventListener('scroll', event => {
        if (openSelect && event.target !== openSelect.menu && !openSelect.menu.contains(event.target)) closeSelectMenu();
      }, true);
    }
    return { enhance: enhanceSelects, sync: syncSelectControl, close: () => { closeSelectMenu(); for (const control of selectControls.values()) if (control.multi) control.close(); } };
  }
  globalThis.LCTSelectControls = Object.freeze({ create, value });
})();
