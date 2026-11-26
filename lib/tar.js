// Minimal reader for the gzip'd ustar/pax tarballs GitHub's codeload serves.
// Returns regular files only, as { path, data } with the leading "<repo>-<ref>/" folder stripped.
import { gunzipSync } from 'node:zlib';

function readString(buf, offset, length) {
  const end = buf.indexOf(0, offset);
  return buf.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}

function readOctal(buf, offset, length) {
  const s = readString(buf, offset, length).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(data.toString('utf8', i, space), 10);
    if (!len) break;
    const record = data.toString('utf8', space + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTarGz(gz, { filter } = {}) {
  const buf = gunzipSync(gz);
  const files = [];
  let offset = 0;
  let paxPath = null;
  let rootPrefix = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    let name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const magic = readString(header, 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = readString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }

    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') { paxPath = parsePax(data).path ?? null; continue; }
    if (type === 'g' || type === 'L' || type === 'K') continue;

    if (paxPath) { name = paxPath; paxPath = null; }
    if (rootPrefix === null) rootPrefix = name.includes('/') ? name.slice(0, name.indexOf('/') + 1) : '';
    if (type !== '0' && type !== '\0') continue;

    const rel = name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name;
    if (filter && !filter(rel, size)) continue;
    files.push({ path: rel, data: Buffer.from(data) });
  }
  return files;
}
