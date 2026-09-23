// Offline tests. `node scripts/test.mjs` — no network, no dependencies.
// The 8-K fixture reproduces the real layout of Strategy's weekly filing: the figures sit
// in tables ("BTC Update", "ATM Update"), not in prose.
import assert from "node:assert/strict";
import { htmlToText, parseLongDate, num } from "./lib.mjs";

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
};

import { parseHoldings, parseAvgCost, parseUsdReserve, parseAsOf, parseAtmShares, parsePrefSales, parseSecuritySales } from "./parse.mjs";
import { btcEvent, sharesEvent, prefEvent, reserveEvent, mergeEvents, bps, wipeout } from "./events.mjs";

console.log("\nfilings parsers");

const EIGHT_K = htmlToText(`
<html><body>
<p>Item 8.01 Other Events.</p>
<table><tr><td>BTC Update</td></tr>
<tr><th>Aggregate BTC Holdings</th><th>Aggregate Purchase Price (in billions) (2)</th><th>Average Purchase Price (2)</th></tr>
<tr><td>845,050</td><td>$&nbsp;63.73</td><td>$&nbsp;75,412</td></tr></table>
<p>As of August 30, 2026, the balances of the USD Reserve and USD Cash were $5.10 billion
and $1.61 billion, respectively.</p>
<table><tr><td>ATM Update</td></tr>
<tr><th>Security</th><th>Shares Sold</th><th>&nbsp;</th><th>Net Proceeds</th><th>Remaining Capacity</th><th>Class</th></tr>
<tr><td>MSTR Stock</td><td>4,531,421</td><td>$-</td><td>$&nbsp;602.8 (4)</td><td>$19,090.8</td><td>Class A Common Stock</td></tr>
<tr><td>STRF Stock</td><td>&#8212;</td><td>$-</td><td>$&#8212;</td><td>$1,619.3</td><td>Preferred</td></tr>
<tr><td>STRC Stock</td><td>2,150,000</td><td>$-</td><td>$&nbsp;214.1</td><td>$4,110.2</td><td>Preferred</td></tr>
</table></body></html>`);

t("holdings from the BTC Update table", () => assert.equal(parseHoldings(EIGHT_K), 845050));
t("average purchase price", () => assert.equal(parseAvgCost(EIGHT_K), 75412));
t("USD reserve in billions", () => assert.equal(parseUsdReserve(EIGHT_K), 5.1e9));
t("as-of date", () => assert.equal(parseAsOf(EIGHT_K), "2026-08-30"));
t("ATM shares sold", () => assert.equal(parseAtmShares(EIGHT_K), 4531421));

const NO_SALES = htmlToText(`<table><tr><td>MSTR Stock</td><td>&#8212;</td><td>$&#8212;</td></tr></table>`);
t("a week with no ATM sales reads as zero, not a failure", () =>
  assert.equal(parseAtmShares(NO_SALES), 0));

const PROSE = htmlToText(`<p>As of January 5, 2027, the Company held an aggregate of
  approximately 901,325 bitcoins, acquired for $70.10 billion.</p>`);
t("prose wording still parses if they change format", () => assert.equal(parseHoldings(PROSE), 901325));

t("a filing with no figures returns null rather than a wrong number", () => {
  const junk = htmlToText("<p>Item 5.02. Departure of Directors. Dated March 3, 2027.</p>");
  assert.equal(parseHoldings(junk), null);
  assert.equal(parseUsdReserve(junk), null);
  assert.equal(parseAtmShares(junk), null);
});

t("a page number is never mistaken for holdings", () => {
  const small = htmlToText("<p>Aggregate BTC Holdings</p><p>1,234</p>");
  assert.equal(parseHoldings(small), null); // below the 100,000 floor
});

console.log("\nhelpers");
t("parseLongDate", () => assert.equal(parseLongDate("September 7, 2026"), "2026-09-07"));
t("parseLongDate single digit", () => assert.equal(parseLongDate("May 4, 2026"), "2026-05-04"));
t("num strips $ and commas", () => assert.equal(num("$ 1,234,567"), 1234567));
t("htmlToText drops scripts", () =>
  assert.equal(htmlToText("<p>a</p><script>var x=1</script><p>b</p>"), "a b"));


console.log("\npreferred sales");
t("reads a preferred row that sold shares", () => {
  assert.deepEqual(parsePrefSales(EIGHT_K), [{ series: "STRC", shares: 2150000 }]);
});
t("an explicit dash is zero, not unknown", () => {
  assert.equal(parseSecuritySales(EIGHT_K, "STRF"), 0);
});
t("a series with no row at all is unknown, not zero", () => {
  assert.equal(parseSecuritySales(EIGHT_K, "STRD"), null);
});

console.log("\nlog entries");
const META = { d: "2026-08-31", asOf: "2026-08-30", form: "8-K", url: "https://x", src: "filing" };
const BEFORE = { hold: 840447, avgCost: 75100, shares: 418079000, debt: 6713700000, pref: 15164100000, cash: 5100000000 };
const AFTER  = { hold: 845050, avgCost: 75412, shares: 420497000, debt: 6713700000, pref: 15164100000, cash: 5100000000 };

t("no change produces no entry", () => {
  assert.equal(btcEvent(META, BEFORE, BEFORE), null);
  assert.equal(sharesEvent(META, BEFORE, BEFORE), null);
  assert.equal(reserveEvent(META, BEFORE, BEFORE), null);
});
t("a purchase reports the delta and the new total", () => {
  const e = btcEvent(META, BEFORE, AFTER);
  assert.match(e.headline, /Added 4,603 BTC/);
  assert.match(e.headline, /845,050/);
  assert.equal(e.figs.added, 4603);
});
t("the price paid is backed out of the move in the lifetime average", () => {
  const e = btcEvent(META, BEFORE, AFTER);
  // (75412*845050 - 75100*840447) / 4603
  const want = (75412 * 845050 - 75100 * 840447) / 4603;
  assert.ok(Math.abs(e.figs.paid - want) < 1, `${e.figs.paid} vs ${want}`);
  assert.match(e.meaning, /lifetime average/);
});
t("an implausible implied price is dropped rather than printed", () => {
  const e = btcEvent(META, { ...BEFORE, avgCost: 75100 }, { ...AFTER, avgCost: 9 });
  assert.equal(e.figs.paid, null);
});
t("BTC per share falling is called dilutive, not accretive", () => {
  const e = btcEvent(META, BEFORE, AFTER);
  assert.ok(e.figs.bpsAfter < e.figs.bpsBefore);
  assert.match(e.meaning, /shares issued outran the coins/);
});
t("BTC per share rising is called accretive", () => {
  const e = btcEvent(META, BEFORE, { ...AFTER, shares: BEFORE.shares });
  assert.match(e.meaning, /coins bought outran the shares/);
});
t("a share sale with no coins bought gets its own entry", () => {
  const e = sharesEvent(META, BEFORE, { ...BEFORE, shares: 420497000 });
  assert.match(e.headline, /Issued 2,418,000 shares/);
  assert.match(e.meaning, /dilutive/);
});
t("preferred issuance is valued at stated value and moves the wipeout price", () => {
  const e = prefEvent(META, [{ series: "STRC", shares: 2150000 }], BEFORE);
  assert.equal(e.figs.estNotional, 215000000);
  assert.ok(e.figs.wipeoutAfter > e.figs.wipeoutBefore);
  assert.equal(e.estimated, true);
  assert.match(e.meaning, /stated value/);
});
t("an unknown preferred series is not priced", () => {
  assert.equal(prefEvent(META, [{ series: "ZZZZ", shares: 100 }], BEFORE), null);
});
t("wipeout and bps agree with the page's arithmetic", () => {
  assert.equal(wipeout(1000, 100, 50, 30), 0.12);
  assert.equal(bps(845050, 422525000), 2);
  assert.equal(bps(1, 0), null);
});
t("merge de-duplicates, sorts newest first and caps", () => {
  const a = { d: "2026-01-01", kind: "btc", headline: "x" };
  const b = { d: "2026-02-01", kind: "btc", headline: "y" };
  const out = mergeEvents([a, b], [a]);
  assert.equal(out.length, 2);
  assert.equal(out[0].d, "2026-02-01");
  assert.equal(mergeEvents([], Array.from({ length: 50 }, (_, i) => ({ d: "2026-01-01", kind: "b", headline: "h" + i })), 10).length, 10);
});
console.log(`\n${pass} passed\n`);
