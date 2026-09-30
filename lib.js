// Helpers for the unattended bulk inspector (clear-adapt branch).
// Kept separate from index.js so the batch loop can be tested with a stub.

export const ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

// Minimal argument parser: --key value, --flag
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// One inspection request. Throws HttpError on non-2xx, Error on a malformed body.
export async function inspectUrl(inspectionUrl, siteUrl, accessToken, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ inspectionUrl, siteUrl }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`invalid JSON body: ${text.slice(0, 200)}`); }
  if (data.error) throw new HttpError(data.error.code || 500, JSON.stringify(data.error));
  if (!data.inspectionResult?.indexStatusResult) throw new Error('response has no inspectionResult.indexStatusResult');
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global dispatch spacing: every request (retries included) waits for its slot.
export function createSpacer(spacingMs, now = () => Date.now(), wait = sleep) {
  let next = 0;
  return async () => {
    const t = now();
    const slot = Math.max(t, next);
    next = slot + spacingMs;
    if (slot > t) await wait(slot - t);
  };
}

const isRetryable = (err) => !(err instanceof HttpError) || err.status >= 500;
const isQuota = (err) => err instanceof HttpError && err.status === 429;

/**
 * Inspect rows [{url, property}] with bounded concurrency.
 * Every attempt (first try or retry) consumes one unit of `budget` before dispatch.
 * On the first 429: stop dispatching, let in-flight requests finish, and report
 * every unstarted row plus rows that failed on quota as `remaining`.
 * Results carry their own url, so a failure never shifts another row's data.
 */
export async function runBatch(rows, { inspect, concurrency = 5, spacingMs = 200, budget = Infinity, spacer, log = () => {} }) {
  const space = spacer || createSpacer(spacingMs);
  const data = [];
  const errors = [];
  const remaining = [];
  let attempts = 0;
  let quotaHit = false;
  let budgetHit = false;
  let idx = 0;

  const reserve = () => {
    if (quotaHit || attempts >= budget) { if (attempts >= budget) budgetHit = true; return false; }
    attempts++;
    return true;
  };

  async function one(row) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!reserve()) { remaining.push(row); return; }
      await space();
      try {
        const value = await inspect(row.url, row.property);
        data.push({ ...value, url: row.url, property: row.property });
        log(`${row.url}: ${value.inspectionResult.indexStatusResult.coverageState}`);
        return;
      } catch (err) {
        if (isQuota(err)) { quotaHit = true; remaining.push(row); log(`429 on ${row.url}; stopping dispatch`); return; }
        if (attempt === 1 && isRetryable(err)) continue;
        errors.push({ url: row.url, property: row.property, status: err.status ?? null, message: err.message });
        return;
      }
    }
  }

  async function worker() {
    while (idx < rows.length) {
      const row = rows[idx++];
      if (quotaHit || attempts >= budget) { if (!quotaHit) budgetHit = true; remaining.push(row); continue; }
      await one(row);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { data, errors, remaining, attempts, quotaHit, budgetHit };
}

// Exit code: 1 error (auth or nothing usable), 2 quota hit (partial output), 0 ok.
export function exitCodeFor({ authFailed = false, quotaHit = false, fatal = false }) {
  if (authFailed || fatal) return 1;
  if (quotaHit) return 2;
  return 0;
}

// Flat CSV row in the upstream author's column shape.
export function flatRow({ url, inspectionResult: { indexStatusResult: r } }) {
  const lct = r.lastCrawlTime;
  const clean = {
    url,
    verdict: r.verdict,
    coverageState: r.coverageState,
    'Crawl allowed?': r.robotsTxtState,
    'Indexing allowed?': r.indexingState,
    'Last crawl': !lct || lct === '1970-01-01T00:00:00Z' ? 'Not crawled' : lct.replace('T', ' ').replace(/(\.\d+)?Z$/, ''),
    'Page fetch': r.pageFetchState,
    'User-declared canonical': r.userCanonical ?? 'No User-declared canonical',
    'Google-selected canonical': r.googleCanonical ?? 'Inspected URL',
  };
  (r.sitemap || []).forEach((s, i) => { clean[`sitemap-${i + 1}`] = s; });
  (r.referringUrls || []).forEach((s, i) => { clean[`referringUrl-${i + 1}`] = s; });
  return clean;
}

export function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n';
}
