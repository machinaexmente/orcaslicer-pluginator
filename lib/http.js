// fetch wrappers with a timeout, a fixed User-Agent and an optional GitHub token.
const UA = 'pluginator/0.1 (+OrcaSlicer plugin browser)';

export class HttpError extends Error {
  constructor(message, status, url, headers = null) {
    super(message);
    this.status = status;
    this.url = url;
    this.headers = headers;
  }
}

function headersFor(url, extra = {}) {
  const h = { 'User-Agent': UA, ...extra };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && /^https:\/\/api\.github\.com\//.test(url)) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function request(url, { timeoutMs = 30000, headers, redirect = 'follow' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: headersFor(url, headers), redirect, signal: ctrl.signal });
  } catch (err) {
    throw new HttpError(err.name === 'AbortError' ? `Timed out fetching ${url}` : `${err.message} (${url})`, 0, url);
  } finally {
    clearTimeout(timer);
  }
}

async function ok(res, url) {
  if (res.ok) return res;
  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch {}
  throw new HttpError(`HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ''}`, res.status, url, res.headers);
}

export async function getBuffer(url, opts) {
  const res = await ok(await request(url, opts), url);
  return Buffer.from(await res.arrayBuffer());
}

export async function getText(url, opts) {
  const res = await ok(await request(url, opts), url);
  return res.text();
}

export async function getJson(url, opts) {
  const res = await ok(await request(url, { ...opts, headers: { Accept: 'application/vnd.github+json', ...opts?.headers } }), url);
  return res.json();
}

// Location of a redirect without following it (used for github.com/<repo>/releases/latest).
export async function getRedirect(url, opts) {
  const res = await request(url, { ...opts, redirect: 'manual' });
  return res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
}
