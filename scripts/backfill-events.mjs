// One-off seed for data/events.json, so the log is not empty until the next 8-K lands.
//
// These entries are DERIVED from data/history.json — the holdings and share counts the
// backfill already carries — not read from the filings themselves. That means no purchase
// price and, for Sep 2021–Sep 2025 where the history is weekly, a week's purchases arrive
// as one line. Both facts are recorded on every entry (`src: "derived"`, `res`), and the
// page labels them, so a derived line is never mistaken for a parsed one.
//
// Run once:  node scripts/backfill-events.mjs
import { readJson, writeJson, log } from "./lib.mjs";
import { bps, mergeEvents } from "./events.mjs";

const hist = await readJson("history.json");
const file = await readJson("events.json", { events: [] });
if (!hist?.points?.length) throw new Error("data/history.json is missing or empty");

const int = (n) => Math.round(n).toLocaleString("en-US");
const pct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
const sig = (n) => n == null ? "—" : n.toFixed(4);

const pts = hist.points.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
const out = [];
let skippedDown = 0;

for (let i = 1; i < pts.length; i++) {
  const a = pts[i - 1], b = pts[i];
  if (!(a.hold > 0 && b.hold > 0)) continue;
  const added = b.hold - a.hold;
  if (!added) continue;
  // Ignore rounding-scale wobble in the interpolated early series.
  if (Math.abs(added) < 500 && Math.abs(added / a.hold) < 0.002) continue;
  // Only increases. A step DOWN in this series cannot be told apart from a later revision
  // to the holdings record the backfill was built from, and "sold 1,691 BTC" is too
  // specific a claim to publish off a number that might just have been restated. Real
  // disposals arrive through the filings job, which reads them from the 8-K itself.
  if (added < 0) { skippedDown++; continue; }

  const b0 = bps(a.hold, a.basic), b1 = bps(b.hold, b.basic);
  const weekly = b.res === "w";
  const bits = [`${pct(added / a.hold)} of the stack`];
  if (b0 != null && b1 != null) {
    bits.push(`BTC per 1,000 shares ${sig(b0)} → ${sig(b1)} (${pct(b1 / b0 - 1)})`
      + (b1 > b0 ? ", so the coins bought outran the shares issued to pay for them"
        : b1 < b0 ? ", so the shares issued outran the coins they bought" : ""));
  }
  if (weekly) bits.push("aggregated over the week, from the weekly backfill");

  out.push({
    d: b.d,
    asOf: b.d,
    form: null,
    url: null,
    src: "derived",
    res: b.res || "d",
    kind: "btc",
    headline: `Added ${int(added)} BTC — holdings ${int(b.hold)}`,
    meaning: bits.join(". ") + ".",
    figs: { added, hold: b.hold, bpsBefore: b0, bpsAfter: b1 },
    estimated: true,
  });
}

file.events = mergeEvents(file.events, out, 900);
file.updatedAt = new Date().toISOString();
file.note = "Entries marked derived are reconstructed from the price/holdings backfill, not parsed "
  + "from a filing: no purchase price, and Sep 2021–Sep 2025 is weekly so a week's buying shows as "
  + "one line. Decreases are not backfilled at all, because a step down in the reconstructed series "
  + "cannot be told apart from a later revision to the holdings record. Entries from the filings job "
  + "carry a link to the filing they came from, and do report disposals.";
await writeJson("events.json", file);
log(`seeded ${out.length} derived entries (${file.events.length} total); skipped ${skippedDown} step-downs`);
