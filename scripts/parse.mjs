// Parsers for Strategy's SEC filings, kept separate from the job that runs them so they
// can be tested offline against fixture text (see scripts/test.mjs).
import { num, parseLongDate } from "./lib.mjs";

/** Total bitcoin held, from the "BTC Update" table (the filings are tabular, not prose). */
export function parseHoldings(text) {
  const anchors = [/Aggregate BTC Holdings/i, /aggregate of approximately/i];
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
 *  The row reads "845,050  $ 63.73  $ 75,412", so a single regex anchored on the first
 *  dollar sign lands on the aggregate-in-billions column. Scan the window instead and
 *  take the first comma-formatted figure that is plausible as a per-coin price. */
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

/** "As of August 30, 2026, the balances of the USD Reserve and USD Cash were $5.10 billion..." */
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

/** Shares of one security sold under the ATM during the period covered by this 8-K.
 *  The filings carry a row per security — "MSTR Stock", "STRK Stock", "STRC Stock" and so
 *  on — with the share count first. Returns 0 for an explicit "no sales" dash, and null
 *  when the row is absent or unreadable, so the caller can tell "nothing sold" apart from
 *  "could not tell", and never silently treats the second as the first. */
export function parseSecuritySales(text, ticker) {
  const m = new RegExp(`\\b${ticker}\\s+Stock\\b`, "i").exec(text);
  if (!m) return null;
  const slice = text.slice(m.index + m[0].length, m.index + 160).trim();
  if (/^[—–-]/.test(slice)) return 0; // an explicit "no sales" dash
  const n = /^[^\d]{0,12}(\d{1,3}(?:,\d{3})+|\d{4,})/.exec(slice);
  if (!n) return null;
  const v = num(n[1]);
  return v >= 0 && v <= 200_000_000 ? v : null;
}

/** Class A common sold under the ATM. */
export const parseAtmShares = (text) => parseSecuritySales(text, "MSTR");

/** The perpetual preferred series, in the order they appear in the capital stack. */
export const PREF_SERIES = ["STRC", "STRF", "STRK", "STRD", "STRE"];

/** Preferred shares sold under the ATM, as [{ series, shares }] for the series that sold
 *  anything. A series whose row is missing is simply left out rather than assumed zero. */
export function parsePrefSales(text) {
  const out = [];
  for (const s of PREF_SERIES) {
    const v = parseSecuritySales(text, s);
    if (v != null && v > 0) out.push({ series: s, shares: v });
  }
  return out;
}

