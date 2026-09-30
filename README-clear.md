# clear-adapt: unattended bulk URL inspection

This branch adapts the upstream tool for unattended daily runs (Clear's index watch list).
`master` tracks upstream and is never edited; this branch lives on the `impending` fork (remote `fork`).

## Run

```bash
export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=...
node index.js --urls urls.csv --out RESULTS --unattended --budget 1500
```

| Argument | Default | Meaning |
|---|---|---|
| `--urls <csv>` | `./urls.csv` | header `url,property` |
| `--out <dir>` | `RESULTS` | output directory |
| `--property <siteUrl>` | per row | used when a row has no `property` |
| `--budget <n>` | unlimited | attempts (retries included) this run may make; reserved before each dispatch |
| `--concurrency <n>` | 5 | parallel requests |
| `--spacing <ms>` | 200 | global spacing between dispatches (retries included) |
| `--unattended` | off | fail (exit 1) instead of opening a browser when refresh-token env is missing |
| `--client-secret <path>` | `client-secret-REAL.json` | interactive fallback only |

Behaviour: 12 s request timeout, body validated, one retry on 5xx or network error, never on 4xx.
On the first HTTP 429 dispatch stops, in-flight requests drain, and unstarted or quota-failed rows
go to `remaining.csv` (with `property`).

Outputs: `coverage.json` (full API responses plus `url`), `coverage.csv` (upstream columns),
`errors.json` (`{url, property, status, message}`), `remaining.csv`, `summary.json`.

Exit codes: `0` ok, `2` quota hit (partial output written), `1` error (auth failure, or every row failed).

Bug fixed from upstream: results were matched to URLs by index after filtering fulfilled promises,
so a failure shifted every later result onto the wrong URL. Each result now carries its own URL.

## Update from upstream

```bash
git fetch origin && git rebase origin/master
npm ci && npm audit && npm test
git push fork clear-adapt
```

If a rebase conflicts twice, switch to the fallback client in clear-seo (`scripts/engine/lib/gsc.mjs`).
