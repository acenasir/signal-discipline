// Fetches delayed NQ futures bars from Yahoo Finance and merges them into data/*.json.
// Keeps regular trading hours only (09:30–16:00 America/New_York) to keep files small.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const SYMBOL = "NQ=F";
const FEEDS = [
  { interval: "1m", range: "7d", file: "data/nq-1m.json", keepDays: 120 },
  { interval: "5m", range: "60d", file: "data/nq-5m.json", keepDays: 250 },
];
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

const etParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function et(t) {
  const p = Object.fromEntries(etParts.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

async function fetchChart(interval, range) {
  let lastErr;
  for (const host of HOSTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `https://${host}/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=${interval}&range=${range}&includePrePost=true`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (signal-discipline data bot)" } });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        const r = json.chart?.result?.[0];
        if (!r?.timestamp) throw new Error("no data in response");
        return r;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

const round = v => Math.round(v * 100) / 100;

async function readExisting(file) {
  try { return JSON.parse(await readFile(file, "utf8")).bars || []; } catch { return []; }
}

await mkdir("data", { recursive: true });
let meta = {};

for (const feed of FEEDS) {
  const r = await fetchChart(feed.interval, feed.range);
  const q = r.indicators.quote[0];
  const fresh = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(v => v == null)) return;
    const { min } = et(t);
    if (min < 570 || min >= 960) return; // 09:30–15:59 bar opens
    fresh.push([t, round(o), round(h), round(l), round(c)]);
  });

  const byTime = new Map((await readExisting(feed.file)).map(b => [b[0], b]));
  for (const b of fresh) byTime.set(b[0], b);
  let bars = [...byTime.values()].sort((a, b) => a[0] - b[0]);

  const dates = [...new Set(bars.map(b => et(b[0]).date))];
  const keep = new Set(dates.slice(-feed.keepDays));
  bars = bars.filter(b => keep.has(et(b[0]).date));

  await writeFile(feed.file, JSON.stringify({ symbol: SYMBOL, interval: feed.interval, bars }));
  console.log(`${feed.file}: ${bars.length} bars over ${keep.size} sessions`);

  if (feed.interval === "1m") {
    meta = {
      symbol: SYMBOL,
      price: round(r.meta.regularMarketPrice),
      marketTime: r.meta.regularMarketTime,
      updated: Math.floor(Date.now() / 1000),
    };
  }
}

await writeFile("data/meta.json", JSON.stringify(meta));
