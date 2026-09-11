// Shared helpers. No dependencies — Node 20+ built-ins only.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = resolve(ROOT, "data");

// SEC asks for a descriptive User-Agent with contact details on every request.
export const SEC_UA =
  process.env.SEC_USER_AGENT || "MSTR NAV Tracker (personal project) contact@example.com";
export const CIK = "1050446"; // Strategy Inc. (formerly MicroStrategy)

export const log = (...a) => console.log(...a);
export const warn = (...a) => console.warn("WARN:", ...a);

export async function readJson(name, fallback = null) {
  try {
    return JSON.parse(await readFile(resolve(DATA, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== null) return fallback;
    throw e;
  }
}

export async function writeJson(name, value) {
  await mkdir(DATA, { recursive: true });
  await writeFile(resolve(DATA, name), JSON.stringify(value, null, 2) + "\n");
  log(`wrote data/${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with timeout + retry on transient failures. Throws on final failure. */
export async function get(url, { headers = {}, tries = 3, timeoutMs = 20000, json = false } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(1000 * 2 ** i + Math.random() * 500);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            headers["User-Agent"] ||
            "Mozilla/5.0 (compatible; mstr-nav-tracker/1.0; +https://github.com/)",
          Accept: json ? "application/json,text/plain,*/*" : "text/html,text/plain,*/*",
          ...headers,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Try each source in order; return the first that yields a value passing `sane`. */
export async function firstOf(label, sources, sane = () => true) {
  const errors = [];
  for (const { name, fn } of sources) {
    try {
      const value = await fn();
      if (value == null || Number.isNaN(value)) throw new Error("no value");
      if (!sane(value)) throw new Error(`failed sanity check: ${JSON.stringify(value)}`);
      log(`${label}: ${JSON.stringify(value)} (via ${name})`);
      return { value, source: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`all sources failed for ${label} — ${errors.join("; ")}`);
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

/** Latest completed MSTR daily close. Returns {date:"YYYY-MM-DD", close:Number}. */
export const mstrCloseSources = [
  {
    name: "stooq",
    fn: async () => {
      const csv = await get("https://stooq.com/q/d/l/?s=mstr.us&i=d");
      const rows = csv.trim().split("\n").slice(1).filter(Boolean);
      if (!rows.length) throw new Error("empty csv");
      const last = rows[rows.length - 1].split(",");
      const [date, , , , close] = last;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date ${date}`);
      return { date, close: Number(close) };
    },
  },
  {
    name: "yahoo",
    fn: async () => {
      const j = await get(
        "https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=10d&interval=1d",
        { json: true, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const r = j?.chart?.result?.[0];
      const ts = r?.timestamp || [];
      const cl = r?.indicators?.quote?.[0]?.close || [];
      for (let i = ts.length - 1; i >= 0; i--) {
        if (cl[i] != null) {
          return {
            date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
            close: Number(cl[i].toFixed(2)),
          };
        }
      }
      throw new Error("no close in payload");
    },
  },
];

/** Latest BTC/USD. Returns a Number. */
export const btcSources = [
  {
    name: "coinbase-candles",
    fn: async () => {
      // [ time, low, high, open, close, volume ], newest first
      const j = await get(
        "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400",
        { json: true }
      );
      if (!Array.isArray(j) || !j.length) throw new Error("no candles");
      return Number(j[0][4]);
    },
  },
  {
    name: "coinbase-spot",
    fn: async () => {
      const j = await get("https://api.coinbase.com/v2/prices/BTC-USD/spot", { json: true });
      return Number(j?.data?.amount);
    },
  },
  {
    name: "coingecko",
    fn: async () => {
      const j = await get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        { json: true }
      );
      return Number(j?.bitcoin?.usd);
    },
  },
  {
    name: "kraken",
    fn: async () => {
      const j = await get("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", { json: true });
      const k = Object.keys(j?.result || {})[0];
      return Number(j.result[k].c[0]);
    },
  },
];

export const saneMstr = (v) => v && v.close > 1 && v.close < 100000 && /^\d{4}-\d{2}-\d{2}$/.test(v.date);
export const saneBtc = (v) => v > 1000 && v < 10_000_000;

/* ------------------------------------------------------------------ */
/* SEC EDGAR                                                           */
/* ------------------------------------------------------------------ */

export async function secSubmissions() {
  return get(`https://data.sec.gov/submissions/CIK${CIK.padStart(10, "0")}.json`, {
    json: true,
    headers: { "User-Agent": SEC_UA, Host: "data.sec.gov" },
  });
}

/** Flatten filings.recent into objects, newest first. */
export function recentFilings(subs) {
  const r = subs?.filings?.recent;
  if (!r?.form) return [];
  return r.form.map((form, i) => ({
    form,
    filingDate: r.filingDate[i],
    reportDate: r.reportDate?.[i] || "",
    accession: r.accessionNumber[i],
    primaryDocument: r.primaryDocument[i],
    url: `https://www.sec.gov/Archives/edgar/data/${CIK}/${r.accessionNumber[i].replace(
      /-/g,
      ""
    )}/${r.primaryDocument[i]}`,
  }));
}

export async function secDocText(url) {
  const html = await get(url, { headers: { "User-Agent": SEC_UA } });
  return htmlToText(html);
}

/** Crude but effective: strip tags, decode the few entities that matter, collapse whitespace. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "August 30, 2026" -> "2026-08-30" */
export function parseLongDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || "");
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

export const num = (s) => (s == null ? null : Number(String(s).replace(/[$,\s]/g, "")));
