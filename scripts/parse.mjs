// Parsers for Strategy's SEC filings, kept separate from the job that runs them so they
// can be tested offline against fixture text (see scripts/test.mjs).
//
// Strategy has used at least two 8-K layouts. The older one puts everything in tables
// captioned "BTC Update" and "ATM Update". The newer one (seen from Sep 2026) states
// holdings and ATM activity in prose and carries a single table captioned "Repurchase
// Program Updates". Both are supported, and — this is the part that matters — a security
// row is never read without first working out which table it sits in. The same row label
// ("STRC Stock") means "issued" under an ATM caption and "retired" under a repurchase
// caption, and reading one as the other gets the sign of a nine-figure claim backwards.
import { num, parseLongDate } from "./lib.mjs";

/** The perpetual preferred series, in the order they appear in the capital stack. */
export const PREF_SERIES = ["STRC", "STRF", "STRK", "STRD", "STRE"];
const ALL_SECURITIES = ["MSTR", ...PREF_SERIES];

/* ------------------------------------------------------------------ holdings */

/** Total bitcoin held. Table form first, then the prose form used since Sep 2026. */
export function parseHoldings(text) {
  const anchors = [
    /Aggregate BTC Holdings/i,
    /aggregate of approximately/i,
    /holds approximately/i,          // "Strategy holds approximately 845,050 bitcoin"
    /holdings of approximately/i,
  ];
  for (const a of anchors) {
    const m = a.exec(text);
    if (!m) continue;
    const slice = text.slice(m.index, m.index + 700);
    // Holdings are always written with thousands separators, e.g. "845,050".
    for (const n of slice.match(/\b\d{1,3}(?:,\d{3})+\b/g) || []) {
      const v = num(n);
      if (v >= 100_000 && v <= 3_000_000) return v;
    }
  }
  return null;
}

/** Average purchase price per bitcoin, e.g. "$75,412".
 *  The old table row reads "845,050  $ 63.73  $ 75,412", so a single regex anchored on the
 *  first dollar sign lands on the aggregate-in-billions column. Scan the window instead and
 *  take the first comma-formatted figure that is plausible as a per-coin price. The newer
 *  prose form — "an average purchase price of approximately $75,412 per bitcoin" — falls
 *  out of the same scan. */
export function parseAvgCost(text) {
  const m = /Average Purchase Price/i.exec(text);
  if (!m) return null;
  const slice = text.slice(m.index, m.index + 400);
  for (const n of slice.match(/\$\s*\d{1,3}(?:,\d{3})+/g) || []) {
    const v = num(n);
    if (v > 1000 && v < 500_000) return v;
  }
  return null;
}

/** "As of September 13, 2026, the balances of the USD Reserve and USD Cash were $5.10 billion..." */
export function parseUsdReserve(text) {
  const m = /balances of the USD Reserve and USD Cash were\s*\$?\s*([\d.]+)\s*(billion|million)/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]) * (/billion/i.test(m[2]) ? 1e9 : 1e6);
  return v > 0 && v < 100e9 ? v : null;
}

/** The date the figures are stated as of. */
export function parseAsOf(text) {
  const m = /As of ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text);
  return m ? parseLongDate(m[1]) : null;
}

/* ------------------------------------------------- which table is this row in? */

// Captions that open a section. Everything after one, until the next, belongs to it.
const SECTIONS = [
  { kind: "repurchase", re: /Repurchase Program Update|Shares Repurchased/gi },
  { kind: "sale", re: /ATM Update|At[\s-]the[\s-]Market (Offering )?Update|Shares Sold/gi },
];

/** Index the filing's section captions by position, so a row can be attributed. */
export function sectionMap(text) {
  const marks = [];
  for (const { kind, re } of SECTIONS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) marks.push({ at: m.index, kind });
  }
  return marks.sort((a, b) => a.at - b.at);
}

/** The kind of section a given offset falls in, or null if it falls before any caption. */
export function sectionAt(marks, offset) {
  let kind = null;
  for (const mk of marks) {
    if (mk.at > offset) break;
    kind = mk.kind;
  }
  return kind;
}

/* --------------------------------------------------------------- security rows */

/** Read the share count that follows a "<TICKER> Stock" row label.
 *  Returns 0 for an explicit dash, null when the row is absent or unreadable — so the
 *  caller can tell "nothing" apart from "could not tell" and never treats the second as
 *  the first. */
function sharesAfter(text, at, labelLen) {
  const slice = text.slice(at + labelLen, at + labelLen + 160).trim();
  if (/^[—–-]/.test(slice)) return 0;
  const n = /^[^\d]{0,12}(\d{1,3}(?:,\d{3})+|\d{4,})/.exec(slice);
  if (!n) return null;
  const v = num(n[1]);
  return v >= 0 && v <= 200_000_000 ? v : null;
}

/**
 * Every "<TICKER> Stock" row in the filing, tagged with the section it sits in.
 * Returns { sales: {TICKER: shares}, repurchases: {TICKER: shares}, unattributed: [TICKER] }.
 * A row whose section cannot be determined goes in `unattributed` rather than being
 * guessed at — the caller turns that into a review flag.
 */
export function parseSecurityRows(text) {
  const marks = sectionMap(text);
  const sales = {}, repurchases = {}, unattributed = [];
  for (const tic of ALL_SECURITIES) {
    const re = new RegExp(`\\b${tic}\\s+Stock\\b`, "gi");
    let m;
    while ((m = re.exec(text))) {
      const v = sharesAfter(text, m.index, m[0].length);
      if (v == null) continue;
      const kind = sectionAt(marks, m.index);
      if (kind === "sale") sales[tic] = (sales[tic] || 0) + v;
      else if (kind === "repurchase") repurchases[tic] = (repurchases[tic] || 0) + v;
      else if (v > 0) unattributed.push(tic); // a zero row we cannot place is harmless
    }
  }
  return { sales, repurchases, unattributed };
}

/**
 * Class A common sold under the ATM.
 * Order matters: an explicit statement in the prose beats a table read, because the newer
 * filings say "did not sell any shares under its at-the-market offering program" and carry
 * no sales table at all — and the MSTR row that DOES exist in those filings is a
 * repurchase row, which must never be added to the share count.
 */
export function parseAtmShares(text) {
  if (/did not sell any shares under its at[\s-]the[\s-]market/i.test(text)) return 0;
  const { sales, repurchases } = parseSecurityRows(text);
  if (sales.MSTR != null) return sales.MSTR;
  // An MSTR row that only appears under a repurchase caption is not a sale of zero — it is
  // an absence of sales information. Say so rather than silently reporting none.
  if (repurchases.MSTR != null) return null;
  return null;
}

/** Preferred shares sold under the ATM, as [{ series, shares }]. */
export function parsePrefSales(text) {
  if (/did not sell any shares under its at[\s-]the[\s-]market/i.test(text)) return [];
  const { sales } = parseSecurityRows(text);
  return PREF_SERIES.filter((s) => sales[s] > 0).map((s) => ({ series: s, shares: sales[s] }));
}

/** Shares bought back, as [{ security, shares }] — preferred retirements reduce the claims
 *  ranking ahead of the common, and a common buyback lifts bitcoin per share. Both are the
 *  mirror image of an issuance and neither may be read as one. */
export function parseRepurchases(text) {
  const { repurchases } = parseSecurityRows(text);
  return ALL_SECURITIES.filter((s) => repurchases[s] > 0)
    .map((s) => ({ security: s, shares: repurchases[s] }));
}

/** Rows we could see but could not attribute to a sale or a repurchase. */
export function parseAmbiguousRows(text) {
  return parseSecurityRows(text).unattributed;
}
