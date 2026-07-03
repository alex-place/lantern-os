- **Trader signals now carry a Σ₀ convergence verdict (deterministic, no LLM loop).**
  Each actionable signal from the Node scan is scored by the convergence-EV layer
  (`lib/signal-engine/convergence-ev.js` + per-asset `profiles.js`) into an
  ENTER/SKIP decision with `p_win`, `ev_r`, and a Kelly-style `size_mult` — the
  Reason/Verify decisioning that replaced the Python Grok/Claude entry loop. The
  60s autoscan already runs on the Node engine; the calibration/Converge grader
  stays at `/api/trading/sigma0/calibration`. Phase 3 of the Python-trader removal.
