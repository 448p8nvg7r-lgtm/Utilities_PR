// Puerto Rico utility status collector.
// Node 20+, no dependencies. Fetches public data and writes docs/status.json + docs/history.json.
// Every source is independent: one failing never blocks the others.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const UA = "pr-utility-status/1.0 (+public open-data dashboard)";
const OUT_DIR = new URL("../docs/", import.meta.url);
const HISTORY_DAYS = 7;

// ---------- helpers ----------
async function get(url, { type = "json", method = "GET", body, headers = {}, timeout = 25000 } = {}) {
  const r = await fetch(url, {
    method,
    body,
    signal: AbortSignal.timeout(timeout),
    headers: {
      "user-agent": UA,
      accept: type === "json" ? "application/json, text/plain, */*" : "text/html,*/*",
      ...headers,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return type === "json" ? r.json() : r.text();
}

async function source(fn) {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { ok: true, fetchedAt: new Date().toISOString(), ms: Date.now() - t0, ...data };
  } catch (e) {
    return { ok: false, fetchedAt: new Date().toISOString(), error: String(e?.message || e) };
  }
}

const num = (v) => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[,%\s]/g, ""));
    return isFinite(n) ? n : undefined;
  }
  return undefined;
};

// Find the first value in an object whose key matches `want` and not `avoid`.
function pick(obj, want, avoid) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (want.test(k) && !(avoid && avoid.test(k))) {
      const n = num(v);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}
function pickStr(obj, want) {
  for (const [k, v] of Object.entries(obj || {})) if (want.test(k) && typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

// Depth-first search for the largest array of objects in a JSON tree.
function findObjArray(node, depth = 0) {
  if (depth > 6 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && !Array.isArray(x))) return node;
    for (const x of node) { const f = findObjArray(x, depth + 1); if (f) return f; }
    return null;
  }
  let best = null;
  for (const v of Object.values(node)) {
    const f = findObjArray(v, depth + 1);
    if (f && (!best || f.length > best.length)) best = f;
  }
  return best;
}

const RX = {
  name: /^(name|region|regionname|region_name|nombre|description|desc)$/i,
  without: /(without|sin).?(service|servicio)|affected|outage|out$/i,
  pct: /percent|pct|porc/i,
  planned: /planned|planificad|programad/i,
  total: /^(total)?.?(clients?|customers?|clientes|abonados)(.?total)?$|^total$/i,
  notTotal: /with|sin|con|affect|out|planned|percent|pct/i,
  time: /time|date|updated|fecha|hora/i,
};

// ---------- LUMA (electric T&D outages) ----------
export function normalizeLuma(json) {
  const arr = findObjArray(json) || [];
  const regions = arr
    .map((r) => {
      const name = pickStr(r, RX.name);
      const out = pick(r, RX.without, /percent|pct|porc|planned|planificad/i);
      const total = pick(r, RX.total, RX.notTotal);
      // Prefer computing the share ourselves; the API's own percentage field may be 0–1 or 0–100.
      const pct = out !== undefined && total ? (out / total) * 100 : pick(r, RX.pct);
      const planned = pick(r, RX.planned);
      return name && out !== undefined ? { name, out, total, pct, planned } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.out - a.out);

  const top = Array.isArray(json) ? {} : json;
  let totalOut = pick(top, RX.without, /percent|pct|porc|planned/i);
  let totalClients = pick(top, RX.total, RX.notTotal);
  let totalPct = pick(top, RX.pct);
  if (!regions.length && totalOut === undefined) throw new Error("LUMA response had no recognisable outage fields");
  const sum = (k) => regions.reduce((s, r) => s + (r[k] || 0), 0);
  if (totalOut === undefined) totalOut = sum("out");
  if (totalClients === undefined && regions.every((r) => r.total)) totalClients = sum("total");
  if (totalClients) totalPct = (totalOut / totalClients) * 100;
  const plannedOut = regions.some((r) => r.planned !== undefined) ? sum("planned") : pick(top, RX.planned);
  return { totalOut, totalClients, totalPct, plannedOut, regions, reportedAt: pickStr(top, RX.time) };
}

function findKeyDeep(node, rx, depth = 0, path = "") {
  if (depth > 8 || !node || typeof node !== "object") return [];
  const hits = [];
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (rx.test(k) || (typeof v === "string" && rx.test(v))) hits.push({ path: p, value: v });
    if (v && typeof v === "object") hits.push(...findKeyDeep(v, rx, depth + 1, p));
  }
  return hits;
}

async function luma() {
  const base = "https://api.miluma.lumapr.com";
  const json = await get(`${base}/miluma-outage-api/outage/regionsWithoutService`, {
    headers: { origin: "https://miluma.lumapr.com", referer: "https://miluma.lumapr.com/" },
  });
  const out = normalizeLuma(json);
  // Best effort: the MiLUMA app config carries a load-shedding (relevos de carga) feature flag.
  try {
    const cfg = await get(`${base}/miluma-app-config-api/v2/configs`, {
      headers: { origin: "https://miluma.lumapr.com", referer: "https://miluma.lumapr.com/" },
    });
    const flag = findKeyDeep(cfg, /load.?shed/i).map((h) => h.value).find((v) => v && typeof v === "object" && /LoadShed\.Enable$/i.test(v.key || ""));
    if (flag) out.loadShedding = String(flag.value).toLowerCase() === "true";
  } catch { /* optional */ }
  return out;
}

// ---------- Genera PR / PREPA generation fleet ----------
// genera-pr.com/data-generacion draws its numbers from PREPA's operations data file.
const PREPA_DATA = "https://operationdata.prepa.pr.gov/dataSourceGenera.js";
export function parseGenera(js) {
  const metric = (i) => { const m = js.match(new RegExp(`Index:\\s*'${i}'[^}]*?value:\\s*([0-9.]+)`)); return m ? num(m[1]) : undefined; };
  const v = {
    generation: metric(0), spinning: metric(5), operating: metric(6), available: metric(7),
    demand: metric(8), peakToday: metric(9), peakMonth: metric(10), peakYear: metric(11),
  };
  if (v.generation === undefined && v.available === undefined) throw new Error("PREPA data file had no recognisable generation figures");
  const upd = js.match(/dataFechaAcualizado\s*=\s*'([^']+)'/);
  v.updated = upd ? upd[1] : undefined;
  v.fuel = [...js.matchAll(/\{fuel:\s*'([^']+)',\s*value:\s*([0-9.]+)\}/g)].map((m) => ({ fuel: m[1], pct: num(m[2]) }));
  v.plants = [...js.matchAll(/Type:\s*'([^']*)',\s*Desc:\s*'([^']*)',\s*SiteTotal:\s*([0-9.]+)/g)]
    .map((m) => ({ type: m[1], name: m[2], mw: num(m[3]) })).filter((p) => p.mw > 0).sort((a, b) => b.mw - a.mw);
  v.reserve = v.operating ?? (v.available !== undefined && v.generation !== undefined ? v.available - v.generation : undefined);
  v.category = reserveCategory(v.reserve);
  return v;
}

// Genera PR's own categories: estrecha 100–400 MW, moderada 400–600, suficiente 600+; under 100 = capacidad limitada.
export function reserveCategory(mw) {
  if (mw === undefined) return undefined;
  if (mw < 0) return "deficit";
  if (mw < 100) return "limited";
  if (mw < 400) return "narrow";
  if (mw < 600) return "moderate";
  return "sufficient";
}

async function genera() {
  const js = await get(PREPA_DATA, { type: "text", headers: { referer: "https://genera-pr.com/data-generacion" } });
  return parseGenera(js);
}

// ---------- PRASA / AAA: reservoir levels from USGS + latest AAA notices ----------
export const RESERVOIRS = [
  { id: "50059000", name: "Carraízo (Lago Loíza)", serves: "San Juan metro" },
  { id: "50045000", name: "La Plata", serves: "Metro / north" },
  { id: "50047550", name: "Cidra", serves: "Cidra, Cayey, Caguas" },
  { id: "50010800", name: "Guajataca", serves: "Northwest" },
  { id: "50111210", name: "Toa Vaca", serves: "South" },
  { id: "50113950", name: "Cerrillos", serves: "Ponce" },
  { id: "50093045", name: "Patillas", serves: "Southeast" },
  { id: "50026140", name: "Caonillas", serves: "Arecibo / Utuado" },
];
const ELEV_CODES = ["72376", "72380", "72375", "72379"]; // m LMSL, m PRVD02, ft LMSL, ft PRVD02

export function normalizeUsgsIv(json) {
  const series = json?.value?.timeSeries || [];
  const bySite = {};
  for (const ts of series) {
    const site = ts?.sourceInfo?.siteCode?.[0]?.value;
    const code = ts?.variable?.variableCode?.[0]?.value;
    const pts = (ts?.values?.[0]?.value || [])
      .map((p) => ({ t: Date.parse(p.dateTime), v: num(p.value) }))
      .filter((p) => isFinite(p.t) && p.v !== undefined && p.v > -900000);
    if (!site || !pts.length) continue;
    const rank = ELEV_CODES.indexOf(code);
    if (bySite[site] && bySite[site].rank <= rank) continue;
    bySite[site] = { rank, code, unit: ts?.variable?.unit?.unitCode || "m", pts };
  }
  return RESERVOIRS.map((r) => {
    const s = bySite[r.id];
    if (!s) return { ...r, ok: false };
    const last = s.pts[s.pts.length - 1];
    const at = (h) => { const target = last.t - h * 3600e3; let best = null; for (const p of s.pts) if (p.t <= target) best = p; return best; };
    const d1 = at(24), d7 = at(24 * 6.5);
    const spark = [];
    const step = 6 * 3600e3;
    for (let t = s.pts[0].t; t <= last.t; t += step) { const p = s.pts.find((q) => q.t >= t); if (p) spark.push(+p.v.toFixed(2)); }
    return { ...r, ok: true, level: last.v, unit: s.unit, time: new Date(last.t).toISOString(),
      change24h: d1 ? +(last.v - d1.v).toFixed(2) : undefined, change7d: d7 ? +(last.v - d7.v).toFixed(2) : undefined, spark };
  });
}

async function usgsLegacy() {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&siteStatus=all&period=P7D&sites=${RESERVOIRS.map((r) => r.id).join(",")}&parameterCd=${ELEV_CODES.slice(0, 2).join(",")}`;
  return normalizeUsgsIv(await get(url, { timeout: 45000 }));
}

// Fallback: USGS's newer Water Data OGC API (latest value only).
async function usgsOgc() {
  const out = [];
  for (const r of RESERVOIRS) {
    try {
      const j = await get(`https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&monitoring_location_id=USGS-${r.id}`);
      const f = (j.features || []).map((x) => x.properties || {})
        .filter((p) => ELEV_CODES.includes(String(p.parameter_code)))
        .sort((a, b) => ELEV_CODES.indexOf(String(a.parameter_code)) - ELEV_CODES.indexOf(String(b.parameter_code)))[0];
      out.push(f ? { ...r, ok: true, level: num(f.value), unit: f.unit_of_measure || "m", time: f.time, spark: [] } : { ...r, ok: false });
    } catch { out.push({ ...r, ok: false }); }
  }
  return out;
}

export function parseAaaNews(html) {
  const items = [];
  const rx = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  let m;
  while ((m = rx.exec(html)) && items.length < 8) {
    const t = m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
    if (t.length > 25 && t === t.toUpperCase() && /AAA|ACUEDUCTOS|AGUA|SERVICIO|PLANTA|AVER|INTERRUP|TRABAJOS|ABONADOS|REPAR|EMBALSE|ZONA/i.test(t) && !items.includes(t)) items.push(t);
  }
  return items;
}

async function prasa() {
  let reservoirs, via = "USGS Water Services (instantaneous values)";
  try { reservoirs = await usgsLegacy(); if (!reservoirs.some((r) => r.ok)) throw new Error("no data"); }
  catch { reservoirs = await usgsOgc(); via = "USGS Water Data API (latest values)"; }
  let notices = [];
  try { notices = parseAaaNews(await get("https://www.acueductos.pr.gov/", { type: "text" })); } catch { /* optional */ }
  if (!reservoirs.some((r) => r.ok) && !notices.length) throw new Error("No reservoir data or AAA notices reachable");
  return { reservoirs, via, notices };
}

// ---------- Telecom: Liberty & Claro via IODA (Georgia Tech) ----------
export const NETWORKS = [
  { key: "liberty", label: "Liberty (cable / fiber)", type: "asn", code: "14638" },
  { key: "liberty-mobile", label: "Liberty Mobile", type: "asn", code: "11992" },
  { key: "claro", label: "Claro (Datacom Caribe)", type: "asn", code: "10396" },
  { key: "pr", label: "All of Puerto Rico", type: "country", code: "PR" },
];
const IODA = "https://api.ioda.inetintel.cc.gatech.edu/v2";
const USE_DS = ["bgp", "ping-slash24"];

export function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : undefined; }

// Returns {ratio, spark} for one datasource series: latest value vs. 24h median.
export function signalHealth(values) {
  const v = (values || []).map(num).filter((x) => x !== undefined && x !== null);
  if (v.length < 6) return null;
  const recent = v.slice(-3);
  const latest = median(recent);
  const base = median(v.slice(0, -3));
  if (!base) return null;
  const every = Math.max(1, Math.floor(v.length / 48));
  return { latest, baseline: base, ratio: latest / base, spark: v.filter((_, i) => i % every === 0) };
}

export function normalizeIoda(alertsJson, signalsJson, nowSec) {
  const alerts = (alertsJson?.data || []).map((a) => ({ ds: a.datasource, level: a.level, time: a.time, cond: a.condition, value: a.value, hist: a.historyValue }));
  // latest alert per datasource; a 'critical' that hasn't returned to 'normal' within 3h = active
  const latestBy = {};
  for (const a of alerts.sort((x, y) => x.time - y.time)) latestBy[a.ds] = a;
  const active = Object.values(latestBy).filter((a) => USE_DS.includes(a.ds) && a.level === "critical" && nowSec - a.time < 3 * 3600);

  const flat = (signalsJson?.data || []).flat(2).filter((s) => s && s.values);
  const signals = {};
  for (const s of flat) { if (!USE_DS.includes(s.datasource)) continue; const h = signalHealth(s.values); if (h && h.baseline >= 20) signals[s.datasource] = h; }
  const ratios = Object.values(signals).map((s) => s.ratio);
  const worst = ratios.length ? Math.min(...ratios) : undefined;

  let status = "unknown";
  if (active.length || (worst !== undefined && worst < 0.8)) status = "down";
  else if (worst !== undefined && worst < 0.93) status = "degraded";
  else if (worst !== undefined || alertsJson) status = "ok";
  return { status, worstRatio: worst, signals, activeAlerts: active, alerts24h: alerts.length };
}

async function telecom() {
  const until = Math.floor(Date.now() / 1000);
  const from = until - 24 * 3600;
  const results = await Promise.all(NETWORKS.map(async (n) => {
    try {
      const [alerts, sig] = await Promise.all([
        get(`${IODA}/outages/alerts?entityType=${n.type}&entityCode=${n.code}&from=${from}&until=${until}`).catch(() => null),
        get(`${IODA}/signals/raw/${n.type}/${n.code}?from=${from}&until=${until}`).catch(() => null),
      ]);
      if (!alerts && !sig) throw new Error("IODA unreachable");
      return { ...n, ok: true, ...normalizeIoda(alerts, sig, until) };
    } catch (e) { return { ...n, ok: false, error: String(e.message || e) }; }
  }));
  if (!results.some((r) => r.ok)) throw new Error("IODA API unreachable");
  return { networks: results };
}

// ---------- main ----------
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const [L, G, W, T] = await Promise.all([source(luma), source(genera), source(prasa), source(telecom)]);
  const status = { generatedAt: new Date().toISOString(), luma: L, genera: G, prasa: W, telecom: T };
  await writeFile(new URL("status.json", OUT_DIR), JSON.stringify(status, null, 1));

  let history = [];
  try { history = JSON.parse(await readFile(new URL("history.json", OUT_DIR), "utf8")); } catch { /* first run */ }
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  history = history.filter((h) => Date.parse(h.t) > cutoff);
  history.push({
    t: status.generatedAt,
    out: L.ok ? L.totalOut : null,
    pct: L.ok && L.totalPct !== undefined ? +L.totalPct.toFixed(3) : null,
    reserve: G.ok ? G.reserve ?? null : null,
    carraizo: W.ok ? W.reservoirs.find((r) => r.id === "50059000")?.level ?? null : null,
  });
  await writeFile(new URL("history.json", OUT_DIR), JSON.stringify(history));

  for (const [k, v] of Object.entries({ luma: L, genera: G, prasa: W, telecom: T }))
    console.log(`${k.padEnd(8)} ${v.ok ? "ok  " : "FAIL"} ${v.ok ? "" : v.error}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
