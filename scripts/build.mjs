import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = ['core.js', 'archive.js', 'seed.js', 'sync.js', 'background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'data/snapshot.json.gz', 'data/snapshot-meta.json'];
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
const matches = ['https://leetcode.com/*', 'https://www.leetcode.com/*', 'https://leetcode.cn/*', 'https://www.leetcode.cn/*'];
const common = {
  manifest_version: 3,
  name: 'Company Lens for LeetCode',
  version: pkg.version,
  description: 'See company tags on LeetCode problems, synced from the public liquidslr GitHub repository.',
  permissions: ['storage', 'unlimitedStorage', 'alarms'],
  host_permissions: ['https://api.github.com/*', 'https://raw.githubusercontent.com/*', 'https://codeload.github.com/*', ...matches],
  action: { default_title: 'Company Lens', default_popup: 'popup.html', default_icon: {16:'icons/16.png',32:'icons/32.png'} },
  icons: {16:'icons/16.png',32:'icons/32.png',48:'icons/48.png',128:'icons/128.png'},
  content_scripts: [{ matches, js: ['core.js', 'content.js'], run_at: 'document_idle' }],
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
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  name.copy(result, 4);
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8);
  return result;
}
// A small, original bracket/lens mark. Built with Node alone; no image dependencies.
function icon(size) {
  const pixels = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / size, py = y / size;
    const round = Math.hypot(Math.max(0.15 - px, 0, px - 0.85), Math.max(0.15 - py, 0, py - 0.85)) < 0.15;
    let color = [22, 48, 61, round ? 255 : 0];
    const left = Math.abs(px - (0.24 + Math.abs(py - 0.5) * 0.75)) < 0.035 && Math.abs(py - 0.5) < 0.22;
    const right = Math.abs(px - (0.76 - Math.abs(py - 0.5) * 0.75)) < 0.035 && Math.abs(py - 0.5) < 0.22;
    const dot = Math.hypot(px - 0.5, py - 0.5) < 0.065;
    if (left || right) color = [126, 224, 207, 255];
    if (dot) color = [244, 183, 88, 255];
    const i = y * (1 + size * 4) + 1 + x * 4;
    pixels.set(color, i);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(pixels)), chunk('IEND',Buffer.alloc(0))]);
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

for (const browser of ['chrome','firefox']) {
  const out = path.join(root,'dist',browser);
  await mkdir(path.join(out,'icons'),{recursive:true});
  for (const file of files) {
    await mkdir(path.dirname(path.join(out,file)), {recursive:true});
    await copyFile(path.join(root,'extension',file),path.join(out,file));
  }
  for (const size of [16,32,48,128]) await writeFile(path.join(out,'icons',`${size}.png`),icon(size));
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
