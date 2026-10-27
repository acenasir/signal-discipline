import { DEFAULTS, toSessions, runBacktest, evaluateDay } from "./backtest.js";

const $ = id => document.getElementById(id);
const data = {};
const money = v => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const num = v => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const etTime = t => new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

async function load(name) {
  const res = await fetch(`data/${name}.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

function params() {
  return {
    ...DEFAULTS,
    requireBias: $("pBias").checked,
    requireDisplacement: $("pDisp").checked,
    dispBody: (+$("pDispBody").value || 0) / 100,
    requireFvg: $("pFvg").checked,
    requireTrend: $("pTrend").checked,
    minEfficiency: +$("pEff").value || 0,
    requireDol: $("pDol").checked,
    minR: +$("pMinR").value || 0,
    rr: +$("pRR").value || 2,
    pointValue: +$("pPv").value,
    commission: +$("pFee").value || 0,
  };
}

const FILTERS = [
  ["requireBias", "Directional bias"],
  ["requireDisplacement", "Displacement"],
  ["requireFvg", "FVG entry"],
  ["requireTrend", "Chop filter"],
  ["requireDol", "Draw on liquidity"],
];

function renderBacktest() {
  const tf = $("pData").value;
  const sessions = data[tf];
  if (!sessions) return;
  const p = params();
  const { stats: s, trades, curve } = runBacktest(sessions, p);
  $("dataInfo").textContent = `${sessions.length} sessions, ${sessions[0].date} to ${sessions.at(-1).date}. FVGs are found on ${tf} bars.`;

  const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
  $("tiles").innerHTML = [
    ["Net P&L", `<b class="${s.net >= 0 ? "pos" : "neg"}">${money(s.net)}</b>`],
    ["Trades", `<b>${s.trades}</b>`],
    ["Win rate", `<b>${s.trades ? Math.round(s.winRate * 100) + "%" : "–"}</b>`],
    ["Profit factor", `<b>${s.trades ? pf : "–"}</b>`],
    ["Avg R", `<b class="${s.avgR >= 0 ? "pos" : "neg"}">${s.trades ? s.avgR.toFixed(2) : "–"}</b>`],
    ["Max drawdown", `<b class="${s.maxDd ? "neg" : ""}">${s.maxDd ? money(-s.maxDd) : "$0"}</b>`],
  ].map(([k, v]) => `<div class="tile"><span>${k}</span>${v}</div>`).join("");

  // Equity curve
  const svg = $("equity");
  if (curve.length < 2) {
    svg.innerHTML = `<text x="300" y="95" text-anchor="middle" fill="#8a94a6" font-size="14">No trades pass these filters. Standing aside is a result too.</text>`;
  } else {
    const lo = Math.min(0, ...curve), hi = Math.max(0, ...curve), span = hi - lo || 1;
    const x = i => (i / (curve.length - 1)) * 600, y = v => 170 - ((v - lo) / span) * 160;
    const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const color = curve.at(-1) >= 0 ? "#22c55e" : "#ef4444";
    svg.innerHTML = `<line x1="0" x2="600" y1="${y(0)}" y2="${y(0)}" stroke="#232b38" stroke-dasharray="4 4"/>
      <polyline fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" points="${pts}"/>`;
  }

  // Filter impact
  const none = Object.fromEntries(FILTERS.map(([k]) => [k, false]));
  const rows = [["Every breakout (no filters)", { ...p, ...none }]]
    .concat(FILTERS.map(([k, label]) => [`${label} only`, { ...p, ...none, [k]: true }]))
    .concat([["Your current settings", p]]);
  $("impact").innerHTML = `<tr><th>Rule set</th><th>Trades</th><th>Win %</th><th>Avg R</th><th>Net</th></tr>` +
    rows.map(([label, q]) => {
      const r = runBacktest(sessions, q).stats;
      return `<tr><td>${label}</td><td>${r.trades}</td><td>${r.trades ? Math.round(r.winRate * 100) : "–"}</td>
        <td class="${r.avgR >= 0 ? "pos" : "neg"}">${r.trades ? r.avgR.toFixed(2) : "–"}</td>
        <td class="${r.net >= 0 ? "pos" : "neg"}">${money(r.net)}</td></tr>`;
    }).join("");

  // Trades
  $("trades").innerHTML = trades.length
    ? `<tr><th>Date</th><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Exit</th><th>Result</th><th>R</th><th>P&amp;L</th></tr>` +
      trades.slice().reverse().map(t => `<tr><td>${t.date}</td>
        <td class="${t.dir > 0 ? "pos" : "neg"}">${t.dir > 0 ? "▲ BUY" : "▼ SELL"}</td>
        <td>${num(t.entry)} <span style="color:var(--muted)">${etTime(t.fillT)}</span></td><td>${num(t.stop)}</td><td>${num(t.target)}</td>
        <td>${num(t.exit)} <span style="color:var(--muted)">${etTime(t.exitT)}</span></td><td>${t.why}</td>
        <td class="${t.r >= 0 ? "pos" : "neg"}">${t.r.toFixed(2)}</td><td class="${t.pnl >= 0 ? "pos" : "neg"}">${money(t.pnl)}</td></tr>`).join("")
    : `<tr><td style="color:var(--muted);font-family:Inter">No trades with these settings.</td></tr>`;

  renderLive();
}

function renderLive() {
  const sessions = data["1m"];
  if (!sessions || sessions.length < 2) return;
  const meta = data.meta || {};
  const today = sessions.at(-1), prev = sessions.at(-2);
  const r = evaluateDay(today, prev, params(), { live: true });

  const last = today.bars.at(-1);
  $("lvPrice").textContent = num(meta.price ?? last.c);
  $("lvOrH").textContent = r.or ? num(r.or.high) : "–";
  $("lvOrL").textContent = r.or ? num(r.or.low) : "–";
  $("lvDate").textContent = today.date;

  const ageMin = meta.updated ? Math.round((Date.now() / 1000 - meta.updated) / 60) : null;
  const stale = ageMin == null || ageMin > 30;
  $("liveStatus").innerHTML = `<span><i class="dot ${stale ? "stale" : ""}"></i><b>${stale ? "Market closed or data stale" : "Updating"}</b></span>
    <span>Last bar <b>${etTime(last.t)} ET</b></span>
    <span>Fetched <b>${ageMin == null ? "–" : ageMin < 1 ? "just now" : ageMin + " min ago"}</b></span>
    <span>Source <b>Yahoo Finance NQ=F (delayed)</b></span>`;

  $("lvChecks").innerHTML = r.checks.length
    ? r.checks.map(([label, ok, off]) => `<li class="${off ? "off" : ok ? "ok" : "no"}"><b>${off ? "–" : ok ? "✓" : "✕"}</b>${label}${off ? " (filter off)" : ""}</li>`).join("")
    : `<li><b>·</b>${r.reason}</li>`;

  const sig = $("lvSignal"), big = $("lvBig"), why = $("lvWhy");
  const planBox = $("lvPlan");
  planBox.style.display = r.plan ? "" : "none";
  if (r.plan) { $("lvEntry").textContent = num(r.plan.entry); $("lvStop").textContent = num(r.plan.stop); $("lvTarget").textContent = num(r.plan.target); }

  if (r.status === "trade" || r.status === "open" || (r.status === "pending" && r.plan)) {
    const long = r.dir === 1;
    sig.className = "signal " + (long ? "buy" : "sell");
    big.textContent = long ? "▲ BUY" : "▼ SELL";
    why.textContent = r.status === "trade" ? `Signal fired and closed: ${r.trade.why} (${r.trade.r.toFixed(2)}R)`
      : r.status === "open" ? "Signal fired and the trade is open." : r.reason;
  } else {
    sig.className = "signal wait";
    big.textContent = r.status === "pending" ? "■ WAIT" : "■ NO TRADE";
    why.textContent = r.reason || "No setup today.";
  }
}

async function refresh() {
  try {
    const [m1, m5, meta] = await Promise.all([load("nq-1m"), load("nq-5m"), load("meta").catch(() => ({}))]);
    data["1m"] = toSessions(m1.bars);
    data["5m"] = toSessions(m5.bars);
    data.meta = meta;
    renderBacktest();
  } catch (e) {
    $("liveStatus").innerHTML = `<span><i class="dot stale"></i><b>Couldn't load market data</b> (${e.message})</span>`;
  }
}

$("btControls").addEventListener("input", renderBacktest);
refresh();
setInterval(refresh, 2 * 60 * 1000);
