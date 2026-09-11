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

import { parseHoldings, parseAvgCost, parseUsdReserve, parseAsOf, parseAtmShares } from "./parse.mjs";

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

console.log(`\n${pass} passed\n`);
