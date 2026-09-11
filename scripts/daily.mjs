// Daily refresh: MSTR close + BTC price -> data/current.json and a new point in data/history.json.
// Runs unattended in GitHub Actions. Never invents a number: if a source fails, the previous
// value stays and the failure is recorded in current.json so the page can show it.
import {
  readJson, writeJson, firstOf, log, warn,
  mstrCloseSources, btcSources, saneMstr, saneBtc,
} from "./lib.mjs";

const nowIso = () => new Date().toISOString();

const current = await readJson("current.json");
const history = await readJson("history.json", { points: [] });
if (!current) throw new Error("data/current.json is missing — cannot run");

const problems = [];

// ---- prices -------------------------------------------------------------
let mstr = null, btc = null, mstrSrc = null, btcSrc = null;
try {
  const r = await firstOf("MSTR close", mstrCloseSources, saneMstr);
  mstr = r.value; mstrSrc = r.source;
} catch (e) { warn(e.message); problems.push(`MSTR price: ${e.message}`); }

try {
  const r = await firstOf("BTC price", btcSources, saneBtc);
  btc = r.value; btcSrc = r.source;
} catch (e) { warn(e.message); problems.push(`BTC price: ${e.message}`); }

// A >40% single-day move in either price is far more likely to be a bad parse than a real
// move, so refuse it and keep the stored value rather than corrupting the history.
const guard = (label, next, prev, tol = 0.4) => {
  if (next == null || prev == null) return next;
  const move = Math.abs(next / prev - 1);
  if (move > tol) {
    problems.push(`${label} moved ${(move * 100).toFixed(0)}% vs stored value — rejected as implausible`);
    warn(`rejecting ${label} ${next} (stored ${prev})`);
    return null;
  }
  return next;
};

const mstrClose = guard("MSTR price", mstr?.close, current.mstrPrice);
const btcPrice = guard("BTC price", btc, current.btcPrice);

// ---- update current -----------------------------------------------------
if (mstrClose != null) { current.mstrPrice = mstrClose; current.mstrCloseDate = mstr.date; }
if (btcPrice != null) current.btcPrice = btcPrice;
if (mstrClose != null || btcPrice != null) {
  current.pricesAsOf = nowIso();
  current.pricesSource = [
    mstrClose != null && `MSTR ${mstr.date} close via ${mstrSrc}`,
    btcPrice != null && `BTC via ${btcSrc}`,
  ].filter(Boolean).join("; ");
}
current.updatedAt = nowIso();
current.updatedBy = problems.length
  ? `daily refresh (with problems: ${problems.join(" | ")})`
  : "daily refresh";
current.problems = problems;

// ---- append / replace today's history point -----------------------------
const debt = (current.converts || []).reduce((a, c) => a + (c.principal || 0), 0) || null;
const pref = (current.preferreds || []).reduce((a, p) => a + (p.notional || 0), 0) || null;

if (mstrClose != null && btcPrice != null && current.btcHoldings > 0) {
  const point = {
    d: mstr.date,
    mstr: mstrClose,
    btc: btcPrice,
    hold: current.btcHoldings,
    basic: current.basicShares,
    dil: current.dilutedShares,
    debt,
    pref,
    cash: current.usdReserve ?? null,
  };
  const i = history.points.findIndex((p) => p.d === point.d);
  if (i >= 0) { history.points[i] = point; log(`replaced point ${point.d}`); }
  else { history.points.push(point); log(`appended point ${point.d}`); }
  history.points.sort((a, b) => (a.d < b.d ? -1 : 1));
  await writeJson("history.json", history);
} else {
  warn("no history point written this run");
  problems.push("history point skipped — incomplete price data");
}

await writeJson("current.json", current);
log(problems.length ? `done with ${problems.length} problem(s)` : "done cleanly");
// Exit non-zero only when nothing at all could be refreshed, so the Action goes red
// and emails Jeff rather than failing silently.
if (mstrClose == null && btcPrice == null) {
  console.error("FATAL: no prices could be refreshed from any source");
  process.exit(1);
}
