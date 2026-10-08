const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/company-logos.js'), 'utf8');

function helper(catalog) {
  const context = {
    module: { exports: {} }, URL,
    require(filename) { assert.equal(filename, './logo-catalog.js'); return catalog; }
  };
  vm.runInNewContext(source, context, { filename: 'company-logos.js' });
  assert.equal(context.LCTCompanyLogos, context.module.exports);
  return context.module.exports;
}

function fakeDocument() {
  const created = [];
  const document = {
    createElement(tag) {
      const attributes = new Map(), listeners = new Map();
      const element = {
        tagName: tag.toUpperCase(), children: [], parentNode: null, textContent: '', className: '',
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        removeAttribute(name) { attributes.delete(name); },
        append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } },
        remove() {
          if (this.parentNode) {
            const siblings = this.parentNode.children;
            siblings.splice(siblings.indexOf(this), 1);
            this.parentNode = null;
          }
        },
        addEventListener(type, callback, options) {
          const entries = listeners.get(type) || [];
          entries.push({ callback, once: Boolean(options && options.once) });
          listeners.set(type, entries);
        },
        dispatch(type) {
          const entries = (listeners.get(type) || []).slice();
          for (const entry of entries) {
            entry.callback();
            if (entry.once) {
              const current = listeners.get(type);
              current.splice(current.indexOf(entry), 1);
            }
          }
        }
      };
      created.push(element);
      return element;
    }
  };
  return { document, created };
}

test('logos resolve only explicit identities with case, whitespace and NFKC normalization', () => {
  const logos = helper({
    'Amazon': 'amazon.svg', 'J.P. Morgan': 'jpmorgan.svg',
    'BILL Holdings': 'bill-holdings.svg', 'HP': 'hp.svg', 'HPE': 'hpe.svg', 'Acko': 'acko.png'
  });
  assert.equal(logos.getAsset('  aMaZoN  '), 'logos/amazon.svg');
  assert.equal(logos.getAsset('Ａｍａｚｏｎ'), 'logos/amazon.svg');
  assert.equal(logos.getAsset('j.p.\u00a0  MORGAN'), 'logos/jpmorgan.svg');
  assert.equal(logos.getAsset('bill   holdings'), 'logos/bill-holdings.svg');
  assert.equal(logos.getAsset('HP'), 'logos/hp.svg');
  assert.equal(logos.getAsset('HPE'), 'logos/hpe.svg');
  assert.equal(logos.getAsset('Acko'), 'logos/acko.png');
  for (const name of ['JPMorgan', 'J P Morgan', 'JP Morgan', 'BILL', 'Amazon Web Services', 'HP Enterprise', 'Unknown', '__proto__', 'constructor', 'toString']) {
    assert.equal(logos.getAsset(name), null, name + ' must not guess a related brand');
  }
  assert.equal(logos.getAsset(null), null);
  assert.equal(logos.getAsset({ toString() { throw new Error('Do not coerce names'); } }), null);
});

test('conflicting normalized brand identities never select an arbitrary image', () => {
  const logos = helper({ HP: 'hp.svg', ' hp ': 'hpe.svg', ' ＨＰ ': 'hp.svg' });
  assert.equal(logos.getAsset('HP'), null);
  assert.equal(logos.getAsset('hpe'), null);
});

test('catalog values cannot supply remote URLs, traversal, unsupported formats or unsafe filenames', () => {
  const invalid = {
    Remote: 'https://example.test/logo.png', Protocol: '//example.test/logo.svg',
    Parent: '../logo.svg', Root: '/logo.svg', Backslash: 'company\\logo.svg',
    Directory: 'logos/logo.svg', Query: 'logo.png?v=1', Fragment: 'logo.svg#part',
    Percent: 'company%2flogo.svg', Space: 'company name.svg', Dots: 'company..svg',
    Uppercase: 'Logo.svg', UppercaseType: 'logo.SVG', Gif: 'logo.gif',
    Empty: '', Dash: '-.svg', Nontext: { file: 'logo.svg' }
  };
  const logos = helper({ ...invalid, Safe: 'company-logo_2.svg' });
  for (const name of Object.keys(invalid)) assert.equal(logos.getAsset(name), null, name);
  assert.equal(logos.getAsset('Safe'), 'logos/company-logo_2.svg');
});

test('initials are short Unicode letters/numbers and remain plain fallback text', () => {
  const logos = helper({});
  assert.equal(logos.initials('Bank of America'), 'BA');
  assert.equal(logos.initials('J.P. Morgan'), 'JM');
  assert.equal(logos.initials('Amazon'), 'AM');
  assert.equal(logos.initials('3M'), '3M');
  assert.equal(logos.initials('X'), 'X');
  assert.equal(logos.initials('a\u0308 bc'), 'ÄB');
  assert.equal(logos.initials('会社'), '会社');
  assert.equal(logos.initials('😀 🐈'), '?');
  assert.equal(logos.initials(''), '?');
  assert.equal(logos.initials(null), '?');
  assert.equal(logos.initials({ toString() { throw new Error('Do not coerce names'); } }), '?');
  const { document, created } = fakeDocument();
  const badge = logos.createBadge('<script>alert(1)</script>', { document, runtime: null });
  assert.equal(badge.children.length, 1);
  assert.equal(badge.children[0].textContent, 'SS');
  assert.deepEqual(created.map(node => node.tagName), ['SPAN', 'SPAN']);
});

test('local images are decorative, retain fallback until load, and revert on error', () => {
  const logos = helper({ Amazon: 'amazon.svg' });
  const { document } = fakeDocument();
  const requested = [];
  const badge = logos.createBadge('Amazon', { document,
    runtime: { getURL(asset) { requested.push(asset); return 'chrome-extension://test-extension/' + asset; } }
  });
  const [fallback, image] = badge.children;
  assert.deepEqual(requested, ['logos/amazon.svg']);
  assert.equal(badge.className, 'company-logo');
  assert.equal(badge.getAttribute('aria-hidden'), 'true');
  assert.equal(fallback.className, 'company-logo-fallback');
  assert.equal(fallback.textContent, 'AM');
  assert.equal(image.tagName, 'IMG');
  assert.equal(image.alt, '');
  assert.equal(image.getAttribute('aria-hidden'), 'true');
  assert.equal(image.width, 20);
  assert.equal(image.height, 20);
  assert.equal(image.src, 'chrome-extension://test-extension/logos/amazon.svg');
  assert.equal(badge.getAttribute('data-loaded'), null);
  image.dispatch('load');
  assert.equal(badge.getAttribute('data-loaded'), '');
  image.dispatch('error');
  assert.equal(badge.getAttribute('data-loaded'), null);
  assert.equal(image.parentNode, null);
  assert.deepEqual(badge.children, [fallback]);
});

test('unknown brands and unavailable or invalid runtimes never request an image', () => {
  const logos = helper({ Amazon: 'amazon.svg' });
  const { document } = fakeDocument();
  let calls = 0;
  const unknown = logos.createBadge('../../Google', { document,
    runtime: { getURL() { calls++; throw new Error('Must not be called'); } }
  });
  assert.equal(calls, 0);
  assert.equal(unknown.children.length, 1);
  for (const runtime of [null, {}, { getURL() { throw new Error('No runtime'); } },
    { getURL() { return 'https://example.test/logos/amazon.svg'; } },
    { getURL() { return 'data:image/png;base64,abc'; } }]) {
    assert.equal(logos.createBadge('Amazon', { document, runtime }).children.length, 1);
  }
  const firefox = logos.createBadge('Amazon', { document,
    runtime: { getURL(asset) { return 'moz-extension://test-uuid/' + asset; } }
  });
  assert.equal(firefox.children[1].src, 'moz-extension://test-uuid/logos/amazon.svg');
});

test('a failed image cannot subsequently hide its surviving initials fallback', () => {
  const logos = helper({ Amazon: 'amazon.svg' });
  const { document } = fakeDocument();
  const badge = logos.createBadge('Amazon', { document,
    runtime: { getURL(asset) { return 'chrome-extension://test-extension/' + asset; } }
  });
  const image = badge.children[1];
  image.dispatch('error');
  image.dispatch('load');
  assert.equal(badge.getAttribute('data-loaded'), null);
  assert.equal(badge.children.length, 1);
});
