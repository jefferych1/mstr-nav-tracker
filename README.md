# MSTR NAV Tracker

A static web page showing Strategy Inc. (Nasdaq: MSTR) market value against the bitcoin on
its balance sheet, with scenario sliders and history back to the first bitcoin purchase in
August 2020. It refreshes itself and needs no accounts, keys, logins or approvals once set up.

## How it runs

| Piece | What it does | When |
|---|---|---|
| `.github/workflows/daily.yml` | Records the MSTR close and bitcoin price, appends a point to the history | Weekdays, 22:30 UTC (06:30 Hong Kong) |
| `.github/workflows/filings.yml` | Reads new Strategy 8-Ks for bitcoin holdings, the USD reserve and ATM share sales | Tuesdays, 12:00 UTC |
| `index.html` | Reads `data/*.json` and draws the page; refreshes the bitcoin price live in the browser | On every visit |

Both jobs commit their results back to this repository, and GitHub Pages republishes the
site automatically. Nothing runs on your machine and nothing needs renewing.

## Setup

1. Create a new repository on GitHub and push these files to it (see `setup.sh`).
2. **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.
   The site appears at `https://<you>.github.io/<repo>/` within a minute or two.
3. **Settings → Actions → General** → under *Workflow permissions* choose
   **Read and write permissions**. Without this the jobs cannot commit the data they fetch.
4. **Settings → Secrets and variables → Actions → Variables** → add a variable named
   `SEC_USER_AGENT` with a value like `Jeff Hung mstr-tracker your@email.com`. The SEC asks
   for a contact address in the User-Agent header; requests without one may be throttled.
5. Go to **Actions**, pick *Daily prices*, and press **Run workflow** to confirm the first
   run is green. Do the same for *Filings refresh*.

That is the whole setup. Step 4 is the only one that is easy to forget, and the only
consequence of forgetting it is that the filings job may get rate-limited by the SEC.

### Custom domain (optional)

Put your domain in **Settings → Pages → Custom domain** and add a `CNAME` DNS record
pointing at `<you>.github.io`. GitHub issues the TLS certificate itself.

## Data

| File | Contents |
|---|---|
| `data/current.json` | Capital structure, holdings and the latest prices |
| `data/history.json` | One point per day: prices, holdings, shares, debt, preferreds, reserve |
| `data/overrides.json` | Your manual corrections, applied on top of `current.json` |
| `data/filings-state.json` | Which filings have been processed (do not hand-edit) |
| `data/events.json` | The filing log: one line per change, with the arithmetic of what it meant |

### Correcting a figure

Open `data/overrides.json` on github.com, press the pencil icon, add the key you want to
override and commit. The site picks it up within about a minute.

```json
{ "btcHoldings": 850000, "dilutedShares": 455000000 }
```

Remove the key again to go back to the filed figure. Overridden fields are outlined on the
page so it is obvious which numbers are yours rather than the filings'.

## When something breaks

The page shows a banner at the top whenever a job reported a problem, and a red one if the
last recorded close is more than five days old. GitHub also emails you when a workflow run
fails. Common cases:

- **A price source changed its format.** The daily job tries Stooq then Yahoo for MSTR, and
  Coinbase, CoinGecko then Kraken for bitcoin, so one failing is invisible. If all fail the
  run goes red and the stored values stay put — nothing is corrupted.
- **Strategy changes the layout of its 8-K.** The filings job leaves the stored figure alone
  and puts the filing's URL in the banner so you can enter the number in `overrides.json`.
- **A new 10-Q.** The convertible notes and preferred balances are the one thing that is not
  scraped, because those tables are too variable to parse safely. The job flags the filing
  and you update `data/current.json` or `data/overrides.json` by hand. Four times a year.

### The filing log

Every change the filings job applies is also written to `data/events.json` as a dated line
with a plain-English reading of it — how much of the stack a purchase was, what it implies
was paid per coin, and whether bitcoin per share went up or down as a result.

Two things make that trustworthy without anyone checking it. The line describes the delta
that was actually applied to `current.json`, not a second independent reading of the filing,
so the log and the headline figures cannot disagree. And the interpretation is arithmetic
rather than judgement — it is computed from the before/after snapshot, which is why a cron
job can write it and it is still worth reading.

Entries tagged **reconstructed** came from `scripts/backfill-events.mjs`, which derives the
history from the price/holdings backfill rather than from filings: no purchase price, and
Sep 2021–Sep 2025 is weekly, so a week's buying appears as one line. Decreases are not
backfilled at all, because a step down in a reconstructed series cannot be told apart from a
later revision to the record. Entries tagged **estimated** value preferred issuance at the
$100 stated liquidation preference, because the ATM tables report shares rather than dollars;
the exact balance arrives with the next 10-Q.

## Method

`BTC NAV = bitcoin held × bitcoin price`. Market-cap mNAV is `(price × shares) ÷ BTC NAV`.
EV mNAV adds convertible-note principal and preferred notional to the market cap and nets
the USD reserve, following Strategy's own presentation. "Assumed diluted" is Strategy's ADSO
figure — basic shares plus all converts, STRK conversions, options and RSUs regardless of
moneyness.

Between quarterly filings the basic share count rolls forward by the ATM sales disclosed in
each weekly 8-K, which is plain arithmetic on a filed number; the dilution overhang is
carried across and reset at each 10-Q. This is why the filings job runs weekly rather than
monthly: Strategy issues stock continuously, and a share count left stale for a quarter can
overstate mNAV by several percent. Change the cron in `filings.yml` if you would rather it
ran monthly.

History before this site existed is backfilled: actual split-adjusted MSTR and bitcoin
closes (daily for Aug 2020–Sep 2021 and Sep 2025 onwards, weekly in between), holdings from
the announced purchase history, and share counts interpolated between year-end figures. The
EV-basis line only starts once the daily job has recorded real capital-stack data, because
the daily debt, preferred and reserve balances for earlier years were never captured.

## Development

```sh
node scripts/test.mjs   # offline tests for the filing parsers
node scripts/daily.mjs  # run the daily refresh locally
python3 -m http.server 8080   # then open http://localhost:8080
```

No dependencies — Node 20+ built-ins only.
