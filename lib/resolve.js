// Turns a registry entry (just a GitHub repo) into concrete installable files, the way OrcaSlicer
// needs them: a single PEP 723 .py script or a .whl (see OrcaSlicer src/slic3r/plugin/PluginLoader.cpp).
//
// Order of preference:
//   1. .py / .whl assets on the latest GitHub release (API, or the HTML pages when rate limited)
//   2. .py files carrying a [tool.orcaslicer.plugin] PEP 723 block, or committed .whl files, in the
//      source tree at the latest release tag (or the default branch when there are no releases)
import crypto from 'node:crypto';
import { getBuffer, getJson, getRedirect, getText, HttpError } from './http.js';
import { readTarGz } from './tar.js';

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // plugin id -> { at, result, blobs: Map<key, Buffer> }

// ---------------------------------------------------------------- PEP 723 ----------

export function readPep723(text) {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let body = '';
  for (const line of lines) {
    if (!inBlock) { if (line === '# /// script') inBlock = true; continue; }
    if (line === '# ///') { inBlock = false; continue; }
    if (line.startsWith('# ') || line.startsWith('#\t')) body += line.slice(2) + '\n';
    else if (line === '#') body += '\n';
  }
  if (!body) return null;

  const meta = { dependencies: [] };
  let section = '';
  let inDeps = false;
  const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (inDeps) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) meta.dependencies.push(m[1]);
      if (line.includes(']')) inDeps = false;
      continue;
    }
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { section = sec[1].trim(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (section === '' && key === 'requires-python') meta.requiresPython = unquote(val);
    else if (section === '' && key === 'dependencies') {
      for (const m of val.matchAll(/["']([^"']+)["']/g)) meta.dependencies.push(m[1]);
      if (val.startsWith('[') && !val.includes(']')) inDeps = true;
    } else if (section === 'tool.orcaslicer.plugin' && ['name', 'version', 'description', 'author'].includes(key)) {
      meta[key] = unquote(val);
      meta.isOrcaPlugin = true;
    }
  }
  return meta;
}

// ---------------------------------------------------------------- wheels ----------

function parseWheelName(file) {
  const parts = file.replace(/\.whl$/i, '').split('-');
  if (parts.length < 5) return { name: parts[0], version: parts[1] || '', platform: 'any', standard: false };
  return { name: parts[0], version: parts[1], platform: parts[parts.length - 1], standard: true };
}

function wheelFitsThisMachine(platformTag) {
  const tags = platformTag.toLowerCase().split('.');
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64', 'universal2'] : ['amd64', 'x86_64', 'universal2'];
  return tags.some((t) => {
    if (t === 'any') return true;
    if (process.platform === 'win32') return t.startsWith('win') && arch.some((a) => t.endsWith(a));
    if (process.platform === 'darwin') return t.startsWith('macosx') && arch.some((a) => t.endsWith(a));
    return t.includes('linux') && !t.startsWith('musllinux') && arch.some((a) => t.endsWith(a));
  });
}

// Orca Cloud style per-OS artifacts carry the platform in a non-PEP 427 name, for .py files too:
// spoolio_win_x86_64.py, smooth_z_wall_speed_macosx_arm64.whl, u1control_any.whl.
// Returns null (no platform in the name), 'match' or 'mismatch'.
function namedPlatformFit(fileName) {
  const stem = fileName.replace(/\.(py|whl)$/i, '').toLowerCase();
  const m = /(?:^|[_.-])(win(?:dows)?|win32|linux|macosx|macos|darwin|any)(?:[_-](x86_64|amd64|x64|arm64|aarch64|universal2))?$/.exec(stem);
  if (!m) return null;
  if (m[1] === 'any') return 'match';
  const os = m[1].startsWith('win') ? 'win32' : m[1] === 'linux' ? 'linux' : 'darwin';
  if (os !== process.platform) return 'mismatch';
  if (!m[2] || m[2] === 'universal2') return 'match';
  const arm = m[2] === 'arm64' || m[2] === 'aarch64';
  return arm === (process.arch === 'arm64') ? 'match' : 'mismatch';
}

function fitsThisMachine(fileName) {
  const named = namedPlatformFit(fileName);
  if (named) return named === 'match';
  if (/\.whl$/i.test(fileName)) {
    const w = parseWheelName(fileName);
    return !w.standard || wheelFitsThisMachine(w.platform);
  }
  return true;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (isNaN(+x) ? x : +x));
  const pb = String(b).split(/[.+-]/).map((x) => (isNaN(+x) ? x : +x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

// ---------------------------------------------------------------- releases ----------

async function latestReleaseViaApi(owner, repo) {
  const releases = await getJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`);
  const rel = releases.find((r) => !r.draft && !r.prerelease) || releases.find((r) => !r.draft);
  if (!rel) return null;
  return {
    tag: rel.tag_name,
    prerelease: rel.prerelease,
    publishedAt: rel.published_at,
    assets: rel.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || null })),
  };
}

// No-API fallback: /releases/latest redirects to the tag, and the expanded_assets fragment lists
// the downloads. Used when the unauthenticated API budget (60 requests/hour) is spent.
async function latestReleaseViaHtml(owner, repo) {
  const loc = await getRedirect(`https://github.com/${owner}/${repo}/releases/latest`);
  const m = loc && /\/releases\/tag\/([^/?#]+)$/.exec(loc);
  const tag = m ? decodeURIComponent(m[1]) : await newestPrereleaseTagViaHtml(owner, repo);
  if (!tag) return null;
  return { ...(await releaseAssetsViaHtml(owner, repo, tag)), prerelease: !m };
}

// /releases/latest skips prereleases; with no stable release, take the newest entry on /releases, as the API path does.
async function newestPrereleaseTagViaHtml(owner, repo) {
  const html = await getText(`https://github.com/${owner}/${repo}/releases`);
  const prefix = `/${owner}/${repo}/releases/tag/`.toLowerCase();
  for (const [, href] of html.matchAll(/href="([^"]+\/releases\/tag\/[^"?#]+)"/g))
    if (href.toLowerCase().startsWith(prefix)) return decodeURIComponent(href.slice(prefix.length));
  return null;
}

async function releaseAssetsViaHtml(owner, repo, tag) {
  const html = await getText(`https://github.com/${owner}/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`);
  const prefix = `/${owner}/${repo}/releases/download/`.toLowerCase();
  const assets = [];
  for (const [, href] of html.matchAll(/href="([^"]+\/releases\/download\/[^"]+)"/g)) {
    if (!href.toLowerCase().startsWith(prefix)) continue;
    const name = decodeURIComponent(href.split('/').pop());
    if (!assets.some((a) => a.name === name)) assets.push({ name, url: `https://github.com${href}`, size: null, digest: null });
  }
  return { tag, publishedAt: null, assets };
}

// Once the anonymous API budget is spent, skip the API until GitHub says it resets.
let apiBlockedUntil = 0;

async function latestRelease(owner, repo) {
  if (Date.now() >= apiBlockedUntil) {
    try {
      return await latestReleaseViaApi(owner, repo);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      const reset = Number(err.headers?.get?.('x-ratelimit-reset')) * 1000;
      if (err.status === 403 || err.status === 429) apiBlockedUntil = reset > Date.now() ? reset : Date.now() + 15 * 60 * 1000;
    }
  }
  return latestReleaseViaHtml(owner, repo);
}

async function readChecksums(assets) {
  const sums = new Map();
  const file = assets.find((a) => /^(sha256sums|checksums)(\.txt)?$/i.test(a.name) || /\.sha256$/i.test(a.name));
  if (!file) return sums;
  try {
    const text = await getText(file.url);
    for (const line of text.split(/\r?\n/)) {
      const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (m) sums.set(m[2].trim().split('/').pop(), m[1].toLowerCase());
    }
  } catch {}
  return sums;
}

async function releaseCandidates(release, skipped) {
  const sums = await readChecksums(release.assets);
  const out = [];
  const wheelsByName = new Map();
  for (const a of release.assets) {
    const lower = a.name.toLowerCase();
    const digest = a.digest?.startsWith('sha256:') ? a.digest.slice(7) : sums.get(a.name) || null;
    if (/\.(py|whl)$/.test(lower) && !fitsThisMachine(a.name)) { skipped.push(a.name); continue; }
    if (lower.endsWith('.py')) {
      out.push({ kind: 'release', format: 'py', fileName: a.name, url: a.url, size: a.size, ref: release.tag, sha256: digest });
    } else if (lower.endsWith('.whl')) {
      const w = parseWheelName(a.name);
      const c = { kind: 'release', format: 'whl', fileName: a.name, url: a.url, size: a.size, ref: release.tag, sha256: digest, version: w.version };
      const prev = wheelsByName.get(w.name);
      // Some releases carry every historical wheel; keep the newest per distribution.
      if (!prev || compareVersions(w.version, prev.version) > 0) wheelsByName.set(w.name, c);
    }
  }
  return [...out, ...wheelsByName.values()];
}

// ---------------------------------------------------------------- source tree ----------

const SKIP_DIR = /(^|\/)(\.git|\.github|node_modules|venv|\.venv|__pycache__|site-packages|build)(\/|$)/i;

async function sourceCandidates(owner, repo, ref, blobs, skipped) {
  const gz = await getBuffer(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`, { timeoutMs: 90000 });
  const files = readTarGz(gz, {
    filter: (p, size) => !SKIP_DIR.test(p) && ((/\.py$/i.test(p) && size < 4 * 1024 * 1024) || (/\.whl$/i.test(p) && size < 80 * 1024 * 1024)),
  });
  const out = [];
  for (const f of files) {
    const fileName = f.path.split('/').pop();
    const key = `src:${f.path}`;
    if (!fitsThisMachine(fileName)) { if (/\.whl$/i.test(fileName) || readPep723(f.data.toString('utf8'))?.isOrcaPlugin) skipped.push(fileName); continue; }
    if (/\.py$/i.test(fileName)) {
      const meta = readPep723(f.data.toString('utf8'));
      if (!meta?.isOrcaPlugin || !meta.name) continue;
      blobs.set(key, f.data);
      out.push({ key, kind: 'source', format: 'py', fileName, path: f.path, ref, size: f.data.length, meta,
        url: `https://github.com/${owner}/${repo}/blob/${ref}/${f.path}` });
    } else {
      const w = parseWheelName(fileName);
      blobs.set(key, f.data);
      out.push({ key, kind: 'source', format: 'whl', fileName, path: f.path, ref, size: f.data.length, version: w.version,
        url: `https://github.com/${owner}/${repo}/blob/${ref}/${f.path}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- ranking ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function score(c, plugin) {
  let s = c.kind === 'release' ? 100 : 0;
  // A build made for this OS/arch beats a generic one when an author ships both.
  if (namedPlatformFit(c.fileName) === 'match' && !/_any\.(py|whl)$/i.test(c.fileName)) s += 20;
  const stem = norm(c.fileName.replace(/\.(py|whl)$/i, '').split('-')[0]);
  const id = norm(plugin.id), name = norm(plugin.name), metaName = norm(c.meta?.name);
  if (metaName && (metaName === name || metaName.includes(name) || name.includes(metaName))) s += 40;
  if (stem && (stem === id || id.includes(stem) || stem.includes(id) || name.includes(stem))) s += 30;
  if (c.path) s -= c.path.split('/').length * 3;
  if (c.path && /(^|\/)(tests?|examples?|samples?|docs?)\//i.test(c.path)) s -= 50;
  return s;
}

// ---------------------------------------------------------------- public ----------

export async function resolvePlugin(plugin, { refresh = false } = {}) {
  const hit = cache.get(plugin.id);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const warnings = [];
  const blobs = new Map();
  let release = null;
  try {
    release = await latestRelease(plugin.owner, plugin.repo);
  } catch (err) {
    warnings.push(`Could not read releases: ${err.message}`);
  }

  const skipped = [];
  let candidates = release ? await releaseCandidates(release, skipped) : [];
  // Prefer the released tag, but the plugin may have been added after the last release (the
  // release then only ships an app or library), so fall back to the default branch.
  const refs = release?.tag ? [release.tag, 'HEAD'] : ['HEAD'];
  for (const ref of refs) {
    if (candidates.length) break;
    try {
      candidates = await sourceCandidates(plugin.owner, plugin.repo, ref, blobs, skipped);
      if (candidates.length && ref === 'HEAD' && release?.tag)
        warnings.push(`Release ${release.tag} has no plugin file; these come from the latest development source.`);
    } catch (err) {
      warnings.push(`Could not scan the source at ${ref}: ${err.message}`);
    }
  }
  if (!candidates.length && ['wheel', 'source'].includes(plugin.installation?.method) && !release?.tag)
    warnings.push('The author publishes no prebuilt file; it has to be built from source.');

  candidates.forEach((c, i) => {
    c.key ||= `rel:${c.fileName}`;
    c.score = score(c, plugin);
    c.id = crypto.createHash('sha1').update(`${plugin.id}|${c.key}|${i}`).digest('hex').slice(0, 12);
  });
  candidates.sort((a, b) => b.score - a.score || a.fileName.localeCompare(b.fileName));

  const method = plugin.installation?.method;
  if (!candidates.length && (method === 'source' || method === 'native'))
    warnings.push(`This plugin is installed by building ${method === 'native' ? 'native code / a custom OrcaSlicer build' : 'from source'}; follow the author's instructions.`);
  else if (!candidates.length && skipped.length)
    warnings.push(`No build for this computer (${process.platform}/${process.arch}). Published only: ${[...new Set(skipped)].join(', ')}.`);
  else if (!candidates.length)
    warnings.push('No installable .py or .whl file was found on the latest release or in the source tree.');

  const result = {
    pluginId: plugin.id,
    release: release ? { tag: release.tag, prerelease: release.prerelease, publishedAt: release.publishedAt } : null,
    candidates: candidates.map(({ score: _s, ...c }) => c),
    warnings,
    resolvedAt: new Date().toISOString(),
  };
  cache.set(plugin.id, { at: Date.now(), result, blobs });
  return result;
}

// Bytes of a resolved candidate: source files are kept from the scan, release assets downloaded now.
export async function fetchCandidate(plugin, candidateId) {
  if (!cache.has(plugin.id)) await resolvePlugin(plugin);
  const { result, blobs } = cache.get(plugin.id);
  const c = result.candidates.find((x) => x.id === candidateId);
  if (!c) throw new Error('That file is no longer available, refresh the plugin and try again.');
  const data = blobs.get(c.key) || (await getBuffer(c.url, { timeoutMs: 180000 }));
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (c.sha256 && c.sha256.toLowerCase() !== sha256)
    throw new Error(`Checksum mismatch for ${c.fileName}: expected ${c.sha256}, got ${sha256}. Not installing.`);
  return { candidate: c, data, sha256, verified: !!c.sha256 };
}
