import assert from 'node:assert/strict';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const panelRoot = 'document.querySelector("#company-lens-root").shadowRoot';
const imageOrigin = /^(chrome|moz)-extension:\/\/[^/]+\/logos\/[a-z0-9_-]+\.(svg|png)$/;

// Inspect the real rendered badge, including its decoded local image and the
// fallback that is shown when no verified asset exists or an image fails.
function inspect({ root, selector }) {
  const palette = (element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor });
  return Array.from(root.querySelectorAll(selector), badge => {
    const image = badge.querySelector('img');
    const fallback = badge.querySelector('.company-logo-fallback');
    const rectangle = badge.getBoundingClientRect();
    const parent = badge.parentElement;
    return {
      name: parent.querySelector('.company-name,h2')?.textContent || '',
      label: badge.closest('a,button')?.getAttribute('aria-label') || '',
      hidden: badge.getAttribute('aria-hidden'), width: rectangle.width, height: rectangle.height,
      loaded: badge.hasAttribute('data-loaded'), image: image ? {
        src: image.src, complete: image.complete, naturalWidth: image.naturalWidth,
        alt: image.alt, hidden: image.getAttribute('aria-hidden'), display: getComputedStyle(image).display,
      } : null,
      fallback: { text: fallback?.textContent || '', display: fallback ? getComputedStyle(fallback).display : '',
        color: fallback ? palette(fallback).color : '', background: palette(badge).background },
    };
  });
}
function contrast(foreground, background) {
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export async function verifyBadges(ui, { root = 'document', selector, names, size = 20, label, known = false }) {
  let badges;
  for (let attempt = 0; attempt < 100; attempt++) {
    badges = await ui.read(`(${inspect.toString()})({ root: ${root}, selector: ${JSON.stringify(selector)} })`);
    if (JSON.stringify(badges.map(badge => badge.name)) === JSON.stringify(names) && badges.every(badge => badge.width > 0 && (!badge.image || badge.loaded && badge.image.complete && badge.image.naturalWidth > 0))) break;
    await wait(50);
  }
  assert.deepEqual(badges.map(badge => badge.name), names, 'Logos must preserve the visible company names.');
  for (const badge of badges) {
    assert.equal(badge.hidden, 'true', 'Brand badges must remain decorative.');
    assert.equal(badge.width, size); assert.equal(badge.height, size);
    if (label) assert.equal(badge.label, label.replace('{name}', badge.name), 'Logo initials must not alter the accessible action name.');
    assert.ok(contrast(badge.fallback.color, badge.fallback.background) >= 4.5, 'Fallback initials need readable contrast.');
    if (known) assert.ok(badge.image, `${badge.name} needs a packaged brand image.`);
    if (badge.image) {
      assert.match(badge.image.src, imageOrigin, 'Logos must load from the local extension package.');
      assert.equal(badge.loaded, true, `${badge.name} image must decode successfully.`);
      assert.ok(badge.image.complete && badge.image.naturalWidth > 0);
      assert.equal(badge.image.alt, ''); assert.equal(badge.image.hidden, 'true');
      assert.notEqual(badge.image.display, 'none'); assert.equal(badge.fallback.display, 'none');
    } else {
      assert.equal(badge.loaded, false); assert.notEqual(badge.fallback.display, 'none');
      assert.match(badge.fallback.text, /^[\p{L}\p{N}?]{1,2}$/u, 'Unmapped brands need concise initials.');
    }
  }
  const imageResources = await ui.read("performance.getEntriesByType('resource').filter(entry => entry.initiatorType === 'img').map(entry => entry.name)");
  for (const resource of imageResources) assert.match(resource, /^(chrome|moz)-extension:\/\//, 'Rendering logos must make no remote image requests.');
  return { mapped: badges.filter(badge => badge.image).length, initials: badges.filter(badge => !badge.image).map(badge => ({ name: badge.name, initials: badge.fallback.text })), imageResources: imageResources.length };
}

export async function exercisePanelLogos(page, companies) {
  const ui = { read: expression => page.evaluate(expression), mutate: source => page.evaluate(source) };
  const rows = '.company-identity > .company-logo';
  const first = await verifyBadges(ui, { root: panelRoot, selector: rows, names: companies.slice(0, 5).map(company => company.name), known: true, label: '{name}, view source' });
  const host = page.locator('#company-lens-root');
  await host.getByRole('button', { name: `Show all ${companies.length} companies` }).click();
  const all = await verifyBadges(ui, { root: panelRoot, selector: rows, names: companies.map(company => company.name), label: '{name}, view source' });
  assert.ok(all.initials.length > 0, 'The real source list should exercise unmapped-company initials.');
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); });
  await page.waitForFunction(() => !document.querySelector('#company-lens-root').hasAttribute('data-dark'));
  const light = await verifyBadges(ui, { root: panelRoot, selector: rows, names: companies.map(company => company.name) });
  await page.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
  await page.waitForFunction(() => document.querySelector('#company-lens-root').hasAttribute('data-dark'));
  const dark = await verifyBadges(ui, { root: panelRoot, selector: rows, names: companies.map(company => company.name) });
  assert.deepEqual(dark.initials, light.initials);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await host.getByRole('button', { name: 'Show fewer' }).click();
  await host.getByRole('button', { name: 'Practice Amazon', exact: true }).click();
  await verifyBadges(ui, { root: panelRoot, selector: '.practice-view .company-heading > .company-logo', names: ['Amazon'], size: 24, known: true });
  await host.getByRole('button', { name: 'Back to companies', exact: false }).click();
  await verifyBadges(ui, { root: panelRoot, selector: rows, names: companies.slice(0, 5).map(company => company.name), known: true, label: '{name}, view source' });
  return { ...first, realSource: all, lightAndDark: true,
    check: 'Offline problem panel decodes real local company logos, preserves accessible names, shows readable initials in light/dark themes, and includes a 24px Amazon practice heading logo.' };
}

export async function exercisePopupLogos(ui, names) {
  const rows = '#companies .company-identity > .company-logo';
  const result = await verifyBadges(ui, { selector: rows, names, known: true, label: '{name}, view source' });
  await ui.click('#companies button[data-company="Amazon"]');
  await verifyBadges(ui, { selector: '#practice-heading > .company-logo', names: ['Amazon'], size: 24, known: true });
  await ui.click('#back-companies');
  await verifyBadges(ui, { selector: rows, names, known: true });
  return { ...result, check: 'Offline toolbar popup decodes packaged logos in company rows and the Amazon practice heading; decorative badges preserve source and practice action names.' };
}

export async function exerciseBrokenLogo(ui) {
  const selector = '#detail-results .company-title[data-company="Amazon"] > .company-logo';
  await ui.mutate(`const badge = document.querySelector(${JSON.stringify(selector)}); const image = badge.querySelector('img');
    image.src = new URL('browser-logo-missing.svg', image.src).href;`);
  let fallback;
  for (let attempt = 0; attempt < 100; attempt++) {
    fallback = await ui.read(`(${inspect.toString()})({ root: document, selector: ${JSON.stringify(selector)} })`);
    if (fallback[0] && !fallback[0].image && !fallback[0].loaded) break;
    await wait(50);
  }
  assert.equal(fallback[0].name, 'Amazon'); assert.equal(fallback[0].label, 'View questions for Amazon');
  assert.equal(fallback[0].image, null); assert.equal(fallback[0].loaded, false);
  assert.equal(fallback[0].fallback.text, 'AM'); assert.notEqual(fallback[0].fallback.display, 'none');
  assert.ok(contrast(fallback[0].fallback.color, fallback[0].fallback.background) >= 4.5);
  // Restore through the unmodified production factory, then require real decode.
  await ui.mutate(`document.querySelector(${JSON.stringify(selector)}).replaceWith(LCTCompanyLogos.createBadge('Amazon'));`);
  await verifyBadges(ui, { selector, names: ['Amazon'], known: true, label: 'View questions for {name}' });
  return { company: 'Amazon', fallback: 'AM', restored: true };
}
