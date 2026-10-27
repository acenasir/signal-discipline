// 15-minute ORB + FVG backtest engine. Runs in the browser and in Node.
// Bars are [unixSeconds, open, high, low, close], regular trading hours only.

export const DEFAULTS = {
  orMinutes: 15,        // opening range length from 09:30 ET
  requireBias: true,    // trade only in the direction of the prior session's close
  requireDisplacement: true,
  dispBody: 0.5,        // breakout 15m candle body must be >= this share of its range
  requireFvg: true,     // enter on a retrace into a lower-timeframe FVG left by the breakout
  requireTrend: true,   // skip choppy opens
  minEfficiency: 0.25,  // net move / total path of 5m closes from 09:30 to the breakout (0..1)
  requireDol: true,     // target the prior session high/low and require it to be untaken and >= minR away
  minR: 1,
  rr: 2,                // fixed R target when the DOL filter is off
  entryCutoff: 11 * 60, // no new entries after 11:00 ET
  exitMin: 15 * 60 + 55,// flatten at 15:55 ET
  pointValue: 20,       // NQ $20/pt, MNQ $2/pt
  contracts: 1,
  commission: 4.5,      // round trip per contract, $
  slippage: 0.25,       // points per side
};

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const cache = new Map();
function et(t) {
  let v = cache.get(t);
  if (v) return v;
  const p = {};
  for (const x of fmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  v = { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
  cache.set(t, v);
  return v;
}

export function toSessions(raw) {
  const days = new Map();
  for (const [t, o, h, l, c] of raw) {
    const { date, min } = et(t);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ t, o, h, l, c, min });
  }
  return [...days].map(([date, bars]) => ({ date, bars: bars.sort((a, b) => a.t - b.t) }));
}

function bucket(bars, size, start) {
  const out = new Map();
  for (const b of bars) {
    if (b.min < start) continue;
    const k = start + Math.floor((b.min - start) / size) * size;
    const x = out.get(k);
    if (!x) out.set(k, { min: k, end: k + size, o: b.o, h: b.h, l: b.l, c: b.c, bars: [b] });
    else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.bars.push(b); }
  }
  return [...out.values()];
}

// Evaluates one session. Returns { date, status, dir, checks, trade?, reason? }.
// status: "trade" | "skip" | "nobreak" | "pending" | "nofill"
export function evaluateDay(day, prev, p = DEFAULTS, { live = false } = {}) {
  const bars = day.bars;
  const orEnd = 570 + p.orMinutes;
  const orBars = bars.filter(b => b.min >= 570 && b.min < orEnd);
  const res = { date: day.date, checks: [] };
  const lastMin = bars.length ? bars[bars.length - 1].min : 0;

  if (!orBars.length || (live && lastMin < orEnd - 1)) return { ...res, status: "pending", reason: "Opening range still forming" };
  const orH = Math.max(...orBars.map(b => b.h)), orL = Math.min(...orBars.map(b => b.l));
  res.or = { high: orH, low: orL };

  // First 15m candle after the range that closes outside it.
  const step = bars[1] ? bars[1].min - bars[0].min : 1;
  const candles = bucket(bars, 15, orEnd).filter(c => c.min < p.entryCutoff);
  let brk = null;
  for (const c of candles) {
    const complete = c.bars[c.bars.length - 1].min >= c.end - step;
    if (live && !complete) break;
    if (c.c > orH || c.c < orL) { brk = c; break; }
  }
  if (!brk) {
    const done = !live || lastMin >= p.entryCutoff;
    return { ...res, status: done ? "nobreak" : "pending", reason: done ? "No 15m close outside the range before the cutoff" : "Waiting for a 15m close outside the range" };
  }
  const dir = brk.c > orH ? 1 : -1;
  res.dir = dir;
  res.checks.push(["15m close outside the range", true]);

  const prevClose = prev?.bars.at(-1)?.c;
  // Bias: the opening range sits above the prior close for longs, below it for shorts.
  const biasOk = prevClose != null && Math.sign((orH + orL) / 2 - prevClose) === dir;
  res.checks.push(["Directional bias (vs prior close)", biasOk, !p.requireBias]);

  const body = Math.abs(brk.c - brk.o), range = brk.h - brk.l || 1e-9;
  const dispOk = body / range >= p.dispBody && Math.sign(brk.c - brk.o) === dir;
  res.checks.push(["Displacement candle", dispOk, !p.requireDisplacement]);

  // Measured on 5m closes so 1m and 5m data score the same way.
  const path = bucket(bars.filter(b => b.t <= brk.bars.at(-1).t), 5, 570);
  let travel = 0;
  for (let i = 1; i < path.length; i++) travel += Math.abs(path[i].c - path[i - 1].c);
  const eff = travel ? Math.abs(path.at(-1).c - path[0].o) / travel : 0;
  const trendOk = eff >= p.minEfficiency;
  res.checks.push([`Not choppy (efficiency ${eff.toFixed(2)})`, trendOk, !p.requireTrend]);

  // Most recent FVG in the breakout direction, formed during the breakout leg
  // (the breakout candle and the 15m candle before it).
  let fvg = null;
  const lt = bars.filter(b => b.min >= Math.max(orEnd, brk.min - 15) && b.t <= brk.bars.at(-1).t);
  for (let i = 2; i < lt.length; i++) {
    const a = lt[i - 2], c = lt[i];
    if (dir === 1 && c.l > a.h) fvg = { entry: c.l, stop: a.l, top: c.l, bottom: a.h };
    if (dir === -1 && c.h < a.l) fvg = { entry: c.h, stop: a.h, top: a.l, bottom: c.h };
  }
  res.checks.push(["Lower-timeframe FVG confirms", !!fvg, !p.requireFvg]);

  const entry = p.requireFvg && fvg ? fvg.entry : brk.c;
  const stop = p.requireFvg && fvg ? fvg.stop : (orH + orL) / 2;
  const risk = (entry - stop) * dir;

  const after = bars.filter(b => b.t > brk.bars.at(-1).t);
  const pdh = prev ? Math.max(...prev.bars.map(b => b.h)) : null;
  const pdl = prev ? Math.min(...prev.bars.map(b => b.l)) : null;
  const dolLevel = dir === 1 ? pdh : pdl;
  const takenToday = dolLevel == null ? true : bars.filter(b => b.t <= brk.bars.at(-1).t).some(b => dir === 1 ? b.h >= dolLevel : b.l <= dolLevel);
  const dolR = dolLevel != null && risk > 0 ? ((dolLevel - entry) * dir) / risk : 0;
  const dolOk = !takenToday && dolR >= p.minR;
  res.checks.push([`Clear draw on liquidity (${dolLevel == null ? "n/a" : (dolR > 0 ? dolR.toFixed(1) + "R to prior " + (dir === 1 ? "high" : "low") : "already taken")})`, dolOk, !p.requireDol]);

  const failed = res.checks.filter(([, ok, off]) => !ok && !off).map(([n]) => n);
  if (failed.length || risk <= 0) return { ...res, status: "skip", reason: failed.length ? failed.join(", ") : "Invalid risk" };

  const target = p.requireDol ? dolLevel : entry + dir * risk * p.rr;
  const plan = { entry, stop, target, risk };
  res.plan = plan;

  // Simulate: wait for fill (limit at FVG edge, or market at breakout close), then stop/target/time exit.
  let filled = !(p.requireFvg && fvg), fillT = filled ? brk.bars.at(-1).t : null;
  let exit = null, ranAway = false;
  for (const b of after) {
    if (!filled) {
      if (b.min >= p.entryCutoff) break;
      if (dir === 1 ? b.l <= entry : b.h >= entry) {
        filled = true; fillT = b.t;
        // Same bar also through the stop: assume the worst.
        if (dir === 1 ? b.l <= stop : b.h >= stop) { exit = { t: b.t, price: stop, why: "stop" }; break; }
        continue;
      }
      if (dir === 1 ? b.h >= target : b.l <= target) { ranAway = true; break; }
      continue;
    }
    if (dir === 1 ? b.l <= stop : b.h >= stop) { exit = { t: b.t, price: stop, why: "stop" }; break; }
    if (dir === 1 ? b.h >= target : b.l <= target) { exit = { t: b.t, price: target, why: "target" }; break; }
    if (b.min >= p.exitMin) { exit = { t: b.t, price: b.c, why: "time" }; break; }
  }
  if (!filled) {
    if (ranAway) return { ...res, status: "nofill", reason: "Price hit the target without retracing into the FVG" };
    const waiting = live && lastMin < p.entryCutoff;
    return { ...res, status: waiting ? "pending" : "nofill", reason: waiting ? "Setup valid, waiting for the FVG retrace" : "Price never retraced into the FVG before the cutoff" };
  }
  if (!exit) {
    if (live) return { ...res, status: "open", fillT };
    const b = after.at(-1) || brk.bars.at(-1);
    exit = { t: b.t, price: b.c, why: "time" };
  }

  const pts = (exit.price - entry) * dir - 2 * p.slippage;
  const pnl = pts * p.pointValue * p.contracts - p.commission * p.contracts;
  return { ...res, status: "trade", trade: { dir, entry, stop, target, fillT, exitT: exit.t, exit: exit.price, why: exit.why, pts, r: pts / risk, pnl } };
}

export function runBacktest(sessions, p = DEFAULTS) {
  const days = [];
  for (let i = 1; i < sessions.length; i++) days.push(evaluateDay(sessions[i], sessions[i - 1], p));
  const trades = days.filter(d => d.status === "trade").map(d => ({ date: d.date, ...d.trade }));
  let eq = 0, peak = 0, maxDd = 0, gw = 0, gl = 0;
  const curve = [0];
  for (const t of trades) {
    eq += t.pnl; curve.push(eq);
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
    if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl;
  }
  const wins = trades.filter(t => t.pnl > 0).length;
  return {
    days, trades, curve,
    stats: {
      sessions: days.length, trades: trades.length, wins,
      winRate: trades.length ? wins / trades.length : 0,
      net: eq, maxDd, profitFactor: gl ? gw / gl : gw ? Infinity : 0,
      avgR: trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0,
      skipped: days.filter(d => d.status === "skip" || d.status === "nofill").length,
      noBreak: days.filter(d => d.status === "nobreak").length,
    },
  };
}
