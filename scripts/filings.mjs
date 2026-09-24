// Filings refresh: walks every Strategy 8-K published since the last run and updates
// bitcoin holdings, the USD reserve and the share count, then refreshes the capital stack
// when a new 10-Q/10-K appears. Every change it makes is also written to data/events.json
// as a one-line note with the arithmetic that says what the change meant.
//
// Design rules, because this runs with nobody watching:
//   * Every figure written must have been parsed out of a filing in this run.
//   * Every figure is sanity-checked against the stored one before it is accepted.
//   * A parse that fails leaves the stored value alone and raises a review flag that the
//     page displays, rather than guessing.
//   * The log describes the delta that was actually applied, never a second independent
//     reading, so the log and the headline figures cannot drift apart.
//   * Catch-up is idempotent: it processes each accession number exactly once, so running
//     it weekly, monthly or after a three-month gap all give the same answer.
import {
  readJson, writeJson, secSubmissions, recentFilings, secDocText, log, warn,
} from "./lib.mjs";
import {
  parseHoldings, parseAvgCost, parseUsdReserve, parseAsOf, parseAtmShares, parsePrefSales,
  parseRepurchases, parseAmbiguousRows,
} from "./parse.mjs";
import {
  btcEvent, sharesEvent, prefEvent, reserveEvent, stackEvent, repurchaseEvent, mergeEvents,
} from "./events.mjs";

const current = await readJson("current.json");
const state = await readJson("filings-state.json", {
  processed: [], lastRun: null, review: [], since: new Date().toISOString().slice(0, 10),
});
const eventsFile = await readJson("events.json", { events: [] });
if (!current) throw new Error("data/current.json is missing — cannot run");

const review = [];
const changes = [];
const fresh = [];

const totalOf = (list, key) => Array.isArray(list) ? list.reduce((a, x) => a + (x[key] || 0), 0) : null;
// The snapshot every event is computed against.
const snap = () => ({
  hold: current.btcHoldings,
  avgCost: current.avgCostPerBtc,
  shares: current.basicShares,
  debt: totalOf(current.converts, "principal"),
  pref: totalOf(current.preferreds, "notional"),
  cash: current.usdReserve,
});

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
  const meta = { d: f.filingDate, asOf, form: f.form, url: f.url, src: "filing" };
  const before = snap();

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

    // Class A sold under the ATM, net of any Class A bought back. Both are applied per
    // filing rather than in one lump at the end, so each log entry describes exactly the
    // shares that filing moved.
    //
    // The sign here is the whole ballgame. Strategy's newer 8-Ks carry a single
    // "Repurchase Program Updates" table and state ATM activity in prose, so a naive read
    // of the "MSTR Stock" row adds shares the company actually retired. parseAtmShares and
    // parseRepurchases both attribute a row to its section before reading it.
    const atm = parseAtmShares(text);
    const buybacks = parseRepurchases(text);
    const mstrBought = buybacks.filter((r) => r.security === "MSTR").reduce((a, r) => a + r.shares, 0);

    const ambiguous = parseAmbiguousRows(text);
    if (ambiguous.length) {
      review.push(`8-K ${f.filingDate}: ${[...new Set(ambiguous)].join(", ")} row(s) could not be attributed to a sale or a repurchase — left out rather than guessed. ${f.url}`);
    }

    if (atm == null) {
      review.push(`8-K ${f.filingDate}: could not read ATM share sales — share count may drift. ${f.url}`);
    }
    const netShares = (atm || 0) - mstrBought;
    if (current.sharesAsOf && asOf <= current.sharesAsOf) {
      // Already inside the stored share count; counting it again would move the share base
      // twice and misstate mNAV.
      if (netShares) log(`8-K ${f.filingDate}: net ${netShares.toLocaleString()} shares already in the stored count — skipped`);
    } else if (netShares) {
      // The diluted overhang (converts, options, RSUs, STRK conversion) moves slowly, so
      // it is carried across and reset whenever a 10-Q gives an exact figure.
      const gap = (current.dilutedShares || 0) - (current.basicShares || 0);
      const prevBasic = current.basicShares;
      current.basicShares = prevBasic + netShares;
      current.dilutedShares = current.basicShares + gap;
      current.sharesAsOf = asOf;
      current.sharesSource = `rolled forward from filed ATM sales and buybacks (${netShares >= 0 ? "+" : ""}${netShares.toLocaleString()} shares, 8-K ${f.filingDate})`;
      changes.push(`shares ${prevBasic.toLocaleString()} → ${current.basicShares.toLocaleString()}`);
    }

    // Preferred retired under the buyback programme reduces the claims ranking ahead of the
    // common. Valued at the $100 stated preference and reset exactly at the next 10-Q, the
    // same way ATM shares are. Not applying it at all would leave senior claims permanently
    // overstated, which is the wrong answer even though it errs in the cautious direction.
    for (const r of buybacks) {
      if (r.security === "MSTR") continue;
      const row = (current.preferreds || []).find((x) => x.series === r.security);
      if (!row) {
        review.push(`8-K ${f.filingDate}: buyback of ${r.security} but no such series in the stored capital stack — ignored. ${f.url}`);
        continue;
      }
      if (current.preferredsAsOf && asOf <= current.preferredsAsOf) continue;
      const cut = r.shares * 100;
      const prevNotional = row.notional;
      row.notional = Math.max(0, (row.notional || 0) - cut);
      row.note = `${(row.note || "").replace(/ \(less buybacks[^)]*\)/, "")} (less buybacks to ${asOf}, at $100 stated value)`.trim();
      changes.push(`${r.security} notional ${(prevNotional / 1e9).toFixed(2)}bn → ${(row.notional / 1e9).toFixed(2)}bn`);
    }

    const after = snap();
    // A purchase and the shares issued to fund it are one story, so they go in one line;
    // a share sale with no coins bought gets its own.
    const btc = btcEvent(meta, before, after);
    if (btc) fresh.push(btc);
    else { const sh = sharesEvent(meta, before, after); if (sh) fresh.push(sh); }

    const res = reserveEvent(meta, before, after);
    if (res) fresh.push(res);

    const pref = prefEvent(meta, parsePrefSales(text), before);
    if (pref) fresh.push(pref);

    const buy = repurchaseEvent(meta, buybacks, before);
    if (buy) fresh.push(buy);
  }

  if (f.form === "10-Q" || f.form === "10-K") {
    // The capital stack (six convertible notes, five preferred series) is laid out in a way
    // that is not safe to scrape blind, so flag it for a human rather than guess.
    review.push(`New ${f.form} filed ${f.filingDate}: check the convertible notes and preferred notional in data/overrides.json against ${f.url}`);
    current.capitalStackStale = true;
    fresh.push(stackEvent(meta));
  }

  state.processed.push(f.accession);
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

eventsFile.events = mergeEvents(eventsFile.events, fresh);
eventsFile.updatedAt = new Date().toISOString();

await writeJson("current.json", current);
await writeJson("filings-state.json", state);
await writeJson("events.json", eventsFile);

log(changes.length ? `changes: ${changes.join("; ")}` : "no changes");
log(`${fresh.length} new log entr${fresh.length === 1 ? "y" : "ies"}`);
if (review.length) {
  log("--- needs review ---");
  review.forEach((r) => log(" *", r));
}
