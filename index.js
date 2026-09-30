import { writeFile, mkdir } from 'fs/promises'; // File System access via promises
import { resolve } from 'path'; // Easier directory path handling
import csv from 'csvtojson'; // Convert CSV to JSON
import { parseArgs, inspectUrl, runBatch, exitCodeFor, flatRow, toCsv } from './lib.js';
import { hasRefreshEnv, refreshTokenCredentials } from './auth.js';

// Arguments (clear-adapt): --urls <csv> --out <dir> --property <siteUrl> --budget <n>
//   --concurrency <n> --spacing <ms> --unattended --client-secret <path>
const args = parseArgs(process.argv.slice(2));
const folder = args.out || process.env.INSPECT_OUT || 'RESULTS';
const file = args.urls || process.env.INSPECT_URLS || './urls.csv';
const defaultProperty = args.property || process.env.INSPECT_PROPERTY || '';
const budget = args.budget ? Number(args.budget) : Infinity;
const concurrency = Number(args.concurrency || 5);
const spacingMs = Number(args.spacing ?? 200);

// Custom function to read URLs file
const readUrls = async (f) => csv().fromFile(f);

// Custom functions to get oAuth credentials from Google
const getCredentials = async () => {
  if (hasRefreshEnv()) return refreshTokenCredentials();
  if (args.unattended) throw new Error('--unattended set but GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN are missing');
  const { authenticate } = await import('@google-cloud/local-auth');
  const { credentials } = await authenticate({
    keyfilePath: resolve(args['client-secret'] || 'client-secret-REAL.json'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return credentials;
};

async function main() {
  console.time('inspect');
  await mkdir(folder, { recursive: true });

  const urls = (await readUrls(file)).map((r) => ({ url: r.url, property: r.property || defaultProperty }));

  console.log('Authenticating...');
  let credentials;
  try {
    credentials = await getCredentials();
  } catch (err) {
    console.error('FAILED TO AUTHENTICATE USER:', err.message);
    return exitCodeFor({ authFailed: true });
  }
  console.log(`Success authenticating user; ${urls.length} URLs, budget ${budget}`);

  const result = await runBatch(urls, {
    inspect: (u, p) => inspectUrl(u, p, credentials.access_token),
    concurrency,
    spacingMs,
    budget,
    log: (m) => console.log(m),
  });

  // Output shape kept from upstream: coverage.json, coverage.csv, errors.json (+ remaining.csv)
  await writeFile(`${folder}/coverage.json`, JSON.stringify(result.data, null, 2));
  await writeFile(`${folder}/coverage.csv`, result.data.length ? toCsv(result.data.map(flatRow)) : 'url\n');
  await writeFile(`${folder}/errors.json`, JSON.stringify(result.errors, null, 2));
  await writeFile(`${folder}/remaining.csv`, toCsv(result.remaining, ['url', 'property']));
  await writeFile(`${folder}/summary.json`, JSON.stringify({
    inspected: result.data.length, errors: result.errors.length, remaining: result.remaining.length,
    attempts: result.attempts, quotaHit: result.quotaHit, budgetHit: result.budgetHit,
  }, null, 2));

  console.log(`Retrieved Indexing status for ${result.data.length} URLs, ${result.errors.length} errors, ${result.remaining.length} remaining, ${result.attempts} attempts`);
  console.timeEnd('inspect');
  return exitCodeFor({ quotaHit: result.quotaHit, fatal: urls.length > 0 && result.data.length === 0 && result.errors.length > 0 });
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
