import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = ['core.js', 'archive.js', 'seed.js', 'sync.js', 'background.js', 'logo-catalog.js', 'company-logos.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'explore.html', 'explore.css', 'explore.js', 'icons/leetcode.svg', 'icons/company-lens.svg', 'icons/README.md', 'data/snapshot.json.gz', 'data/snapshot-meta.json'];
const snapshotBytes = await readFile(path.join(root, 'extension/data/snapshot.json.gz'));
const snapshotMeta = JSON.parse(await readFile(path.join(root, 'extension/data/snapshot-meta.json'), 'utf8'));
assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), snapshotMeta.sha256, 'Regenerate the bundled snapshot: checksum mismatch');
const snapshot = JSON.parse(gunzipSync(snapshotBytes).toString('utf8'));
assert.equal(snapshot.commit, snapshotMeta.commit);
assert.equal(snapshot.companyCount, snapshotMeta.companies);
assert.equal(snapshot.problemCount, snapshotMeta.problems);
for (const window of ['all', '30d', '3m', '6m', 'older']) {
  assert.ok(snapshot.windows[window].available && snapshot.windows[window].companyCount === snapshot.companyCount,
    'The bundled snapshot must include complete company coverage in every window');
}
const logoCatalog = createRequire(import.meta.url)(path.join(root, 'extension', 'logo-catalog.js'));
const logoFiles = new Set(Object.values(logoCatalog));
assert.ok(logoFiles.size > 0, 'The company logo catalog must include bundled assets');
for (const filename of logoFiles) {
  assert.match(filename, /^[a-z0-9]+(?:[-_][a-z0-9]+)*\.(?:svg|png)$/, 'Logo filenames must be local and safe');
  const bytes = await readFile(path.join(root, 'extension', 'logos', filename));
  if (filename.endsWith('.png')) {
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Invalid PNG logo: ' + filename);
  } else {
    const svg = bytes.toString('utf8');
    assert.match(svg, /<svg\b/, 'Invalid SVG logo: ' + filename);
    assert.ok(!/<\s*(?:script|foreignObject|image|use|iframe|object|embed|style|a)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(/i.test(svg), 'Logo SVG must contain only local static graphics: ' + filename);
  }
}
const matches = ['https://leetcode.com/*', 'https://www.leetcode.com/*', 'https://leetcode.cn/*', 'https://www.leetcode.cn/*'];
const common = {
  manifest_version: 3,
  name: 'Company Lens for LeetCode',
  version: pkg.version,
  description: 'See company logos and frequency scores in a compact LeetCode bar. Search companies and problems from the toolbar.',
  permissions: ['storage', 'unlimitedStorage', 'alarms'],
  host_permissions: ['https://api.github.com/*', 'https://raw.githubusercontent.com/*', 'https://codeload.github.com/*', ...matches],
  action: { default_title: 'Company Lens', default_popup: 'popup.html', default_icon: {16:'icons/16.png',32:'icons/32.png'} },
  icons: {16:'icons/16.png',32:'icons/32.png',48:'icons/48.png',128:'icons/128.png'},
  content_scripts: [{ matches, js: ['core.js', 'logo-catalog.js', 'company-logos.js', 'content.js'], run_at: 'document_idle' }],
  web_accessible_resources: [{ resources: ['logos/*.svg', 'logos/*.png'], matches }],
  content_security_policy: {extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com https://codeload.github.com"}
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function zip(directory, output) {
  const entries = [];
  async function walk(dir, prefix = '') {
    for (const entry of (await readdir(dir, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir,entry.name), relative + '/');
      else entries.push({name:Buffer.from(relative),data:await readFile(path.join(dir,entry.name))});
    }
  }
  await walk(directory);
  const local = [], central = []; let offset = 0;
  for (const {name,data} of entries) {
    const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0x800,6);
    lh.writeUInt16LE(33,12); lh.writeUInt32LE(crc,14); lh.writeUInt32LE(data.length,18); lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(name.length,26);
    local.push(lh,name,data);
    const ch=Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6); ch.writeUInt16LE(0x800,8);
    ch.writeUInt16LE(33,14); ch.writeUInt32LE(crc,16); ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24); ch.writeUInt16LE(name.length,28); ch.writeUInt32LE(offset,42);
    central.push(ch,name); offset += lh.length+name.length+data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  await writeFile(output,Buffer.concat([...local,cd,end]));
}

async function copyLogoAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyLogoAssets(path.join(source, entry.name), path.join(destination, entry.name));
    else if (entry.isFile()) await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    else throw new Error('Unsupported logo asset entry: ' + entry.name);
  }
}

for (const browser of ['chrome','firefox']) {
  const out = path.join(root,'dist',browser);
  await mkdir(path.join(out,'icons'),{recursive:true});
  for (const file of files) {
    await mkdir(path.dirname(path.join(out,file)), {recursive:true});
    await copyFile(path.join(root,'extension',file),path.join(out,file));
  }
  await copyLogoAssets(path.join(root, 'extension', 'logos'), path.join(out, 'logos'));
  for (const size of [16,32,48,128]) await copyFile(path.join(root,'extension','icons',`${size}.png`),path.join(out,'icons',`${size}.png`));
  const manifest = structuredClone(common);
  if (browser === 'chrome') {
    manifest.minimum_chrome_version = '120';
    manifest.background = {service_worker:'background.js'};
  } else {
    manifest.background = {scripts:['core.js','archive.js','seed.js','sync.js','background.js']};
    manifest.browser_specific_settings = {gecko:{id:'company-lens@leetcode-tags.local',strict_min_version:'140.0',data_collection_permissions:{required:['none']}}};
  }
  await writeFile(path.join(out,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
  await zip(out,path.join(root,'dist',`company-lens-${browser}.zip`));
  console.log(`Built dist/${browser} and dist/company-lens-${browser}.zip`);
}
