// Reads Strategy's own share-count table at strategy.com/shares.
//
// What this is for, and what it is not for. The page is the issuer's, and most of what it
// publishes elsewhere (mNAV, BTC Yield, the ARR figures) is company-defined and built to
// present the strategy well — BTC Yield, for instance, excludes by design the cost of the
// capital raised to buy the coins. None of that is imported. Only raw inputs are: share
// counts and the bitcoin total.
//
// And it does not replace the filings. SEC remains the source of record; this is a second
// reading of the same facts, and the value is in the disagreement. When both sources have a
// figure the filed one is kept and a divergence beyond tolerance raises a review flag,
// because an issuer's dashboard contradicting its own 8-K is exactly the thing worth being
// told about — and neither source tells you on its own.
//
// Scope note, honestly: the table carries year-ends plus a few quarter dates, not a dense
// series. It improves the anchors the history is interpolated between; it does not make the
// history reported rather than interpolated.
import { get, readJson, writeJson, htmlToText, log, warn } from "./lib.mjs";

export const SHARES_URL = "https://www.strategy.com/shares";

const LABELS = [
  { key: "hold", re: /Total\s+BTC/i, scale: 1 },
  { key: "classA", re: /Class\s+A/i, scale: 1000 },
  { key: "classB", re: /Class\s+B/i, scale: 1000 },
  { key: "basic", re: /Basic\s+Shares\s+Outstanding/i, scale: 1000 },
  { key: "dil", re: /ADSO\s*\/\s*FDSO|Assumed\s+Diluted/i, scale: 1000 },
];

const toIso = (mdY) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdY);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

/**
 * Parse the table out of the page text into [{ d, hold, basic, dil }], oldest first.
 * Pure, so scripts/test.mjs can check it against a fixture without a network call.
 * Returns [] rather than a guess if the layout is not what we expect.
 */
export function parseSharesTable(text) {
  // The column headers are a run of MM/DD/YYYY dates. The last one repeats because the
  // final column is FDSO for the same date; de-duplicate but keep order.
  const dateRow = text.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
  const dates = [];
  for (const d of dateRow) { const iso = toIso(d); if (iso && !dates.includes(iso)) dates.push(iso); }
  if (dates.length < 2) return [];

  // For each labelled row, take the numbers that follow it, stopping at the next label.
  const series = {};
  for (const { key, re, scale } of LABELS) {
    const m = re.exec(text);
    if (!m) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stop = after.search(/Class\s+[AB]|Basic\s+Shares|ADSO|Total\s+BTC|Options|RSU/i);
    const window = stop > 0 ? after.slice(0, stop) : after;
    const nums = (window.match(/\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g) || [])
      .map((n) => Number(n.replace(/,/g, "")) * scale)
      .filter((v) => isFinite(v) && v > 0);
    if (nums.length) series[key] = nums;
  }
  if (!series.basic && !series.dil) return [];

  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const row = { d: dates[i] };
    for (const k of ["hold", "basic", "dil"]) if (series[k] && series[k][i] != null) row[k] = series[k][i];
    // A row is only useful if it carries a share count; the FDSO column has dashes.
    if (row.basic || row.dil) out.push(row);
  }
  return out;
}

/** Plausibility gate — a layout change should produce nothing, never a wrong number. */
export function saneRow(r) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(r.d) &&
    (r.basic == null || (r.basic > 10e6 && r.basic < 5e9)) &&
    (r.dil == null || (r.dil > 10e6 && r.dil < 5e9)) &&
    (r.hold == null || (r.hold > 1000 && r.hold < 3e6)) &&
    (r.basic == null || r.dil == null || r.dil >= r.basic)
  );
}

/* ------------------------------------------------------------------ the job */

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = await readJson("current.json");
  const store = await readJson("shares-anchors.json", { anchors: [], checkedAt: null, review: [] });
  if (!current) throw new Error("data/current.json is missing — cannot run");

  const review = [];
  let rows = [];
  try {
    rows = parseSharesTable(htmlToText(await get(SHARES_URL))).filter(saneRow);
    log(`parsed ${rows.length} anchor row(s) from ${SHARES_URL}`);
  } catch (e) {
    warn(`could not read ${SHARES_URL}: ${e.message}`);
    review.push(`Could not read strategy.com/shares this run (${e.message}). Anchors unchanged.`);
  }

  if (rows.length) {
    // Reconcile the newest published column against what the filings job believes.
    const latest = rows[rows.length - 1];
    const TOL = 0.005; // half a percent — rounding and a few days' drift, not a real gap
    const cmp = [
      ["basic shares", latest.basic, current.basicShares],
      ["diluted shares", latest.dil, current.dilutedShares],
      ["bitcoin held", latest.hold, current.btcHoldings],
    ];
    for (const [label, theirs, ours] of cmp) {
      if (!(theirs > 0 && ours > 0)) continue;
      const gap = Math.abs(theirs / ours - 1);
      if (gap > TOL) {
        review.push(
          `strategy.com/shares (${latest.d}) reports ${label} ${Math.round(theirs).toLocaleString()} ` +
          `against ${Math.round(ours).toLocaleString()} from the filings — ${(gap * 100).toFixed(2)}% apart. ` +
          `The filed figure is kept; check ${SHARES_URL}.`
        );
      }
    }
    // Merge anchors by date, newest wins, so re-running is idempotent.
    const byDate = new Map((store.anchors || []).map((a) => [a.d, a]));
    for (const r of rows) byDate.set(r.d, { ...byDate.get(r.d), ...r, src: "strategy.com/shares" });
    store.anchors = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  }

  store.checkedAt = new Date().toISOString();
  store.review = review;
  store.note = "Quarter-end and year-end share/holdings anchors published by the issuer at "
    + SHARES_URL + ". Used to reconcile against the filed figures and to anchor the "
    + "interpolated history — never to overwrite a figure parsed from an SEC filing.";
  await writeJson("shares-anchors.json", store);

  // Surface any divergence on the page, alongside the filings job's own flags.
  const keep = (current.review || []).filter((r) => !/strategy\.com\/shares/.test(r));
  current.review = [...keep, ...review];
  await writeJson("current.json", current);

  log(review.length ? `${review.length} item(s) need review` : "reconciled clean");
  review.forEach((r) => log(" *", r));
}
