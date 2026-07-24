"use strict";

/**
 * Avellaneda-Stoikov inventory-aware quoting (P2-5, docs/TRADER-ANALYSIS-2026-07.md).
 *
 * A maker on a binary market who quotes a symmetric spread around the mid accumulates
 * INVENTORY RISK: if the price drifts against a lopsided position, the naive maker keeps
 * quoting as if flat and gets run over. Avellaneda & Stoikov (2008) solve for the quotes
 * that maximize expected utility while actively managing inventory — the standard result
 * every serious market-maker starts from.
 *
 * Two pieces:
 *
 *   Reservation price   r = s − q · γ · σ² · (T − t)
 *     The maker's own fair value, SKEWED away from the mid by inventory. Long q>0 pushes r
 *     BELOW the mid so the maker quotes more eagerly to SELL (offload risk); short q<0 pushes
 *     r above the mid. The skew grows with risk-aversion γ, variance σ², and time-at-risk T−t.
 *
 *   Optimal half-spread   δ = ½ γ σ² (T − t) + (1/γ) ln(1 + γ/k)
 *     Half the total quoted spread around r. Widens with risk-aversion, volatility, and time
 *     remaining; the ln term is the fee/liquidity floor (k = order-arrival intensity — how
 *     fast quotes get hit; higher k ⇒ tighter is safe).
 *
 *   bid = r − δ        ask = r + δ
 *
 * Units: this module works in PROBABILITY-CENTS (0..100), matching Kalshi. σ is the per-unit-
 * time stdev of the price in cents, τ = T−t is normalized time-to-close in [0,1]. Quotes are
 * clamped to the tradable 1..99¢ band and never crossed. Everything is deterministic and
 * pure — no I/O, no market calls — so the caller supplies the live mid/σ/inventory.
 *
 * This module QUOTES; it does not place orders. Sizing/placement stays behind the live-order
 * gate stack in kalshi-api.js.
 */

const EULER = Math.E;

function _finite(x, dflt) { const n = Number(x); return Number.isFinite(n) ? n : dflt; }

/**
 * reservationPrice — the inventory-skewed fair value, in cents.
 * @param {number} midCents  current mid price (0..100)
 * @param {number} inventory q — signed net position (contracts); + = long YES
 * @param {object} p  { gamma, sigmaCents, tau }  risk-aversion, per-√time vol (cents), time-to-close 0..1
 */
function reservationPrice(midCents, inventory, { gamma = 0.1, sigmaCents = 5, tau = 1 } = {}) {
  const s = _finite(midCents, 50);
  const q = _finite(inventory, 0);
  const g = Math.max(1e-6, _finite(gamma, 0.1));
  const sig = Math.max(0, _finite(sigmaCents, 5));
  const t = Math.max(0, _finite(tau, 1));
  return s - q * g * sig * sig * t;
}

/**
 * optimalHalfSpread — half the A&S quoted spread, in cents. Always ≥ 0.
 */
function optimalHalfSpread({ gamma = 0.1, sigmaCents = 5, tau = 1, k = 1.5 } = {}) {
  const g = Math.max(1e-6, _finite(gamma, 0.1));
  const sig = Math.max(0, _finite(sigmaCents, 5));
  const t = Math.max(0, _finite(tau, 1));
  const kk = Math.max(1e-6, _finite(k, 1.5));
  const inventoryTerm = 0.5 * g * sig * sig * t;
  const liquidityTerm = (1 / g) * Math.log(1 + g / kk);
  return Math.max(0, inventoryTerm + liquidityTerm);
}

/**
 * quote — the full inventory-aware bid/ask around the reservation price, clamped to 1..99¢
 * and guaranteed not to cross. Returns cents + the diagnostic pieces.
 *
 * @param {object} in
 *   midCents    live mid (0..100)
 *   inventory   signed net position (contracts); + long YES
 *   gamma       risk aversion (>0; higher = more inventory-averse, wider + more skew)
 *   sigmaCents  price volatility per √time, in cents
 *   tau         normalized time-to-close in [0,1] (1 = far from close, 0 = at close)
 *   k           order-arrival intensity (higher = deeper book, tighter safe)
 *   minTickCents minimum half-spread floor (default 1¢ — don't quote inside a tick)
 */
function quote({ midCents = 50, inventory = 0, gamma = 0.1, sigmaCents = 5, tau = 1, k = 1.5, minTickCents = 1 } = {}) {
  const r = reservationPrice(midCents, inventory, { gamma, sigmaCents, tau });
  const half = Math.max(_finite(minTickCents, 1), optimalHalfSpread({ gamma, sigmaCents, tau, k }));
  let bid = r - half;
  let ask = r + half;
  // Clamp to the tradable band; keep at least a 1¢ gap so the quotes never cross after clamping.
  bid = Math.min(98, Math.max(1, bid));
  ask = Math.max(bid + 1, Math.min(99, ask));
  return {
    bidCents: Math.round(bid),
    askCents: Math.round(ask),
    reservationCents: Number(r.toFixed(3)),
    halfSpreadCents: Number(half.toFixed(3)),
    skewCents: Number((r - midCents).toFixed(3)),   // <0 when long (leans to sell), >0 when short
    inventory,
  };
}

module.exports = { reservationPrice, optimalHalfSpread, quote, EULER };
