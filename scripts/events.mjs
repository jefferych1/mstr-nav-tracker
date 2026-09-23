// Turns the change a filing made into one line you can read.
//
// Two rules keep this trustworthy with nobody watching:
//
//   1. An event describes the delta the job ACTUALLY APPLIED to data/current.json — it is
//      not a second, independent reading of the filing. So if a parser returns nothing,
//      no event is invented; and if a parser returns something, the event and the headline
//      figures on the page can never disagree with each other.
//   2. The "meaning" half is arithmetic, not judgement. Every sentence below is computed
//      from the before/after snapshot. Nothing here needs a model at runtime, which is why
//      it can run in a cron job and still be worth reading.
//
// Everything is a pure function of (before, after), so scripts/test.mjs can check the
// wording and the maths offline.

/** Liquidation preference per preferred share. Strategy's perpetual preferreds are all
 *  $100-stated instruments; the ATM tables report shares, not dollars, so this is how a
 *  share count becomes a claim. Labelled as an estimate everywhere it is used, and
 *  superseded by the exact balance at the next 10-Q. */
const STATED_VALUE = { STRC: 100, STRF: 100, STRK: 100, STRD: 100, STRE: 100 };

const int = (n) => n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");
const usd = (n) => n == null || !isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const bn = (n) => n == null || !isFinite(n) ? "—" : "$" + (n / 1e9).toFixed(2) + "bn";
const pct = (n) => n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
const sig = (n, d = 4) => n == null || !isFinite(n) ? "—" : n.toFixed(d);

/** BTC per 1,000 basic shares — the number that says whether a quarter of issuing and
 *  buying actually left each share owning more bitcoin. */
export const bps = (hold, shares) => (hold > 0 && shares > 0) ? hold / shares * 1000 : null;

/** The bitcoin price at which the senior claims exactly consume the stack. */
export const wipeout = (hold, debt, pref, cash) =>
  hold > 0 ? ((debt || 0) + (pref || 0) - (cash || 0)) / hold : null;

/**
 * Bitcoin bought (or sold) in this filing.
 * `before`/`after`: { hold, avgCost, shares, debt, pref, cash }
 */
export function btcEvent(meta, before, after) {
  const added = (after.hold || 0) - (before.hold || 0);
  if (!added) return null;

  const share = before.hold ? added / before.hold : null;
  const verb = added > 0 ? "Added" : "Sold";

  // The price actually paid, backed out of the move in the lifetime average cost. This is
  // exact when both averages parsed, and simply omitted when they did not.
  let paid = null;
  if (added > 0 && before.avgCost > 0 && after.avgCost > 0 && before.hold > 0) {
    const p = (after.avgCost * after.hold - before.avgCost * before.hold) / added;
    if (p > 1000 && p < 10_000_000) paid = p;
  }

  const bits = [];
  if (share != null) bits.push(`${pct(share)} of the stack`);
  if (paid != null && after.avgCost > 0) {
    const vs = paid / after.avgCost - 1;
    bits.push(`paid about ${usd(paid)} a coin against a ${usd(after.avgCost)} lifetime average (${pct(vs)})`);
  }

  // Did the purchase outrun the shares issued to fund it?
  const b0 = bps(before.hold, before.shares), b1 = bps(after.hold, after.shares);
  if (b0 != null && b1 != null) {
    const dir = b1 > b0 ? "up" : b1 < b0 ? "down" : "flat";
    bits.push(`BTC per 1,000 shares ${sig(b0)} → ${sig(b1)} (${pct(b1 / b0 - 1)})`
      + (dir === "up" ? ", so the coins bought outran the shares issued to pay for them"
        : dir === "down" ? ", so the shares issued outran the coins they bought" : ""));
  }

  return {
    ...meta,
    kind: "btc",
    headline: `${verb} ${int(Math.abs(added))} BTC — holdings now ${int(after.hold)}`,
    meaning: bits.join(". ") + ".",
    figs: { added, hold: after.hold, paid, avgCost: after.avgCost, bpsBefore: b0, bpsAfter: b1 },
  };
}

/** Class A shares sold under the ATM, when no bitcoin moved with them. */
export function sharesEvent(meta, before, after) {
  const added = (after.shares || 0) - (before.shares || 0);
  if (!added || !before.shares) return null;
  const b0 = bps(before.hold, before.shares), b1 = bps(after.hold, after.shares);
  const bits = [`${pct(added / before.shares)} more shares outstanding`];
  if (b0 != null && b1 != null) {
    bits.push(`BTC per 1,000 shares ${sig(b0)} → ${sig(b1)} (${pct(b1 / b0 - 1)})`
      + (b1 < b0 ? " — dilutive on a per-share basis until the proceeds are spent on coins" : ""));
  }
  return {
    ...meta,
    kind: "shares",
    headline: `Issued ${int(added)} shares — ${int(after.shares)} outstanding`,
    meaning: bits.join(". ") + ".",
    figs: { added, shares: after.shares, bpsBefore: b0, bpsAfter: b1 },
  };
}

/**
 * Preferred stock sold under the ATM. The filings report share counts, so the claim is
 * estimated at the $100 stated liquidation preference and flagged as such — the exact
 * balance lands at the next 10-Q.
 * `sales`: [{ series, shares }]
 */
export function prefEvent(meta, sales, before) {
  const rows = (sales || []).filter((s) => s.shares > 0 && STATED_VALUE[s.series]);
  if (!rows.length) return null;
  const est = rows.reduce((a, r) => a + r.shares * STATED_VALUE[r.series], 0);

  const seniorBefore = (before.debt || 0) + (before.pref || 0) - (before.cash || 0);
  const seniorAfter = seniorBefore + est;
  const w0 = wipeout(before.hold, before.debt, before.pref, before.cash);
  const w1 = before.hold > 0 ? seniorAfter / before.hold : null;

  const bits = [
    `roughly ${bn(est)} of new claim at the $100 stated value, ahead of the common`,
    `senior claims net of the reserve ${bn(seniorBefore)} → about ${bn(seniorAfter)}`,
  ];
  if (w0 != null && w1 != null) {
    bits.push(`which lifts the wipeout bitcoin price from ${usd(w0)} to about ${usd(w1)}`);
  }
  bits.push("estimated from the share count — the exact balance is picked up at the next 10-Q");

  return {
    ...meta,
    kind: "pref",
    headline: `Issued ${rows.map((r) => `${int(r.shares)} ${r.series}`).join(", ")}`,
    meaning: bits.join(", ") + ".",
    figs: { sales: rows, estNotional: est, seniorBefore, seniorAfter, wipeoutBefore: w0, wipeoutAfter: w1 },
    estimated: true,
  };
}

/** A move in the USD reserve, which sits in front of the common in the same way cash does. */
export function reserveEvent(meta, before, after) {
  const d = (after.cash || 0) - (before.cash || 0);
  if (!d || !before.cash) return null;
  return {
    ...meta,
    kind: "reserve",
    headline: `USD reserve ${bn(before.cash)} → ${bn(after.cash)}`,
    meaning: `${d > 0 ? "Adds" : "Removes"} ${bn(Math.abs(d))} of the cash netted off enterprise value, `
      + `${d > 0 ? "lowering" : "raising"} EV-basis mNAV and ${d > 0 ? "lowering" : "raising"} the wipeout price.`,
    figs: { delta: d, cash: after.cash },
  };
}

/** A new 10-Q or 10-K: the capital stack needs a human. */
export function stackEvent(meta) {
  return {
    ...meta,
    kind: "stack",
    headline: `New ${meta.form} — capital stack needs checking`,
    meaning: "Convertible principal and preferred notional are laid out in a way that is not safe to "
      + "scrape blind, so they are left alone until checked against the filing and corrected in "
      + "data/overrides.json.",
    figs: {},
    review: true,
  };
}

/** Newest first, de-duplicated on (date, kind, headline), capped so the file cannot grow forever. */
export function mergeEvents(existing, fresh, cap = 400) {
  const key = (e) => `${e.d}|${e.kind}|${e.headline}`;
  const seen = new Set();
  return [...fresh, ...(existing || [])]
    .filter((e) => e && e.headline && !seen.has(key(e)) && seen.add(key(e)))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .slice(0, cap);
}
