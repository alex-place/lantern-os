'use strict';
/**
 * lib/two-sleeve/engine.js — the two-sleeve engine core (#3656).
 *
 * ONE account, TWO brains, each with its own environment, budget and universe, sharing
 * equity under symbol ownership. The core is deliberately driver-agnostic: the replay
 * harness (experiments/replay_two_sleeve.js) drives it with a mock broker and pinned
 * clock, the headless runner (scripts/two-sleeve-runner.js) drives it with the real
 * broker facade. A runtime that changes nothing between the two is the validation —
 * the replay numbers must reproduce before the engine touches an account.
 *
 * What the core does per tick, in sleeve ORDER (the measured winner is S first: the
 * stable sleeve claims a shared washout, the race sleeve takes the next name):
 *   1. reconcile the ownership registry with the broker's positions (release what left
 *      the book, adopt what nobody claimed → default owner S);
 *   2. for each sleeve: apply ITS env map to process.env (every sleeve-scoped key is
 *      deleted first, so nothing leaks between sleeves — harness bug #6), filter the
 *      shared scan to its universe, call its brain with an OWNERSHIP BRIDGE that shows
 *      only what it owns and refuses a buy on the other sleeve's symbol;
 *   3. restore the process baseline env.
 *
 * Both brains evaluate cfg() per call, so the env swap is honoured on every tick.
 */

const DEFAULT_KEY_RE = /^TRADER_/;

function createEngine({ sleeves, order, facade, ownership, defaultOwner = 'S', journal = null, keyRe = DEFAULT_KEY_RE } = {}) {
  if (!Array.isArray(sleeves) || !sleeves.length) throw new Error('two-sleeve engine: sleeves required');
  if (!facade) throw new Error('two-sleeve engine: facade required');
  if (!ownership) throw new Error('two-sleeve engine: ownership registry required');
  const byId = Object.fromEntries(sleeves.map((s) => [s.id, s]));
  const seq = (order && order.length ? order : sleeves.map((s) => s.id)).filter((id) => byId[id]);
  const log = (row) => { if (typeof journal === 'function') { try { journal({ ts: new Date().toISOString(), ...row }); } catch (_e) { /* never break a tick for a journal row */ } } };

  // ---- env isolation ------------------------------------------------------------------
  // Sleeve-scoped keys = every key any sleeve map names. Before a sleeve's tick they are
  // ALL deleted and then the sleeve's own map applied, so a key one sleeve sets and the
  // other omits is absent for the other (harness bug #6 was exactly that leak). Keys no
  // sleeve names (TRADER_AUTO_EXECUTE, TRADER_LIVE, the journal paths…) are process-level
  // and untouched. After the tick loop the baseline values of the scoped keys come back.
  const SLEEVE_KEYS = new Set(sleeves.flatMap((s) => Object.keys(s.env || {})));
  for (const k of SLEEVE_KEYS) if (!keyRe.test(k)) throw new Error(`two-sleeve engine: sleeve env key ${k} is not sleeve-scoped (${keyRe})`);
  const baseline = {};
  for (const k of SLEEVE_KEYS) if (process.env[k] !== undefined) baseline[k] = process.env[k];
  const applyEnv = (map) => { for (const k of SLEEVE_KEYS) delete process.env[k]; for (const [k, v] of Object.entries(map || {})) process.env[k] = String(v); };
  const restoreEnv = () => applyEnv(baseline);

  // ---- ownership bridge ---------------------------------------------------------------
  const stats = { collisions: 0, refusedBy: {}, buys: {}, sells: {}, stops: {} };
  const bump = (m, owner) => { m[owner] = (m[owner] || 0) + 1; };
  const symOf = (o) => String((o && (o.ticker || o.symbol)) || '').toUpperCase();
  const idOf = (o) => (o && (o.orderId ?? o.order_id ?? o.id));
  const isStop = (o) => /stop/i.test(String((o && (o.type || o.orderType)) || ''));
  const isBuy = (o) => String((o && o.side) || '').toLowerCase() === 'buy';

  function bridgeFor(owner) {
    const other = (sym) => { const w = ownership.ownerOf(sym); return w && w !== owner ? w : null; };
    return {
      getIBKRAccount: (uid) => facade.getIBKRAccount(uid),
      getIBKRPositions: async (uid) => {
        const raw = (await facade.getIBKRPositions(uid)) || [];
        const rows = Array.isArray(raw) ? raw : (raw.positions || []);
        ownership.reconcile(rows);
        return rows.filter((p) => ownership.ownerOf(symOf(p)) === owner);
      },
      getIBKROpenOrders: async (uid) => {
        const raw = (await facade.getIBKROpenOrders(uid)) || [];
        const rows = Array.isArray(raw) ? raw : (raw.orders || []);
        ownership.pruneOrders(rows.map(idOf).filter((x) => x != null));
        return rows.filter((o) => {
          const oo = ownership.orderOwner(idOf(o));
          if (oo) return oo.owner === owner;
          const so = ownership.ownerOf(symOf(o));
          return so ? so === owner : owner === defaultOwner;
        });
      },
      getIBKRDayPnl: (uid) => facade.getIBKRDayPnl(uid),
      getIBKROrderStatus: facade.getIBKROrderStatus ? (uid, id) => facade.getIBKROrderStatus(uid, id) : undefined,
      cancelIBKROrder: async (uid, id) => {
        const oo = ownership.orderOwner(id);
        if (oo && oo.owner !== owner) return { status: 'error', reason: 'order owned by the other sleeve' };
        return facade.cancelIBKROrder(uid, id);
      },
      placeIBKROrder: async (uid, o) => {
        const sym = symOf(o);
        const w = other(sym);
        if (w) {
          if (isBuy(o) && !isStop(o)) { stats.collisions++; bump(stats.refusedBy, owner); log({ event: 'collision', symbol: sym, loser: owner, winner: w }); }
          return { status: 'error', reason: 'symbol owned by the other sleeve' };
        }
        // `_owner` rides along for facades that attribute fills per sleeve (the replay
        // mock, the engine journal); a real broker facade ignores unknown fields.
        const res = await facade.placeIBKROrder(uid, { ...o, _owner: owner });
        const ok = res && res.status !== 'error' && !res.error;
        if (ok) {
          if (isStop(o)) bump(stats.stops, owner);
          else if (isBuy(o)) { ownership.claim(sym, owner); bump(stats.buys, owner); }
          else bump(stats.sells, owner);
          ownership.tagOrder(idOf(res) ?? res.order_id, sym, owner);
        }
        return res;
      },
    };
  }

  // ---- the tick -----------------------------------------------------------------------
  async function tick(scan, { now = Date.now(), extended = false, protectiveOnly = false, excludeSymbols = [], userId } = {}) {
    const signals = (scan && typeof scan === 'object' && Array.isArray(scan.signals)) ? scan.signals : [];
    const results = {};
    try {
      const raw = (await facade.getIBKRPositions(userId || (sleeves[0].userId))) || [];
      const { released, adopted } = ownership.reconcile(Array.isArray(raw) ? raw : (raw.positions || []));
      if (adopted.length) log({ event: 'ownership_adopted', symbols: adopted, owner: defaultOwner });
      if (released.length) log({ event: 'ownership_released', symbols: released });
    } catch (e) { log({ event: 'reconcile_error', error: String(e && e.message || e) }); }
    for (const id of seq) {
      const sl = byId[id];
      const uni = sl.universe ? new Set([...sl.universe].map((s) => String(s).toUpperCase())) : null;
      applyEnv(sl.env || {});
      // `scan` may be a function of the sleeve, evaluated AFTER its env is applied — the
      // replay harness generates each sleeve's signals from that sleeve's own thresholds.
      const sc = typeof scan === 'function' ? (scan(sl) || {}) : (scan || {});
      const sig = Array.isArray(sc.signals) ? sc.signals : signals;
      const userScan = { ...sc, signals: uni ? sig.filter((s) => uni.has(String((s && (s.symbol || s.ticker)) || '').toUpperCase())) : sig };
      try {
        results[id] = await sl.brain.runAutoTrade(userScan, {
          bridge: bridgeFor(id), userId: sl.userId || userId, now, extended, protectiveOnly,
          excludeSymbols: [...(excludeSymbols || []), ...(sl.excludeSymbols || [])],
        });
      } catch (e) {
        results[id] = { error: String(e && e.message || e) };
        log({ event: 'sleeve_error', owner: id, error: results[id].error });
      } finally {
        restoreEnv();
      }
    }
    return results;
  }

  return { tick, bridgeFor, applyEnv, restoreEnv, stats, order: seq, sleeves: byId, ownership };
}

module.exports = { createEngine, DEFAULT_KEY_RE };
