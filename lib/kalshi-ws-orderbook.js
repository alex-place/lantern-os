"use strict";

/**
 * Kalshi WebSocket order-book maintainer — the pure core of P2-1 (docs/TRADER-ANALYSIS-2026-07.md).
 *
 * The trader polls REST every 6s, so it acts on a book that can be seconds stale — fatal for
 * the arb scanner and the maker quoter, which both need the CURRENT touch. Kalshi's WS
 * `orderbook_delta` channel streams a full snapshot then incremental deltas; the bug-prone
 * part is applying those deltas correctly and noticing when a message was DROPPED (a sequence
 * gap means the local book is silently wrong until you resubscribe). That state machine is
 * this module. The socket transport (connect / subscribe / reconnect) is thin glue layered on
 * top and is intentionally NOT here, so the hard logic is deterministic and unit-testable.
 *
 * Kalshi book model: the book is resting BIDS on each side. A market has yes-bid levels and
 * no-bid levels (price in cents, size in contracts). Because YES and NO are complementary,
 *   best YES ask = 100 − best NO bid      (someone bidding NO@q offers YES@100−q)
 *   best NO  ask = 100 − best YES bid
 * so the full top-of-book is derivable from the two bid ladders.
 *
 * Honesty: an empty side yields a null touch, never a fabricated price. A detected sequence
 * gap sets needsResnapshot and the maintainer reports stale=true until a fresh snapshot lands,
 * so a caller never trades on a book known to be corrupt.
 */

function _emptyBook() { return { yes: new Map(), no: new Map() }; }

function _applyLevel(sideMap, price, size) {
  const p = Number(price);
  const s = Number(size);
  if (!Number.isFinite(p)) return;
  if (!Number.isFinite(s) || s <= 0) sideMap.delete(p);   // size 0 / negative removes the level
  else sideMap.set(p, s);
}

function _bestBid(sideMap) {
  let best = null;
  for (const [p, s] of sideMap) if (s > 0 && (best == null || p > best)) best = p;
  return best;
}

class OrderBook {
  /** @param {string} ticker */
  constructor(ticker) {
    this.ticker = ticker || null;
    this.book = _emptyBook();
    this.seq = null;                 // last applied sequence number
    this.needsResnapshot = false;    // set on a detected gap — caller should resubscribe
    this.hasSnapshot = false;
  }

  /**
   * applySnapshot — replace the whole book. `yes`/`no` are arrays of [priceCents, size].
   * Resets the sequence baseline and clears any gap flag.
   */
  applySnapshot({ yes = [], no = [], seq = null } = {}) {
    this.book = _emptyBook();
    for (const [p, s] of yes) _applyLevel(this.book.yes, p, s);
    for (const [p, s] of no) _applyLevel(this.book.no, p, s);
    this.seq = seq == null ? null : Number(seq);
    this.needsResnapshot = false;
    this.hasSnapshot = true;
    return { ok: true, seq: this.seq };
  }

  /**
   * applyDelta — apply one incremental update {price, side:'yes'|'no', delta, seq}. `delta`
   * is the SIGNED change in resting size at that price. Enforces strict seq+1 ordering:
   * a gap (or a delta before any snapshot) flags needsResnapshot and is NOT applied, so the
   * book never diverges silently.
   * @returns {{applied:boolean, gap?:boolean, reason?:string, seq:number|null}}
   */
  applyDelta({ price, side, delta, seq = null } = {}) {
    if (!this.hasSnapshot) {
      this.needsResnapshot = true;
      return { applied: false, gap: true, reason: "delta before snapshot", seq: this.seq };
    }
    const nSeq = seq == null ? null : Number(seq);
    if (this.seq != null && nSeq != null && nSeq !== this.seq + 1) {
      this.needsResnapshot = true;
      return { applied: false, gap: true, reason: `seq gap: expected ${this.seq + 1}, got ${nSeq}`, seq: this.seq };
    }
    const sideMap = side === "no" ? this.book.no : this.book.yes;
    const cur = sideMap.get(Number(price)) || 0;
    _applyLevel(sideMap, price, cur + Number(delta));
    if (nSeq != null) this.seq = nSeq;
    return { applied: true, seq: this.seq };
  }

  /**
   * bbo — best bid/offer for both sides, in cents. Nulls where a side is empty. `stale` is
   * true whenever a gap is outstanding (book known-corrupt until the next snapshot).
   */
  bbo() {
    const yesBid = _bestBid(this.book.yes);
    const noBid = _bestBid(this.book.no);
    const yesAsk = noBid == null ? null : 100 - noBid;   // YES ask = 100 − best NO bid
    const noAsk = yesBid == null ? null : 100 - yesBid;
    const spread = (yesBid != null && yesAsk != null) ? yesAsk - yesBid : null;
    const mid = (yesBid != null && yesAsk != null) ? (yesBid + yesAsk) / 2 : null;
    return {
      ticker: this.ticker,
      yesBid, yesAsk, noBid, noAsk,
      spreadCents: spread,
      midCents: mid,
      stale: this.needsResnapshot,
      seq: this.seq,
    };
  }

  /** Total resting contracts on a side — a crude depth/liquidity read for the quoter's k. */
  depth(side = "yes") {
    const sideMap = side === "no" ? this.book.no : this.book.yes;
    let total = 0;
    for (const [, s] of sideMap) total += s;
    return total;
  }
}

/**
 * consume — fold a stream of {type, ...} frames into a book. `type` is 'snapshot' | 'delta'.
 * Convenience for tests / replay; live code drives applySnapshot/applyDelta from the socket.
 */
function consume(ticker, frames = []) {
  const ob = new OrderBook(ticker);
  const events = [];
  for (const f of frames) {
    if (f.type === "snapshot") events.push(ob.applySnapshot(f));
    else if (f.type === "delta") events.push(ob.applyDelta(f));
  }
  return { book: ob, events };
}

module.exports = { OrderBook, consume };
