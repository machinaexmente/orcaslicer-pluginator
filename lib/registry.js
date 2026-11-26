// Public plugin catalogue. Orca Cloud's own catalogue (api.orcaslicer.com/api/v1/plugins/explore)
// requires an account token, so the listing comes from OrcaBits (github.com/triluch/orcabits), a
// community-curated, no-login registry of GitHub-hosted OrcaSlicer plugins. The whole registry is
// fetched as one codeload tarball, which is not subject to the GitHub API rate limit.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { getBuffer } from './http.js';
import { readTarGz } from './tar.js';

export const REGISTRY_REPO = 'triluch/orcabits';
const TARBALL_URL = `https://codeload.github.com/${REGISTRY_REPO}/tar.gz/refs/heads/main`;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

let memo = null;

function parseRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(url || '');
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

function buildCatalog(files) {
  const byPath = new Map(files.map((f) => [f.path, f.data.toString('utf8')]));
  const catalog = YAML.parse(byPath.get('registry/catalog.yaml') || '{}') || {};
  const github = YAML.parse(byPath.get('registry/github.yaml') || '{}') || {};
  const stats = github.repositories || {};

  const plugins = [];
  const errors = [];
  for (const [p, text] of byPath) {
    const m = /^registry\/plugins\/([a-z0-9-]+)\.ya?ml$/.exec(p);
    if (!m) continue;
    try {
      const d = YAML.parse(text) || {};
      const repo = parseRepo(d.repository);
      if (!repo) throw new Error('missing GitHub repository');
      const stat = stats[`${repo.owner}/${repo.repo}`.toLowerCase()] || null;
      plugins.push({
        id: m[1],
        name: d.name || m[1],
        summary: d.summary || '',
        description: d.description || '',
        repository: d.repository,
        owner: repo.owner,
        repo: repo.repo,
        categories: d.categories || [],
        status: d.status || 'available',
        statusNote: d.status_note || '',
        installation: d.installation || {},
        compatibility: d.compatibility || {},
        evidence: d.evidence || [],
        updatedAt: d.updated_at || '',
        stars: typeof stat?.stars === 'number' ? stat.stars : null,
        archived: !!stat?.archived,
      });
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  plugins.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name));

  return {
    source: `https://github.com/${REGISTRY_REPO}`,
    fetchedAt: new Date().toISOString(),
    updatedAt: [catalog.updated_at, github.updated_at].filter(Boolean).map(String).sort().pop() || null,
    categories: catalog.categories || [],
    plugins,
    errors,
  };
}

export async function loadCatalog(cacheDir, { refresh = false } = {}) {
  if (!refresh && memo && Date.now() - Date.parse(memo.fetchedAt) < MAX_AGE_MS) return memo;

  const cacheFile = path.join(cacheDir, 'catalog.json');
  if (!refresh && !memo) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (Date.now() - Date.parse(cached.fetchedAt) < MAX_AGE_MS) return (memo = cached);
    } catch {}
  }

  try {
    const gz = await getBuffer(TARBALL_URL, { timeoutMs: 60000 });
    const files = readTarGz(gz, { filter: (p) => p.startsWith('registry/') && /\.ya?ml$/.test(p) });
    memo = buildCatalog(files);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(memo));
    return memo;
  } catch (err) {
    // Offline or GitHub down: fall back to the last good copy, however old.
    if (memo) return { ...memo, stale: true, error: err.message };
    try {
      memo = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      return { ...memo, stale: true, error: err.message };
    } catch {}
    throw err;
  }
}

export function findPlugin(catalog, id) {
  return catalog.plugins.find((p) => p.id === id) || null;
}
