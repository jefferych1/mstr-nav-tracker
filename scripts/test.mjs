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

import { parseHoldings, parseAvgCost, parseUsdReserve, parseAsOf, parseAtmShares, parsePrefSales, parseRepurchases, parseSecurityRows, parseAmbiguousRows } from "./parse.mjs";
import { btcEvent, sharesEvent, prefEvent, reserveEvent, repurchaseEvent, mergeEvents, bps, wipeout } from "./events.mjs";

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
t("an explicit dash under a sales caption is zero, not unknown", () => {
  assert.equal(parseSecurityRows(EIGHT_K).sales.STRF, 0);
});
t("a series with no row at all is absent, not zero", () => {
  assert.equal(parseSecurityRows(EIGHT_K).sales.STRD, undefined);
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

/* The layout Strategy moved to in Sep 2026: holdings and ATM activity in prose, and a
   single table of BUYBACKS. Read naively, the STRC row here reports a $142m issuance when
   the company in fact retired $139.3m of it. */
const EIGHT_K_2026 = htmlToText(`
<html><body>
<p>Item 8.01 Other Events.</p>
<p>As of September 13, 2026, Strategy holds approximately 845,050 bitcoin that were acquired
at an aggregate purchase price of $63.73 billion and an average purchase price of
approximately $75,412 per bitcoin, inclusive of fees and expenses.</p>
<p>During the period from September 8, 2026 to September 13, 2026, Strategy did not sell any
shares under its at-the-market offering program and did not purchase or sell any bitcoin.</p>
<p>As of September 13, 2026, the balances of the USD Reserve and USD Cash were $5.10 billion
and $1.30 billion, respectively.</p>
<table><tr><td>Repurchase Program Updates</td></tr>
<tr><th>Security</th><th>Shares Repurchased</th><th>Aggregate Purchase Price (in millions)</th></tr>
<tr><td>MSTR Stock</td><td>&#8212;</td><td>$&#8212;</td></tr>
<tr><td>STRC Stock</td><td>1,420,467</td><td>$&nbsp;139.3</td></tr>
<tr><td>STRF Stock</td><td>&#8212;</td><td>$&#8212;</td></tr>
<tr><td>STRK Stock</td><td>&#8212;</td><td>$&#8212;</td></tr>
<tr><td>STRD Stock</td><td>&#8212;</td><td>$&#8212;</td></tr>
</table></body></html>`);

console.log("\nSep 2026 filing layout");
t("holdings come out of the prose form", () => {
  assert.equal(parseHoldings(EIGHT_K_2026), 845050);
});
t("average cost still parses from the prose form", () => {
  assert.equal(parseAvgCost(EIGHT_K_2026), 75412);
});
t("USD reserve still parses", () => {
  assert.equal(parseUsdReserve(EIGHT_K_2026), 5.1e9);
});
t("as-of date is the period end, not the filing date", () => {
  assert.equal(parseAsOf(EIGHT_K_2026), "2026-09-13");
});
t("a buyback is NEVER read as a preferred issuance", () => {
  assert.deepEqual(parsePrefSales(EIGHT_K_2026), []);
});
t("the buyback is read as a buyback, with the right size", () => {
  assert.deepEqual(parseRepurchases(EIGHT_K_2026), [{ security: "STRC", shares: 1420467 }]);
});
t("an explicit no-sales statement in prose means zero ATM shares", () => {
  assert.equal(parseAtmShares(EIGHT_K_2026), 0);
});
t("no security row is left unattributed in either layout", () => {
  assert.deepEqual(parseAmbiguousRows(EIGHT_K_2026), []);
  assert.deepEqual(parseAmbiguousRows(EIGHT_K), []);
});
t("a repurchase row outside any caption is flagged, not guessed", () => {
  const stray = htmlToText(`<html><body><p>STRC Stock 1,420,467</p></body></html>`);
  assert.deepEqual(parseAmbiguousRows(stray), ["STRC"]);
  assert.deepEqual(parsePrefSales(stray), []);
  assert.deepEqual(parseRepurchases(stray), []);
});

console.log("\nbuyback log entries");
t("retiring preferred lowers senior claims and the wipeout price", () => {
  const e = repurchaseEvent(META, [{ security: "STRC", shares: 1420467 }], BEFORE);
  assert.match(e.headline, /Repurchased 1,420,467 STRC/);
  assert.match(e.meaning, /pulls the wipeout bitcoin price down/);
  assert.match(e.meaning, /ranking ahead of the common/);
  assert.equal(e.estimated, true);
});
t("a common buyback is accretive to BTC per share", () => {
  const e = repurchaseEvent(META, [{ security: "MSTR", shares: 5000000 }], BEFORE);
  assert.match(e.meaning, /lifting BTC per 1,000 shares/);
  assert.equal(e.estimated, false);
});
t("the issuance and the buyback paths move the wipeout price opposite ways", () => {
  const up = prefEvent(META, [{ series: "STRC", shares: 1000000 }], BEFORE);
  const dn = repurchaseEvent(META, [{ security: "STRC", shares: 1000000 }], BEFORE);
  assert.ok(up.figs.wipeoutAfter > up.figs.wipeoutBefore);
  assert.match(dn.meaning, /down from/);
});

/* The strategy.com/shares table, in the shape the page actually publishes it. */
import { parseSharesTable, saneRow } from "./shares.mjs";
const SHARES_PAGE = htmlToText(`
<html><body><table>
<tr><th></th><th colspan="9">ADSO</th><th>FDSO</th></tr>
<tr><th></th><th>12/31/2020</th><th>12/31/2021</th><th>12/31/2022</th><th>12/31/2023</th>
<th>12/31/2024</th><th>12/31/2025</th><th>03/31/2026</th><th>06/30/2026</th><th>09/20/2026</th>
<th>09/20/2026</th></tr>
<tr><td>Total BTC</td><td>70,469</td><td>124,391</td><td>132,500</td><td>189,150</td><td>447,470</td>
<td>672,500</td><td>762,099</td><td>846,000</td><td>846,000</td><td>846,000</td></tr>
<tr><td>Shares Outstanding (in '000s)</td></tr>
<tr><td>Class A</td><td>76,230</td><td>93,215</td><td>95,848</td><td>149,041</td><td>226,138</td>
<td>292,422</td><td>326,582</td><td>351,963</td><td>400,867</td><td>-</td></tr>
<tr><td>Class B</td><td>19,640</td><td>19,640</td><td>19,640</td><td>19,640</td><td>19,640</td>
<td>19,640</td><td>19,640</td><td>19,640</td><td>19,640</td><td>-</td></tr>
<tr><td>Basic Shares Outstanding</td><td>95,870</td><td>112,855</td><td>115,488</td><td>168,681</td>
<td>245,778</td><td>312,062</td><td>346,223</td><td>371,604</td><td>420,507</td><td>-</td></tr>
<tr><td>ADSO / FDSO</td><td>124,510</td><td>149,234</td><td>156,113</td><td>207,636</td><td>281,735</td>
<td>344,897</td><td>378,834</td><td>401,283</td><td>450,108</td><td>-</td></tr>
</table></body></html>`);

console.log("\nstrategy.com/shares");
const ANCH = parseSharesTable(SHARES_PAGE);
t("one row per distinct date, duplicate FDSO column collapsed", () => {
  assert.equal(ANCH.length, 9);
  assert.equal(ANCH[0].d, "2020-12-31");
  assert.equal(ANCH[8].d, "2026-09-20");
});
t("share counts are scaled out of thousands", () => {
  assert.equal(ANCH[8].basic, 420507000);
  assert.equal(ANCH[8].dil, 450108000);
  assert.equal(ANCH[0].basic, 95870000);
});
t("bitcoin held is not scaled", () => {
  assert.equal(ANCH[8].hold, 846000);
  assert.equal(ANCH[0].hold, 70469);
});
t("diluted is never below basic", () => {
  for (const r of ANCH) assert.ok(r.dil >= r.basic, r.d);
  assert.ok(ANCH.every(saneRow));
});
t("a layout it does not recognise yields nothing rather than a guess", () => {
  assert.deepEqual(parseSharesTable("no table here at all"), []);
  assert.deepEqual(parseSharesTable(htmlToText("<p>12/31/2020 12/31/2021 nonsense</p>")), []);
});
t("the sanity gate rejects an implausible share count", () => {
  assert.equal(saneRow({ d: "2026-09-20", basic: 12 }), false);
  assert.equal(saneRow({ d: "2026-09-20", basic: 4e8, dil: 3e8 }), false);
});

console.log(`\n${pass} passed\n`);
