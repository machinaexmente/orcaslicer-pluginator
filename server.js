#!/usr/bin/env node
// Pluginator: a standalone OrcaSlicer plugin browser. Serves a local UI on 127.0.0.1 and installs
// plugins into the OrcaSlicer data folder. No Orca Cloud login.
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, findPlugin, REGISTRY_REPO } from './lib/registry.js';
import { resolvePlugin, fetchCandidate } from './lib/resolve.js';
import { defaultDataDir, describeDataDir, isOrcaRunning, listInstalled, installPackage, uninstallFolder } from './lib/orca.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const args = process.argv.slice(2);
const PORT = Number(process.env.PORT || (args.find((a) => a.startsWith('--port='))?.split('=')[1]) || 47821);
const OPEN = !args.includes('--no-open');

const APP_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pluginator')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pluginator');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const INSTALLS_FILE = path.join(APP_DIR, 'installs.json');
const CACHE_DIR = path.join(APP_DIR, 'cache');

// ---------------------------------------------------------------- state ----------

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function settings() {
  const s = await readJson(SETTINGS_FILE, {});
  return { dataDir: s.dataDir || defaultDataDir(), customDataDir: !!s.dataDir };
}

// registry id -> { folder, fileName, version, ref, source, sha256, installedAt }, per data dir.
async function installRecords(dataDir) {
  const all = await readJson(INSTALLS_FILE, {});
  return all[path.resolve(dataDir).toLowerCase()] || {};
}
async function saveInstallRecords(dataDir, records) {
  const all = await readJson(INSTALLS_FILE, {});
  all[path.resolve(dataDir).toLowerCase()] = records;
  await writeJson(INSTALLS_FILE, all);
}

// Joins what is on disk with what Pluginator installed, dropping records for folders that are gone.
async function installedView(dataDir) {
  const [onDisk, records] = await Promise.all([listInstalled(dataDir), installRecords(dataDir)]);
  const folders = new Set(onDisk.map((p) => p.folder));
  const live = Object.fromEntries(Object.entries(records).filter(([, r]) => folders.has(r.folder)));
  if (Object.keys(live).length !== Object.keys(records).length) await saveInstallRecords(dataDir, live);
  const byFolder = Object.fromEntries(Object.entries(live).map(([id, r]) => [r.folder, id]));
  return { plugins: onDisk.map((p) => ({ ...p, registryId: byFolder[p.folder] || null, record: live[byFolder[p.folder]] || null })), records: live };
}

// ---------------------------------------------------------------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/status$/, async () => {
  const s = await settings();
  return { ...(await describeDataDir(s.dataDir)), customDataDir: s.customDataDir, defaultDataDir: defaultDataDir(), orcaRunning: await isOrcaRunning(), registry: `https://github.com/${REGISTRY_REPO}`, githubToken: !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN) };
});

route('POST', /^\/api\/settings$/, async (req) => {
  const { dataDir } = await body(req);
  const current = await readJson(SETTINGS_FILE, {});
  if (dataDir && typeof dataDir === 'string') current.dataDir = path.resolve(dataDir.trim());
  else delete current.dataDir;
  await writeJson(SETTINGS_FILE, current);
  return describeDataDir((await settings()).dataDir);
});

route('GET', /^\/api\/catalog$/, async (req, url) => {
  const catalog = await loadCatalog(CACHE_DIR, { refresh: url.searchParams.has('refresh') });
  const { records } = await installedView((await settings()).dataDir);
  return { ...catalog, installed: records };
});

route('GET', /^\/api\/plugins\/([a-z0-9-]+)\/files$/, async (req, url, [, id]) => {
  const plugin = findPlugin(await loadCatalog(CACHE_DIR), id);
  if (!plugin) throw Object.assign(new Error('Unknown plugin'), { status: 404 });
  return resolvePlugin(plugin, { refresh: url.searchParams.has('refresh') });
});

route('POST', /^\/api\/plugins\/([a-z0-9-]+)\/install$/, async (req, url, [, id]) => {
  const { candidateId } = await body(req);
  const plugin = findPlugin(await loadCatalog(CACHE_DIR), id);
  if (!plugin) throw Object.assign(new Error('Unknown plugin'), { status: 404 });
  const { dataDir } = await settings();

  const { candidate, data, sha256, verified } = await fetchCandidate(plugin, candidateId);
  const records = await installRecords(dataDir);
  const result = await installPackage({ dataDir, fileName: candidate.fileName, data, replacesFolder: records[id]?.folder });

  records[id] = {
    folder: result.folder, fileName: candidate.fileName, name: result.name, version: result.version,
    ref: candidate.ref, source: candidate.url, sha256, verified, installedAt: new Date().toISOString(),
  };
  await saveInstallRecords(dataDir, records);
  return { ok: true, installed: records[id], path: result.file, orcaRunning: await isOrcaRunning(), dependencies: result.dependencies || [] };
});

route('GET', /^\/api\/installed$/, async () => (await installedView((await settings()).dataDir)).plugins);

route('POST', /^\/api\/installed\/([^/]+)\/uninstall$/, async (req, url, [, folder]) => {
  const { dataDir } = await settings();
  await uninstallFolder(dataDir, decodeURIComponent(folder));
  await installedView(dataDir); // prunes the record
  return { ok: true, orcaRunning: await isOrcaRunning() };
});

route('POST', /^\/api\/open-folder$/, async (req) => {
  const { which } = await body(req);
  const s = await settings();
  const dir = which === 'plugins' ? path.join(s.dataDir, 'orca_plugins') : s.dataDir;
  await fs.mkdir(dir, { recursive: true });
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

const server = http.createServer(async (req, res) => {
  try {
    // Only answer to our own origin: blocks DNS rebinding, and the custom header on writes can't
    // be sent cross-site without a CORS preflight, which this server never approves.
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET' && req.headers['x-pluginator'] !== '1') return send(res, 403, { error: 'missing X-Pluginator header' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && r.pattern.exec(url.pathname);
        if (m) return send(res, 200, await r.handler(req, url, m));
      }
      return send(res, 404, { error: 'not found' });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    console.error(`[${req.method} ${req.url}]`, err.message);
    send(res, err.status || 500, { error: err.message });
  }
});

function openWindow(url) {
  // A chromeless Edge/Chrome "app" window makes it feel like a desktop app; fall back to the default browser.
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const exe = candidates.find((p) => { try { return fss.statSync(p).isFile(); } catch { return false; } });
    if (exe) return spawn(exe, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
    return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running: just bring up another window on the existing instance.
    console.log(`Pluginator is already running on port ${PORT}.`);
    if (OPEN) openWindow(`http://127.0.0.1:${PORT}/`);
    setTimeout(() => process.exit(0), 500);
  } else throw err;
});

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Pluginator running at ${url}`);
  console.log(`OrcaSlicer data folder: ${(await settings()).dataDir}`);
  if (OPEN) openWindow(url);
});
