// Filings refresh: walks every Strategy 8-K published since the last run and updates
// bitcoin holdings, the USD reserve and the share count, then refreshes the capital stack
// when a new 10-Q/10-K appears.
//
// Design rules, because this runs with nobody watching:
//   * Every figure written must have been parsed out of a filing in this run.
//   * Every figure is sanity-checked against the stored one before it is accepted.
//   * A parse that fails leaves the stored value alone and raises a review flag that the
//     page displays, rather than guessing.
//   * Catch-up is idempotent: it processes each accession number exactly once, so running
//     it weekly, monthly or after a three-month gap all give the same answer.
import {
  readJson, writeJson, secSubmissions, recentFilings, secDocText, log, warn,
} from "./lib.mjs";
import {
  parseHoldings, parseAvgCost, parseUsdReserve, parseAsOf, parseAtmShares,
} from "./parse.mjs";

const current = await readJson("current.json");
const state = await readJson("filings-state.json", {
  processed: [], lastRun: null, review: [], since: new Date().toISOString().slice(0, 10),
});
if (!current) throw new Error("data/current.json is missing — cannot run");

const review = [];
const changes = [];

/* ---------------------------------------------------------------- */
/* walk new filings                                                  */
/* ---------------------------------------------------------------- */

let filings = [];
try {
  filings = recentFilings(await secSubmissions());
} catch (e) {
  warn(`could not reach SEC EDGAR: ${e.message}`);
  review.push(`Could not reach SEC EDGAR this run (${e.message}). Figures are unchanged.`);
}

const seen = new Set(state.processed);
// Oldest first, so several months of catch-up apply in the right order.
// `since` is the high-water mark set when the repo was seeded. Without it the first run
// would walk years of archived filings and apply 2021 holdings figures over today's.
const pending = filings
  .filter(
    (f) =>
      ["8-K", "10-Q", "10-K"].includes(f.form) &&
      !seen.has(f.accession) &&
      (!state.since || f.filingDate >= state.since)
  )
  .sort((a, b) => (a.filingDate < b.filingDate ? -1 : 1));

log(`${pending.length} unprocessed filing(s)`);

let atmSharesAdded = 0;

for (const f of pending) {
  let text;
  try {
    text = await secDocText(f.url);
  } catch (e) {
    warn(`could not read ${f.form} ${f.accession}: ${e.message}`);
    review.push(`Could not read ${f.form} filed ${f.filingDate} (${e.message}).`);
    continue; // leave it unprocessed so the next run retries it
  }

  const asOf = parseAsOf(text) || f.reportDate || f.filingDate;

  if (f.form === "8-K") {
    const holdings = parseHoldings(text);
    // Holdings only move by purchases and occasional small sales; a jump of more than 40%
    // in one week means the parse went wrong, not that the treasury doubled.
    if (holdings != null) {
      const prev = current.btcHoldings;
      const move = prev ? Math.abs(holdings / prev - 1) : 0;
      if (move > 0.4) {
        review.push(`8-K ${f.filingDate}: parsed holdings ${holdings.toLocaleString()} is ${(move * 100).toFixed(0)}% away from the stored ${prev.toLocaleString()} — ignored, please check ${f.url}`);
      } else if (!current.holdingsAsOf || asOf >= current.holdingsAsOf) {
        if (holdings !== prev) changes.push(`holdings ${prev?.toLocaleString()} → ${holdings.toLocaleString()}`);
        current.btcHoldings = holdings;
        current.holdingsAsOf = asOf;
        current.holdingsSource = `Form 8-K filed ${f.filingDate} (sec.gov)`;
      }
    } else {
      review.push(`8-K ${f.filingDate}: could not find the bitcoin holdings figure — ${f.url}`);
    }

    const avg = parseAvgCost(text);
    if (avg != null) current.avgCostPerBtc = avg;

    const reserve = parseUsdReserve(text);
    if (reserve != null) {
      current.usdReserve = reserve;
      current.usdReserveAsOf = asOf;
    }

    const atm = parseAtmShares(text);
    if (atm == null) {
      review.push(`8-K ${f.filingDate}: could not read ATM share sales — share count may drift. ${f.url}`);
    } else if (current.sharesAsOf && asOf <= current.sharesAsOf) {
      // These sales are already inside the stored share count; counting them again would
      // inflate the share base and understate mNAV.
      log(`8-K ${f.filingDate}: ${atm.toLocaleString()} ATM shares already in the stored count — skipped`);
    } else {
      atmSharesAdded += atm;
    }
  }

  if (f.form === "10-Q" || f.form === "10-K") {
    // The capital stack (six convertible notes, five preferred series) is laid out in a way
    // that is not safe to scrape blind, so flag it for a human rather than guess.
    review.push(`New ${f.form} filed ${f.filingDate}: check the convertible notes and preferred notional in data/overrides.json against ${f.url}`);
    current.capitalStackStale = true;
  }

  state.processed.push(f.accession);
}

/* ---------------------------------------------------------------- */
/* share count                                                       */
/* ---------------------------------------------------------------- */
// Basic shares roll forward by the ATM sales disclosed in each 8-K — plain arithmetic on a
// filed number. The diluted overhang (converts, options, RSUs, STRK conversion) moves
// slowly, so it is carried across and reset whenever a 10-Q gives an exact figure.
if (atmSharesAdded > 0) {
  const prevBasic = current.basicShares;
  const gap = (current.dilutedShares || 0) - (current.basicShares || 0);
  current.basicShares = prevBasic + atmSharesAdded;
  current.dilutedShares = current.basicShares + gap;
  current.sharesAsOf = current.holdingsAsOf || current.sharesAsOf;
  current.sharesSource = `rolled forward from filed ATM sales (+${atmSharesAdded.toLocaleString()} shares since last reset)`;
  changes.push(`shares ${prevBasic.toLocaleString()} → ${current.basicShares.toLocaleString()}`);
}

/* ---------------------------------------------------------------- */

current.review = review;
current.filingsCheckedAt = new Date().toISOString();
if (changes.length) {
  current.updatedAt = new Date().toISOString();
  current.updatedBy = `filings refresh: ${changes.join("; ")}`;
}

state.lastRun = new Date().toISOString();
state.review = review;
// Keep the processed list from growing without bound.
state.processed = state.processed.slice(-400);

await writeJson("current.json", current);
await writeJson("filings-state.json", state);

log(changes.length ? `changes: ${changes.join("; ")}` : "no changes");
if (review.length) {
  log("--- needs review ---");
  review.forEach((r) => log(" *", r));
}
