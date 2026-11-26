// Just enough of a zip reader to look inside a wheel: lists the central directory and extracts
// stored/deflated entries by name.
import { inflateRawSync } from 'node:zlib';

export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractZipEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('corrupt zip local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// Name / Version / Summary / Author from <dist>.dist-info/METADATA, plus a basic shape check
// matching what OrcaSlicer's read_wheel_plugin_metadata() insists on.
export function readWheelMetadata(buf) {
  const entries = readZipEntries(buf);
  const metaEntry = entries.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
  const wheelEntry = entries.find((e) => /^[^/]+\.dist-info\/WHEEL$/.test(e.name));
  if (!metaEntry || !wheelEntry) throw new Error('wheel has no .dist-info/METADATA or WHEEL file');
  const wheelText = extractZipEntry(buf, wheelEntry).toString('utf8');
  if (!/^Wheel-Version:/m.test(wheelText)) throw new Error('wheel WHEEL file is missing Wheel-Version');

  const meta = {};
  const text = extractZipEntry(buf, metaEntry).toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) break; // headers end at the first blank line
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'name') meta.name = m[2];
    else if (k === 'version') meta.version = m[2];
    else if (k === 'summary') meta.description = m[2];
    else if (k === 'author' || (k === 'author-email' && !meta.author)) meta.author = m[2];
  }
  if (!meta.name) throw new Error('wheel METADATA has no Name');
  return meta;
}
