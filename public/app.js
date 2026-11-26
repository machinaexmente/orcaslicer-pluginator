// Pluginator UI. All registry text is untrusted (it comes from community YAML and GitHub), so it
// only ever reaches the DOM through esc() or textContent.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '#');

const INSTALLABLE = new Set(['python', 'wheel']);
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.5 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8L12 2.5Z"/></svg>';

const state = {
  catalog: null,
  installed: [],          // from /api/installed (what is on disk)
  records: {},            // registry id -> install record
  status: null,
  view: 'browse',
  search: '',
  sort: localGet('sort') || 'stars',
  cats: new Set(),
  onlyInstallable: localGet('onlyInstallable') !== '0',
  hideArchived: localGet('hideArchived') !== '0',
  openId: null,
  files: {},              // registry id -> resolve result
};

function localGet(k) { try { return localStorage.getItem(`pluginator.${k}`); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(`pluginator.${k}`, v); } catch {} }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Pluginator': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
}

// ---------------------------------------------------------------- data ----------

async function loadStatus() {
  state.status = await api('/api/status');
  const bar = $('#statusbar');
  const s = state.status;
  if (!s.exists) {
    bar.className = 'statusbar';
    bar.innerHTML = `OrcaSlicer data folder not found at <code>${esc(s.dataDir)}</code>. Start OrcaSlicer once, or set the folder in Settings.`;
    bar.hidden = false;
  } else if (s.orcaVersion && !/^(2\.(5|[6-9])|[3-9])\./.test(s.orcaVersion)) {
    bar.className = 'statusbar';
    bar.textContent = `OrcaSlicer ${s.orcaVersion} detected. Python plugins need OrcaSlicer 2.5 or newer.`;
    bar.hidden = false;
  } else bar.hidden = true;
  $('#installed-path').innerHTML = `<code>${esc(s.pluginsDir)}</code>${s.orcaVersion ? ` · OrcaSlicer ${esc(s.orcaVersion)}` : ''}`;
}

async function loadInstalled() {
  state.installed = await api('/api/installed');
  state.records = Object.fromEntries(state.installed.filter((p) => p.registryId).map((p) => [p.registryId, p.record]));
  $('#count-installed').textContent = state.installed.length || '';
}

async function loadCatalog(refresh = false) {
  const btn = $('#refresh');
  btn.classList.add('spinning');
  if (!state.catalog) $('#grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join('');
  try {
    state.catalog = await api(`/api/catalog${refresh ? '?refresh=1' : ''}`);
    if (refresh) state.files = {};
    if (state.catalog.stale) toast(`Offline: showing the cached catalogue (${state.catalog.error})`, 'error');
    $('#catalog-date').textContent = state.catalog.updatedAt ? `updated ${state.catalog.updatedAt}` : '';
    renderCategories();
    render();
  } catch (err) {
    $('#grid').innerHTML = `<div class="empty">Could not load the plugin catalogue.<br><span class="small">${esc(err.message)}</span></div>`;
  } finally {
    btn.classList.remove('spinning');
  }
}

// ---------------------------------------------------------------- browse ----------

function catName(id) {
  return state.catalog?.categories.find((c) => c.id === id)?.name || id;
}

function filtered() {
  const q = state.search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  let list = state.catalog.plugins.filter((p) => {
    if (state.onlyInstallable && !INSTALLABLE.has(p.installation?.method)) return false;
    if (state.hideArchived && (p.status === 'deprecated' || p.status === 'archived' || p.archived)) return false;
    if (state.cats.size && !p.categories.some((c) => state.cats.has(c))) return false;
    if (!terms.length) return true;
    const hay = `${p.name} ${p.summary} ${p.description} ${p.owner} ${p.repo} ${p.categories.map(catName).join(' ')}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (state.sort === 'name') list.sort(byName);
  else if (state.sort === 'updated') list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || byName(a, b));
  else list.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || byName(a, b));
  return list;
}

function renderCategories() {
  const counts = {};
  for (const p of state.catalog.plugins) for (const c of p.categories) counts[c] = (counts[c] || 0) + 1;
  $('#categories').innerHTML = state.catalog.categories.map((c) => `
    <button class="cat ${state.cats.has(c.id) ? 'on' : ''}" data-cat="${esc(c.id)}" title="${esc(c.description)}">
      <span>${esc(c.name)}</span><span class="count">${counts[c.id] || 0}</span>
    </button>`).join('');
  $('#clear-cats').hidden = !state.cats.size;
}

function badges(p) {
  const rec = state.records[p.id];
  const out = [];
  if (rec) out.push(`<span class="pill installed">Installed${rec.version ? ` v${esc(rec.version)}` : ''}</span>`);
  out.push(`<span class="pill status-${esc(p.status)}">${esc(p.status)}</span>`);
  if (p.installation?.method) out.push(`<span class="pill method">${esc(p.installation.method === 'python' ? '.py' : p.installation.method === 'wheel' ? '.whl' : p.installation.method)}</span>`);
  if (p.categories[0]) out.push(`<span class="pill">${esc(catName(p.categories[0]))}</span>`);
  return out.join('');
}

function render() {
  if (!state.catalog) return;
  $('#count-all').textContent = state.catalog.plugins.length;
  const list = filtered();
  $('#result-line').textContent = `${list.length} plugin${list.length === 1 ? '' : 's'}${list.length !== state.catalog.plugins.length ? ` of ${state.catalog.plugins.length}` : ''}`;
  $('#grid').innerHTML = list.length ? list.map((p) => `
    <button class="card" data-id="${esc(p.id)}">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(p.name)}</div>
          <div class="card-repo">${esc(p.owner)}/${esc(p.repo)}</div>
        </div>
        ${p.stars != null ? `<span class="stars">${STAR}${p.stars}</span>` : ''}
      </div>
      <div class="card-summary">${esc(p.summary)}</div>
      <div class="card-foot">${badges(p)}</div>
    </button>`).join('') : '<div class="empty">No plugins match these filters.</div>';
}

// ---------------------------------------------------------------- drawer ----------

function openDrawer(id) {
  const p = state.catalog.plugins.find((x) => x.id === id);
  if (!p) return;
  state.openId = id;
  if (location.hash !== `#/plugin/${id}`) history.replaceState(null, '', `#/plugin/${id}`);
  renderDrawer(p);
  $('#scrim').hidden = false;
  const d = $('#drawer');
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  d.focus();
  if (!state.files[id]) loadFiles(p);
}

function closeDrawer() {
  state.openId = null;
  history.replaceState(null, '', location.pathname);
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}

async function loadFiles(p, refresh = false) {
  state.files[p.id] = { loading: true };
  if (state.openId === p.id) renderDrawer(p);
  try {
    state.files[p.id] = await api(`/api/plugins/${p.id}/files${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    state.files[p.id] = { error: err.message };
  }
  if (state.openId === p.id) renderDrawer(p);
}

function fmtSize(n) {
  if (n == null) return '';
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function renderInstallBox(p) {
  const f = state.files[p.id];
  const rec = state.records[p.id];
  const method = p.installation?.method;
  const guide = p.installation?.url ? `<a href="${esc(safeUrl(p.installation.url))}" target="_blank" rel="noopener">author's install instructions</a>` : 'the author\'s instructions';

  if (!f || f.loading)
    return `<div class="install-box"><div class="install-row"><span class="spinner"></span> Looking for installable files on GitHub…</div></div>`;
  if (f.error)
    return `<div class="install-box"><div class="note danger">${esc(f.error)}</div><div class="install-row"><button class="btn" data-action="retry">Try again</button></div></div>`;

  const warn = f.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('');
  if (!f.candidates.length)
    return `<div class="install-box">${warn}<div class="muted small">Install it manually with ${guide}.</div>
      <div class="install-row"><button class="btn" data-action="retry">Check again</button></div></div>`;

  const files = f.candidates.map((c, i) => {
    const sameAsInstalled = rec && rec.fileName === c.fileName && rec.ref === c.ref;
    const version = c.meta?.version || c.version;
    return `
    <label class="file">
      <input type="radio" name="candidate" value="${esc(c.id)}" ${i === 0 ? 'checked' : ''}>
      <span class="file-name">${esc(c.fileName)}</span>
      <span class="file-meta">
        <span>${c.kind === 'release' ? `Release ${esc(c.ref)}` : `Source @ ${esc(c.ref)}${c.path && c.path !== c.fileName ? ` · ${esc(c.path)}` : ''}`}</span>
        ${version ? `<span>v${esc(version)}</span>` : ''}
        ${c.size ? `<span>${fmtSize(c.size)}</span>` : ''}
        ${c.sha256 ? '<span class="verified" title="Checked against the published SHA-256 before installing">✓ checksum</span>' : ''}
        ${sameAsInstalled ? '<span class="verified">installed</span>' : ''}
        <a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">view</a>
      </span>
    </label>`;
  }).join('');

  const label = !rec ? 'Install into OrcaSlicer' : 'Reinstall / update';
  const manual = !INSTALLABLE.has(method)
    ? `<div class="note warn">The registry lists this plugin's install method as “${esc(method || 'unknown')}”. A file was found anyway; check ${guide} before relying on it.</div>` : '';
  return `
    <div class="install-box">
      ${warn}${manual}
      <div class="section-title" style="margin:0">${f.candidates.length > 1 ? 'Choose a file' : 'File'}</div>
      <div class="files">${files}</div>
      <div class="install-row">
        <button class="btn primary big" data-action="install">${label}</button>
        <button class="btn" data-action="retry" title="Look for a newer release">Refresh</button>
      </div>
      <div class="muted small">Copies the file into <code>${esc(state.status?.pluginsDir || 'orca_plugins')}</code> the same way OrcaSlicer's own “install from file” does. No Orca Cloud account needed.</div>
    </div>`;
}

function renderDrawer(p) {
  const rec = state.records[p.id];
  const c = p.compatibility || {};
  const platforms = (c.platforms || []).join(', ') || 'not stated';
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(p.name)}</h2>
        <div class="muted small"><a href="${esc(safeUrl(p.repository))}" target="_blank" rel="noopener">${esc(p.owner)}/${esc(p.repo)}</a>
          ${p.stars != null ? ` · <span class="stars">${STAR}${p.stars}</span>` : ''}</div>
        <div class="card-foot" style="padding-top:8px">${badges(p)}</div>
      </div>
      <button class="icon-btn close" data-action="close" aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>
      </button>
    </div>
    <div class="drawer-body">
      <div>${esc(p.description || p.summary)}</div>
      ${p.statusNote ? `<div class="note ${p.status === 'available' ? '' : 'warn'}"><b>${esc(p.status)}:</b> ${esc(p.statusNote)}</div>` : ''}
      ${c.requires_custom_build ? '<div class="note danger">Needs a custom OrcaSlicer build. Stock releases cannot run it.</div>' : ''}
      ${rec ? `<div class="note ok">Installed ${rec.version ? `v${esc(rec.version)} ` : ''}from ${esc(rec.fileName)} (${esc(rec.ref || '')}) on ${esc(new Date(rec.installedAt).toLocaleString())}.
        <button class="link-btn" data-action="uninstall" data-folder="${esc(rec.folder)}">Uninstall</button></div>` : ''}

      ${renderInstallBox(p)}

      <div>
        <div class="section-title">Compatibility</div>
        <dl class="kv">
          <dt>OrcaSlicer</dt><dd>${esc(c.orca_slicer || 'not stated')}</dd>
          <dt>Platforms</dt><dd>${esc(platforms)}</dd>
          ${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}
          ${p.installation?.notes ? `<dt>Install notes</dt><dd>${esc(p.installation.notes)}</dd>` : ''}
          <dt>Categories</dt><dd>${p.categories.map((x) => esc(catName(x))).join(', ')}</dd>
          ${p.updatedAt ? `<dt>Listing updated</dt><dd>${esc(p.updatedAt)}</dd>` : ''}
        </dl>
      </div>

      ${p.evidence?.length ? `<div><div class="section-title">Sources</div><div class="links">${p.evidence.map((e) =>
        `<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.label || e.url)}</a>`).join('')}</div></div>` : ''}

      <div class="note small">Plugins are Python code from independent authors. They run inside OrcaSlicer with your user account, and nobody here has reviewed or tested them. OrcaSlicer asks before granting file, network or process access. Only install plugins you trust.</div>
    </div>`;
}

async function install(p, btn) {
  const candidateId = $('input[name="candidate"]:checked', $('#drawer'))?.value;
  if (!candidateId) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Installing…';
  try {
    const r = await api(`/api/plugins/${p.id}/install`, { method: 'POST', body: { candidateId } });
    await loadInstalled();
    render();
    if (state.openId === p.id) renderDrawer(p);
    toast(`${r.installed.name} installed. ${r.orcaRunning ? 'Restart OrcaSlicer to load it.' : 'It will load the next time OrcaSlicer starts.'}`, 'success');
    if (r.dependencies?.length) toast(`OrcaSlicer will download its Python dependencies on first load: ${r.dependencies.join(', ')}`);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Install into OrcaSlicer';
  }
}

async function uninstall(folder, name) {
  if (!confirm(`Remove ${name || folder} from OrcaSlicer?\n\nThis deletes the folder ${folder} under orca_plugins.`)) return;
  try {
    const r = await api(`/api/installed/${encodeURIComponent(folder)}/uninstall`, { method: 'POST' });
    await loadInstalled();
    render();
    renderInstalled();
    const p = state.openId && state.catalog.plugins.find((x) => x.id === state.openId);
    if (p) renderDrawer(p);
    toast(`Removed ${name || folder}.${r.orcaRunning ? ' Restart OrcaSlicer to unload it.' : ''}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- installed view ----------

function renderInstalled() {
  const list = state.installed;
  $('#installed-list').innerHTML = list.length ? list.map((p) => {
    const reg = p.registryId && state.catalog?.plugins.find((x) => x.id === p.registryId);
    const sub = [p.version && `v${esc(p.version)}`, esc(p.entryFile || ''), p.enabled === false ? 'disabled in OrcaSlicer' : '',
      p.record ? `from ${esc(p.record.ref || '')}` : p.installedFrom ? `installed by OrcaSlicer (${esc(p.installedFrom)})` : ''].filter(Boolean).join(' · ');
    return `
    <div class="irow">
      <div class="irow-main">
        <div class="irow-title">${esc(p.name)}</div>
        <div class="irow-sub" title="${esc(p.dir)}">${sub}</div>
        ${p.problem ? `<div class="note danger small" style="margin-top:6px">${esc(p.problem)}</div>` : ''}
      </div>
      <div class="irow-actions">
        ${reg ? `<button class="btn" data-open="${esc(reg.id)}">Details</button>` : ''}
        <button class="btn danger" data-uninstall="${esc(p.folder)}" data-name="${esc(p.name)}">Uninstall</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No local plugins installed yet. Plugins installed through Orca Cloud are managed by OrcaSlicer and are not listed here.</div>';
}

function setView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-browse').hidden = view !== 'browse';
  $('#view-installed').hidden = view !== 'installed';
  $$('[data-browse-only]').forEach((el) => (el.hidden = view !== 'browse'));
  if (view === 'installed') loadInstalled().then(renderInstalled);
}

// ---------------------------------------------------------------- settings ----------

async function openSettings() {
  await loadStatus();
  const s = state.status;
  $('#data-dir').value = s.customDataDir ? s.dataDir : '';
  $('#default-dir').textContent = s.defaultDataDir;
  $('#token-state').textContent = s.githubToken ? 'set' : 'not set';
  $('#data-dir-check').textContent = s.exists ? `Found${s.orcaVersion ? ` OrcaSlicer ${s.orcaVersion}` : ''} data at ${s.dataDir}` : `No OrcaSlicer data at ${s.dataDir}`;
  $('#settings').showModal();
}

// ---------------------------------------------------------------- wiring ----------

function wire() {
  let t;
  $('#search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value; if (state.view !== 'browse') setView('browse'); render(); }, 120); });
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; localSet('sort', state.sort); render(); });
  $('#only-installable').checked = state.onlyInstallable;
  $('#only-installable').addEventListener('change', (e) => { state.onlyInstallable = e.target.checked; localSet('onlyInstallable', e.target.checked ? '1' : '0'); render(); });
  $('#hide-archived').checked = state.hideArchived;
  $('#hide-archived').addEventListener('change', (e) => { state.hideArchived = e.target.checked; localSet('hideArchived', e.target.checked ? '1' : '0'); render(); });
  $('#categories').addEventListener('click', (e) => {
    const b = e.target.closest('.cat');
    if (!b) return;
    state.cats.has(b.dataset.cat) ? state.cats.delete(b.dataset.cat) : state.cats.add(b.dataset.cat);
    renderCategories(); render();
  });
  $('#clear-cats').addEventListener('click', () => { state.cats.clear(); renderCategories(); render(); });
  $('#grid').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openDrawer(c.dataset.id); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#refresh').addEventListener('click', async () => { await Promise.all([loadStatus(), loadInstalled()]); await loadCatalog(true); if (state.view === 'installed') renderInstalled(); });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.openId) closeDrawer(); });

  $('#drawer').addEventListener('click', (e) => {
    const p = state.catalog.plugins.find((x) => x.id === state.openId);
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a || !p) return;
    if (a === 'close') closeDrawer();
    else if (a === 'retry') loadFiles(p, true);
    else if (a === 'install') install(p, e.target.closest('button'));
    else if (a === 'uninstall') uninstall(e.target.dataset.folder, p.name);
  });
  $('#installed-list').addEventListener('click', (e) => {
    const u = e.target.closest('[data-uninstall]');
    if (u) return uninstall(u.dataset.uninstall, u.dataset.name);
    const o = e.target.closest('[data-open]');
    if (o) openDrawer(o.dataset.open);
  });
  $('#open-plugins-folder').addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: { which: 'plugins' } }).catch((err) => toast(err.message, 'error')));

  $('#open-settings').addEventListener('click', openSettings);
  $('#save-settings').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/settings', { method: 'POST', body: { dataDir: $('#data-dir').value } });
      $('#settings').close();
      await Promise.all([loadStatus(), loadInstalled()]);
      render(); renderInstalled();
      toast(r.exists ? `Using ${r.dataDir}` : `Saved, but no OrcaSlicer data was found at ${r.dataDir}`, r.exists ? 'success' : 'error');
    } catch (err) { toast(err.message, 'error'); }
  });
}

wire();
await Promise.all([loadStatus().catch((e) => toast(e.message, 'error')), loadInstalled().catch(() => {})]);
await loadCatalog();
const deepLink = /^#\/plugin\/([a-z0-9-]+)$/.exec(location.hash);
if (deepLink && state.catalog) openDrawer(deepLink[1]);
