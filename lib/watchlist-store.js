/**
 * Per-user trading watchlists.
 *
 * The watchlist used to be one global data/lantern-garage/trading/watchlist.json shared
 * by everyone — so a second person's edits changed your list and the autopilot traded a
 * single house list. This stores one file per user (data/.../watchlists/<userId>.json).
 * A user's first access seeds from the legacy global list (or the default), so existing
 * setups carry over. `allTickers()` is the union across users, which the scan + price/bar
 * collectors run on so every watched symbol has data regardless of whose list it's on.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "data", "lantern-garage", "trading");
const DIR = path.join(ROOT, "watchlists");
const LEGACY = path.join(ROOT, "watchlist.json");
// The tracked "ideal trader" starter list — liquid broad ETFs + high-vol leveraged/
// inverse ETFs (data/.../watchlist.seed.json). Backtests show the mean-reversion engine
// loses on high-beta single stocks but is positive on these ETFs at a tight target, so
// the default universe is ETF-only. This is what a fresh user's list seeds from; the
// hardcoded array below is only a last resort if the seed file is missing.
const SEED_FILE = path.join(ROOT, "watchlist.seed.json");
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
  // Precedence: a legacy global watchlist.json (migrate an existing single-file setup) →
  // the tracked ideal-trader seed list → the hardcoded starter. #2376 dropped the seed-file
  // read, so fresh users/the union collapsed to the 5-symbol hardcoded DEFAULT (#trader-seed).
  const legacy = _readList(LEGACY);
  if (legacy && legacy.length) return _clean(legacy);
  const seed = _readList(SEED_FILE);
  if (seed && seed.length) return _clean(seed);
  return DEFAULT.slice();
}

function setWatchlist(userId, tickers) {
  fs.mkdirSync(DIR, { recursive: true });
  const clean = _clean(tickers);
  fs.writeFileSync(_file(userId), JSON.stringify({ tickers: clean }, null, 2));
  return clean;
}
function getWatchlist(userId) {
  const list = _readList(_file(userId));
  if (list) return _clean(list);
  return setWatchlist(userId, _seed()); // first access → seed + persist
}
function addTicker(userId, sym) {
  const s = String(sym).toUpperCase().trim();
  const list = getWatchlist(userId);
  return s && !list.includes(s) ? setWatchlist(userId, [...list, s]) : list;
}
function removeTicker(userId, sym) {
  const s = String(sym).toUpperCase().trim();
  return setWatchlist(userId, getWatchlist(userId).filter((t) => t !== s));
}
function listUsers() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5))); }
  catch (_e) { return []; }
}
function allTickers() {
  const set = new Set(_seed()); // always include the base list so collectors have data on boot
  for (const u of listUsers()) for (const t of getWatchlist(u)) set.add(t);
  return [...set];
}

module.exports = { getWatchlist, setWatchlist, addTicker, removeTicker, listUsers, allTickers };
