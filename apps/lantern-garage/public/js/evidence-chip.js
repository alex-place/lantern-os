/**
 * evidence-chip.js (#2252) — one shared, at-a-glance verdict on a trading signal's
 * EVIDENTIAL status, reused across the trader surfaces (kalshi-terminal, kalshi-screener,
 * stock-trader, trading) so a paper/estimate edge is never dressed up as a proven one.
 *
 *   MEASURED  — a real settled track record backs it (Brier over n≥20 resolved calls)
 *   UNPROVEN  — a positive net-of-fee edge ESTIMATE, but no settled track record yet
 *   NO EDGE   — nothing grounded, or non-positive after fees → defer to the market
 *
 * Usage: include this script, then `window.evidenceChip(sig)` → HTML string.
 * `sig` is a normalized shape (any surface maps its own model to it):
 *   { grounded:Bool, edgeCents:Number, n:Number, brier:Number }
 * A convenience `window.evidenceChip.fromKalshiCard(card)` maps the Kalshi deck/screener
 * card model (card.edge / card.sigma0) onto that shape. Defensive throughout: unknown or
 * partial data falls to UNPROVEN or NO EDGE — it never over-claims.
 */
(function () {
  "use strict";
  var TRACK_MIN = 20; // same n≥20 settled bar the weather verifier uses

  // Pure classification → { cls, label, evCents, sub }. Presentation-free so a surface
  // can render it as a full card chip or a compact table pill.
  function classify(sig) {
    sig = sig || {};
    var evCents = (sig.edgeCents != null) ? sig.edgeCents : null;
    if (!sig.grounded || evCents == null)
      return { cls: "dead", label: "NO EDGE", evCents: null, sub: "no grounded edge — deferring to the market price" };
    if (evCents <= 0)
      return { cls: "dead", label: "NO EDGE", evCents: evCents, sub: "market is fair or richer after fees — no edge claimed" };
    if (typeof sig.n === "number" && isFinite(sig.n) && sig.n >= TRACK_MIN)
      return { cls: "measured", label: "MEASURED", evCents: evCents,
        sub: "settled track record: n=" + sig.n + " resolved calls" + (sig.brier != null ? " · Brier " + sig.brier.toFixed(2) : "") };
    return { cls: "unproven", label: "UNPROVEN", evCents: evCents,
      sub: "edge estimate — " + (isFinite(sig.n) && sig.n > 0 ? "only n=" + sig.n : "no") + " settled outcomes yet (need " + TRACK_MIN + ")" };
  }

  function evStr(evCents) { return (evCents == null) ? "" : (evCents > 0 ? "+" : "") + evCents + "¢ net"; }

  // Full chip (cards): label + net-of-fee EV + a wrapped plain-language explanation.
  function evidenceChip(sig) {
    var v = classify(sig), e = evStr(v.evCents);
    return '<div class="ev-chip ' + v.cls + '" title="' + String(v.sub).replace(/"/g, "&quot;") + '">'
      + '<span class="ev-lead">' + v.label + "</span>"
      + (e ? '<span class="ev-ev">' + e + "</span>" : "")
      + '<span class="ev-sub">' + v.sub + "</span></div>";
  }

  // Compact pill (dense tables/watchlists): label + EV only; the explanation is the tooltip.
  evidenceChip.compact = function (sig) {
    var v = classify(sig), e = evStr(v.evCents);
    return '<span class="ev-chip-c ' + v.cls + '" title="' + String(v.sub).replace(/"/g, "&quot;") + '">'
      + '<span class="ev-lead">' + v.label + "</span>"
      + (e ? '<span class="ev-ev">' + e + "</span>" : "") + "</span>";
  };
  evidenceChip.classify = classify;

  // Map the Kalshi deck/screener card (card.edge{grounded,edgeCents,n,brier}, fallback
  // sigma0.ev_cents) onto the normalized signal shape.
  evidenceChip.kalshiSig = function (card) {
    var e = (card && card.edge) || {};
    var s = (card && card.sigma0) || {};
    return {
      grounded: !!e.grounded,
      edgeCents: (e.edgeCents != null) ? e.edgeCents : (s.ev_cents != null ? s.ev_cents : null),
      n: e.n,
      brier: e.brier,
    };
  };
  evidenceChip.fromKalshiCard = function (card) { return evidenceChip(evidenceChip.kalshiSig(card)); };

  // Inject the component CSS once (colors come from site.css tokens, so it themes + is AA).
  function injectCss() {
    if (document.getElementById("ev-chip-css")) return;
    var css =
      ".ev-chip{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px;padding:5px 9px;" +
      "border-radius:7px;font-size:11px;line-height:1.4;border:1px solid;" +
      "font-family:'IBM Plex Mono',ui-monospace,monospace}" +
      ".ev-chip .ev-lead{font-weight:800;letter-spacing:.1em;font-size:9.5px;padding:1px 6px;border-radius:4px}" +
      ".ev-chip .ev-ev{font-weight:800}" +
      ".ev-chip .ev-sub{opacity:.7;font-size:10px;flex-basis:100%}" +
      ".ev-chip.measured{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.4);color:var(--text)}" +
      ".ev-chip.measured .ev-lead{background:var(--green);color:#06240f}" +
      ".ev-chip.measured .ev-ev{color:var(--green)}" +
      ".ev-chip.unproven{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.4);color:var(--text)}" +
      ".ev-chip.unproven .ev-lead{background:var(--gold);color:#3a2905}" +
      ".ev-chip.unproven .ev-ev{color:var(--gold)}" +
      ".ev-chip.dead{background:var(--surface2);border-color:var(--border);color:var(--muted)}" +
      ".ev-chip.dead .ev-lead{background:var(--muted);color:var(--surface)}" +
      // compact pill for dense tables/watchlists
      ".ev-chip-c{display:inline-flex;align-items:center;gap:5px;padding:1px 6px;border-radius:5px;" +
      "border:1px solid;font-size:10px;font-family:'IBM Plex Mono',ui-monospace,monospace;white-space:nowrap}" +
      ".ev-chip-c .ev-lead{font-weight:800;letter-spacing:.08em;font-size:9px;padding:0 4px;border-radius:3px}" +
      ".ev-chip-c .ev-ev{font-weight:700}" +
      ".ev-chip-c.measured{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.4);color:var(--text)}" +
      ".ev-chip-c.measured .ev-lead{background:var(--green);color:#06240f}.ev-chip-c.measured .ev-ev{color:var(--green)}" +
      ".ev-chip-c.unproven{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.4);color:var(--text)}" +
      ".ev-chip-c.unproven .ev-lead{background:var(--gold);color:#3a2905}.ev-chip-c.unproven .ev-ev{color:var(--gold)}" +
      ".ev-chip-c.dead{background:var(--surface2);border-color:var(--border);color:var(--muted)}" +
      ".ev-chip-c.dead .ev-lead{background:var(--muted);color:var(--surface)}";
    var st = document.createElement("style");
    st.id = "ev-chip-css";
    st.textContent = css;
    document.head.appendChild(st);
  }
  if (document.head) injectCss();
  else document.addEventListener("DOMContentLoaded", injectCss);

  window.evidenceChip = evidenceChip;
})();
