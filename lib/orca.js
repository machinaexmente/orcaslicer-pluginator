// Installs plugins into the local OrcaSlicer setup exactly the way OrcaSlicer's own
// "install from file" does (src/slic3r/plugin/PluginLoader.cpp, plugin_loader::install_plugin):
//
//   <data_dir>/orca_plugins/<filesystem_safe_escape(file name)>/<file name>
//   <data_dir>/orca_plugins/<...>/.install_state.json
//
// OrcaSlicer discovers that folder on its next start-up scan; no Orca Cloud account is involved.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readPep723, compareVersions } from './resolve.js';
import { readWheelMetadata } from './zip.js';

const SIDECAR = '.install_state.json';

// Same as OrcaSlicer's filesystem_safe_escape (PluginDescriptor.hpp): keep [A-Za-z0-9_.-],
// collapse every other run into one '_'.
export function filesystemSafeEscape(value) {
  let out = '';
  for (const ch of Buffer.from(String(value), 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9_.-]/.test(c)) out += c;
    else if (!out.endsWith('_')) out += '_';
  }
  return out || 'path';
}

const FLATPAK_IDS = [
  ['com.orcaslicer.OrcaSlicer', 'Flatpak'],
  ['io.github.softfever.OrcaSlicer', 'Flatpak (old io.github.softfever id)'],
];

export function candidateDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') return [{ kind: 'Installed', dataDir: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'OrcaSlicer') }];
  if (process.platform === 'darwin') return [{ kind: 'Installed', dataDir: path.join(home, 'Library', 'Application Support', 'OrcaSlicer') }];
  // A flatpak gets its own XDG_CONFIG_HOME under ~/.var/app, whatever the host's is.
  return [
    ...FLATPAK_IDS.map(([id, kind]) => ({ kind, dataDir: path.join(home, '.var', 'app', id, 'config', 'OrcaSlicer') })),
    { kind: 'AppImage / native', dataDir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'OrcaSlicer') },
  ];
}

export async function detectInstalls() {
  const found = [];
  for (const c of candidateDataDirs()) {
    const d = await describeDataDir(c.dataDir);
    if (!d.hasConfig) continue;
    const mtime = (await fs.stat(path.join(c.dataDir, 'OrcaSlicer.conf')).catch(() => null))?.mtimeMs || 0;
    found.push({ kind: c.kind, ...d, lastUsed: mtime });
  }
  return found.sort((a, b) => compareVersions(b.orcaVersion || '0', a.orcaVersion || '0') || b.lastUsed - a.lastUsed);
}

export async function defaultDataDir() {
  const [best] = await detectInstalls();
  if (best) return best.dataDir;
  const candidates = candidateDataDirs();
  return (candidates.find((c) => exists(path.dirname(c.dataDir))) || candidates[candidates.length - 1]).dataDir;
}

export const pluginsRoot = (dataDir) => path.join(dataDir, 'orca_plugins');

function exists(p) {
  try { fss.accessSync(p); return true; } catch { return false; }
}

export async function describeDataDir(dataDir) {
  const conf = path.join(dataDir, 'OrcaSlicer.conf');
  let version = null;
  try {
    const m = /"version"\s*:\s*"(\d+\.\d+[^"]*)"/.exec(await fs.readFile(conf, 'utf8'));
    version = m?.[1] || null;
  } catch {}
  return { dataDir, exists: exists(dataDir), hasConfig: exists(conf), orcaVersion: version, pluginsDir: pluginsRoot(dataDir) };
}

export function isOrcaRunning() {
  if (process.platform === 'linux') return linuxOrcaRunning();
  return new Promise((resolve) => {
    const done = (err, stdout) => resolve(!err && /orca[-_ ]?slicer/i.test(String(stdout)));
    if (process.platform === 'win32')
      execFile('tasklist', ['/FI', 'IMAGENAME eq orca-slicer.exe', '/NH'], { windowsHide: true }, done);
    else execFile('pgrep', ['-il', 'orca'], done);
  });
}

// Orca renames its main thread to "orcaslicer_main", so pgrep can't find it by name; argv[0] is stable.
async function linuxOrcaRunning() {
  const pids = (await fs.readdir('/proc').catch(() => [])).filter((d) => /^\d+$/.test(d));
  for (const pid of pids) {
    const argv0 = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0')[0];
    if (path.basename(argv0) === 'orca-slicer') return true;
  }
  return false;
}

// ---------------------------------------------------------------- listing ----------

export async function listInstalled(dataDir) {
  const root = pluginsRoot(dataDir);
  let dirents = [];
  try { dirents = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const d of dirents) {
    // "__" = Orca's abandoned backups, "_subscribed" = Orca Cloud installs, "." = hidden.
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    const dir = path.join(root, d.name);
    const files = await fs.readdir(dir).catch(() => []);
    const entries = files.filter((f) => /\.(py|whl)$/i.test(f));
    let state = null;
    try { state = JSON.parse(await fs.readFile(path.join(dir, SIDECAR), 'utf8')); } catch {}
    let meta = null;
    if (entries.length === 1 && /\.py$/i.test(entries[0])) {
      try { meta = readPep723(await fs.readFile(path.join(dir, entries[0]), 'utf8')); } catch {}
    }
    out.push({
      folder: d.name,
      dir,
      entryFile: entries.length === 1 ? entries[0] : null,
      problem: entries.length === 0 ? 'no .py or .whl entry file' : entries.length > 1 ? 'more than one entry file' : null,
      name: meta?.name || state?.plugin_name || d.name,
      version: meta?.version || state?.installed_version || '',
      enabled: state?.enabled ?? null,
      installedFrom: state?.installed_from || null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- install ----------

export function inspectPackage(fileName, data) {
  if (!/^[^\\/:*?"<>|]+\.(py|whl)$/i.test(fileName) || fileName.startsWith('.'))
    throw new Error(`Unsupported plugin file name: ${fileName}`);
  if (/\.py$/i.test(fileName)) {
    const meta = readPep723(data.toString('utf8'));
    // OrcaSlicer refuses a .py without a name in [tool.orcaslicer.plugin] (PluginLoader.cpp).
    if (!meta?.name) throw new Error(`${fileName} has no PEP 723 [tool.orcaslicer.plugin] name, OrcaSlicer would reject it.`);
    return { format: 'py', name: meta.name, version: meta.version || '', description: meta.description || '', author: meta.author || '', dependencies: meta.dependencies };
  }
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new Error(`${fileName} is not a valid wheel (zip) file.`);
  const meta = readWheelMetadata(data);
  return { format: 'whl', name: meta.name, version: meta.version || '', description: meta.description || '', author: meta.author || '' };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to touch ${target}: outside ${root}`);
}

/**
 * @param {object} o
 * @param {string} o.dataDir          OrcaSlicer data directory
 * @param {string} o.fileName         plugin file name (.py / .whl)
 * @param {Buffer} o.data             plugin file bytes
 * @param {string} [o.replacesFolder] folder of a previous install of the same plugin, removed on success
 */
export async function installPackage({ dataDir, fileName, data, replacesFolder }) {
  const pkg = inspectPackage(fileName, data);
  const root = pluginsRoot(dataDir);
  await fs.mkdir(root, { recursive: true });

  const folder = filesystemSafeEscape(fileName);
  const finalDir = path.join(root, folder);
  assertInside(root, finalDir);

  // Keep the user's on/off choice and capability toggles across an update, like Orca does;
  // permissions are reset because the new code has to ask for them again.
  const previousDir = replacesFolder && replacesFolder !== folder ? path.join(root, replacesFolder) : null;
  if (previousDir) assertInside(root, previousDir);
  const prior = (await readJson(path.join(finalDir, SIDECAR), null)) || (previousDir && (await readJson(path.join(previousDir, SIDECAR), null)));

  let backupDir = null;
  if (exists(finalDir)) {
    backupDir = path.join(root, `__${folder}.backup-${crypto.randomBytes(4).toString('hex')}`);
    await fs.rename(finalDir, backupDir);
  }

  try {
    await fs.mkdir(finalDir, { recursive: true });
    await fs.writeFile(path.join(finalDir, fileName), data);
    const state = {
      installed_from: 'local',
      installed_version: pkg.version,
      plugin_name: pkg.name.replace(/;/g, '_'),
      enabled: typeof prior?.enabled === 'boolean' ? prior.enabled : true,
      permissions: {
        fs_read: false, fs_readwrite: false, fs_create: false, fs_delete: false,
        network_http: false, network_socket: false, process: false, threading: false,
        events: false, full_access: false, tools: false,
      },
      capabilities: Array.isArray(prior?.capabilities) ? prior.capabilities : [],
    };
    const tmp = path.join(finalDir, `${SIDECAR}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, path.join(finalDir, SIDECAR));
  } catch (err) {
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    if (backupDir) await fs.rename(backupDir, finalDir).catch(() => {});
    throw new Error(`Install failed: ${err.message}`);
  }

  if (backupDir) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  // A wheel update usually changes the file name (it embeds the version) and so the folder;
  // drop the old folder or Orca would list the plugin twice.
  if (previousDir && exists(previousDir)) await fs.rm(previousDir, { recursive: true, force: true }).catch(() => {});

  return { folder, dir: finalDir, file: path.join(finalDir, fileName), ...pkg };
}

export async function uninstallFolder(dataDir, folder) {
  const root = pluginsRoot(dataDir);
  if (!folder || folder.startsWith('_') || folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..')
    throw new Error('Invalid plugin folder');
  const dir = path.join(root, folder);
  assertInside(root, dir);
  if (!exists(dir)) throw new Error(`${folder} is not installed`);
  await fs.rm(dir, { recursive: true, force: true });
}
