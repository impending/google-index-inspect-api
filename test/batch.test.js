import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, HttpError, exitCodeFor, createSpacer, flatRow, toCsv, parseArgs } from '../lib.js';

const ok = (url) => ({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: `state:${url}` } } });
const rows = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://x.test/${i}`, property: 'sc-domain:x.test' }));
const noSpace = async () => {};

test('mixed success/failure batch keeps each result on its own URL', async () => {
  const r = rows(6);
  const inspect = async (url) => {
    if (url.endsWith('/0') || url.endsWith('/3')) throw new HttpError(403, 'forbidden');
    return ok(url);
  };
  const out = await runBatch(r, { inspect, spacer: noSpace, concurrency: 3 });
  assert.equal(out.data.length, 4);
  for (const d of out.data) assert.equal(d.inspectionResult.indexStatusResult.coverageState, `state:${d.url}`);
  assert.deepEqual(out.errors.map((e) => e.url).sort(), ['https://x.test/0', 'https://x.test/3']);
  assert.equal(out.remaining.length, 0);
  assert.equal(exitCodeFor(out), 0);
});

test('429 stops dispatch, drains in-flight, reports unstarted rows as remaining', async () => {
  const r = rows(20);
  let calls = 0;
  const inspect = async (url) => {
    calls++;
    if (url.endsWith('/4')) throw new HttpError(429, 'RESOURCE_EXHAUSTED');
    await new Promise((res) => setTimeout(res, 5));
    return ok(url);
  };
  const out = await runBatch(r, { inspect, spacer: noSpace, concurrency: 2 });
  assert.equal(out.quotaHit, true);
  assert.ok(calls < 20, 'stopped dispatching');
  assert.equal(out.data.length + out.errors.length + out.remaining.length, 20, 'every row accounted for');
  assert.ok(out.remaining.some((x) => x.url.endsWith('/4')), 'quota-failed row is remaining');
  assert.ok(out.remaining.every((x) => x.property === 'sc-domain:x.test'), 'remaining keeps property');
  assert.equal(exitCodeFor(out), 2);
});

test('retry once on 5xx and network errors, never on 4xx; retries use budget', async () => {
  const seen = {};
  const inspect = async (url) => {
    seen[url] = (seen[url] || 0) + 1;
    if (url.endsWith('/0') && seen[url] === 1) throw new HttpError(503, 'unavailable');
    if (url.endsWith('/1')) throw new TypeError('fetch failed');
    if (url.endsWith('/2')) throw new HttpError(404, 'nope');
    return ok(url);
  };
  const out = await runBatch(rows(3), { inspect, spacer: noSpace, concurrency: 1 });
  assert.equal(seen['https://x.test/0'], 2);
  assert.equal(seen['https://x.test/1'], 2);
  assert.equal(seen['https://x.test/2'], 1);
  assert.equal(out.attempts, 5);
  assert.equal(out.data.length, 1);
  assert.equal(out.errors.length, 2);
});

test('budget is reserved before dispatch; excess rows are remaining', async () => {
  let calls = 0;
  const out = await runBatch(rows(10), { inspect: async (u) => { calls++; return ok(u); }, spacer: noSpace, budget: 4, concurrency: 3 });
  assert.equal(calls, 4);
  assert.equal(out.attempts, 4);
  assert.equal(out.remaining.length, 6);
  assert.equal(out.budgetHit, true);
  assert.equal(exitCodeFor(out), 0);
});

test('global spacer spaces every dispatch', async () => {
  let t = 0; const waits = [];
  const space = createSpacer(200, () => t, async (ms) => { waits.push(ms); });
  await space(); await space(); await space();
  assert.deepEqual(waits, [200, 400]);
});

test('auth failure exits 1 even with no quota hit', () => {
  assert.equal(exitCodeFor({ authFailed: true }), 1);
});

test('flatRow handles absent and epoch lastCrawlTime', () => {
  const base = { url: 'u', inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL' } } };
  assert.equal(flatRow(base)['Last crawl'], 'Not crawled');
  base.inspectionResult.indexStatusResult.lastCrawlTime = '1970-01-01T00:00:00Z';
  assert.equal(flatRow(base)['Last crawl'], 'Not crawled');
  base.inspectionResult.indexStatusResult.lastCrawlTime = '2026-09-28T10:11:12Z';
  assert.equal(flatRow(base)['Last crawl'], '2026-09-28 10:11:12');
});

test('csv quoting and args', () => {
  assert.equal(toCsv([{ a: 'x,y', b: 'q"z' }]), 'a,b\n"x,y","q""z"\n');
  assert.deepEqual(parseArgs(['--urls', 'a.csv', '--unattended', '--budget', '5']), { urls: 'a.csv', unattended: true, budget: '5' });
});
