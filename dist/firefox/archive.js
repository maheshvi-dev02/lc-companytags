(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.LCTCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LCTArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_ENTRIES = 20000;
  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function gitBlobSHA(bytes) {
    const header = new TextEncoder().encode('blob ' + bytes.length + '\0');
    const input = new Uint8Array(header.length + bytes.length);
    input.set(header);
    input.set(bytes, header.length);
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', input));
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function bytesOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('GitHub archive was not binary data.');
  }

  function archiveEntries(input, commit) {
    const bytes = bytesOf(input);
    if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('GitHub archive size is invalid.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
        end = offset; break;
      }
    }
    if (end === -1) throw new Error('GitHub archive is truncated or missing its directory.');
    const count = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryOffset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
        view.getUint16(end + 8, true) !== count || !count || count > MAX_ENTRIES ||
        directoryOffset + directorySize !== end) throw new Error('Unsupported GitHub archive directory.');
    const prefix = 'leetcode-company-wise-problems-' + commit + '/';
    const entries = new Map();
    const ranges = [];
    let position = directoryOffset, expanded = 0;
    for (let index = 0; index < count; index += 1) {
      if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error('Malformed GitHub archive directory.');
      const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true);
      const crc = view.getUint32(position + 16, true), compressedSize = view.getUint32(position + 20, true);
      const size = view.getUint32(position + 24, true), nameLength = view.getUint16(position + 28, true);
      const extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true);
      const localOffset = view.getUint32(position + 42, true);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > end || view.getUint16(position + 34, true) || (flags & ~0x080e) ||
          ![0, 8].includes(method) || size > MAX_FILE_BYTES || compressedSize > MAX_ARCHIVE_BYTES ||
          compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('Unsupported, encrypted or oversized GitHub archive entry.');
      }
      const name = textDecoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
      const parts = name.replace(/\/$/, '').split('/');
      if (!name.startsWith(prefix) || name.includes('\\') || name.includes('\0') ||
          parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')) || entries.has(name)) {
        throw new Error('GitHub archive contains an unsafe or duplicate path.');
      }
      if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Malformed GitHub archive local header.');
      const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > directoryOffset || view.getUint16(localOffset + 6, true) !== flags ||
          view.getUint16(localOffset + 8, true) !== method ||
          textDecoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name ||
          (!(flags & 8) && (view.getUint32(localOffset + 14, true) !== crc ||
            view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== size))) {
        throw new Error('GitHub archive entry headers do not match.');
      }
      expanded += size;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error('GitHub archive expands beyond its size limit.');
      ranges.push([localOffset, dataOffset + compressedSize]);
      entries.set(name, { name, method, crc, size, compressed: bytes.subarray(dataOffset, dataOffset + compressedSize) });
      position = next;
    }
    if (position !== end) throw new Error('Malformed GitHub archive directory length.');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index][0] < ranges[index - 1][1]) throw new Error('GitHub archive entries overlap.');
    }
    return { entries, prefix };
  }

  async function unpack(entry) {
    let bytes;
    if (entry.method === 0) bytes = entry.compressed;
    else {
      if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress the GitHub archive.');
      const reader = new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > entry.size || size > MAX_FILE_BYTES) throw new Error('GitHub archive entry exceeds its declared size.');
          chunks.push(result.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error('GitHub archive CRC or size verification failed.');
    return bytes;
  }

  async function readCompanyArchive(input, options) {
    if (!options || !core.SHA_PATTERN.test(options.commit || '') || !Array.isArray(options.files) || !options.files.length) {
      throw new Error('Invalid expected GitHub archive metadata.');
    }
    const { entries, prefix } = archiveEntries(input, options.commit);
    const expected = new Set();
    for (const file of options.files) {
      if (!file || typeof file.path !== 'string' || !core.SHA_PATTERN.test(file.sha || '') ||
          expected.has(file.path) || !entries.has(prefix + file.path)) throw new Error('GitHub archive is missing or duplicates a selected company CSV.');
      expected.add(file.path);
    }
    const parsed = Object.create(null);
    for (const file of options.files) {
      const bytes = await unpack(entries.get(prefix + file.path));
      if ((await gitBlobSHA(bytes)).toLowerCase() !== file.sha.toLowerCase()) throw new Error('GitHub archive company CSV does not match its source blob SHA.');
      const value = { sha: file.sha, records: core.parseCompanyRecords(textDecoder.decode(bytes)) };
      parsed[file.path] = value;
      if (options.onFile) await options.onFile(file, value);
      if (options.yield) await options.yield();
    }
    return parsed;
  }

  return { readCompanyArchive, crc32, gitBlobSHA, MAX_ARCHIVE_BYTES };
});
