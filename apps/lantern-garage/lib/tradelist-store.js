/**
 * Per-user AI TRADELISTS — the symbols the autopilot is ALLOWED to trade.
 *
 * The watchlist used to double as the autopilot's trading universe, conflating two
 * jobs: watching (tracking stocks/news — anything the user cares about, including
 * names the engine measurably loses on) and trading (the AI's contest book). This
 * store splits them: the WATCHLIST is tracking-only; the AUTOPILOT enters only
 * symbols on the user's TRADELIST (routes/trading.js autoscan filter). Manual
 * buy/sell stays free on any symbol — this list gates the AI, not the human.
 *
 * Mirrors lib/watchlist-store.js exactly (one file per user, first-access seeding,
 * `allTickers()` union for scan/collector coverage). Seeds from
 * data/.../tradelist.seed.json — the measured ETF universe the engine is actually
 * positive on (see changelog 2026-07-24-trader-etf-universe) — NOT from the user's
 * watchlist, so personal tracking names never leak into the AI's book.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..", "data", "lantern-garage", "trading");
const DIR = path.join(ROOT, "tradelists");
const SEED_FILE = path.join(ROOT, "tradelist.seed.json");
const DEFAULT = ["SPY", "QQQ", "IWM", "TQQQ", "SQQQ", "SOXL", "SOXS"];

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId || "default")) + ".json"); }
function _readList(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(j) ? j : j.tickers;
    return Array.isArray(list) ? list : null;
  } catch (_e) { return null; }
}
function _clean(tickers) {
  return [...new Set((tickers || []).map((t) => String(t).toUpperCase().trim()).filter(Boolean))];
}
function _seed() {
  const seed = _readList(SEED_FILE);
  if (seed && seed.length) return _clean(seed);
  return DEFAULT.slice();
}

function setTradelist(userId, tickers) {
  fs.mkdirSync(DIR, { recursive: true });
  const clean = _clean(tickers);
  fs.writeFileSync(_file(userId), JSON.stringify({ tickers: clean }, null, 2));
  return clean;
}
function getTradelist(userId) {
  const list = _readList(_file(userId));
  if (list) return _clean(list);
  return setTradelist(userId, _seed()); // first access → seed + persist
}
function addTicker(userId, sym) {
  const s = String(sym).toUpperCase().trim();
  const list = getTradelist(userId);
  return s && !list.includes(s) ? setTradelist(userId, [...list, s]) : list;
}
function removeTicker(userId, sym) {
  const s = String(sym).toUpperCase().trim();
  return setTradelist(userId, getTradelist(userId).filter((t) => t !== s));
}
function listUsers() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5))); }
  catch (_e) { return []; }
}
function allTickers() {
  const set = new Set(_seed()); // always include the base list so collectors have data on boot
  for (const u of listUsers()) for (const t of getTradelist(u)) set.add(t);
  return [...set];
}

module.exports = { getTradelist, setTradelist, addTicker, removeTicker, listUsers, allTickers };
