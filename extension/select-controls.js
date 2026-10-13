/* Shared rounded select controls for extension pages; native selects retain state. */
(() => {
  'use strict';
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
    return { enhance: enhanceSelects, sync: syncSelectControl, close: closeSelectMenu };
  }
  globalThis.LCTSelectControls = Object.freeze({ create });
})();
