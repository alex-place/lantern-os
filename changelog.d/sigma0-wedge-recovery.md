### Autowork: wall-clock wedge-recovery for the auto-dispatch in-flight lock (Σ₀ sustained-work R3)

Closes a **Converge**-stage sustained-work failure mode: the autonomous-work dispatcher serializes one run at a time via an in-memory `inFlight` lock, but the 20-minute dispatch budget is a *socket-inactivity* timeout, not a wall clock. A slow-but-active autonomous-work stream (data trickling, never a `done`) can outlast it without ever settling, pinning `inFlight=true` and blocking **every future tick for the rest of the process lifetime** — the loop silently dies.

- **Hard ceiling (`auto-dispatch.js`):** add `inFlightSince` + an `inFlightStale()` predicate and a `staleMs()` ceiling (`AUTO_DISPATCH_STALE_MS`, default `40m` = 2× the dispatch budget). When `tick()` finds the lock held past the ceiling, it force-releases it, records the wedge as a failed `history` entry (`stoppedAt: "wedge_recovered: …"` — visible, not silent), and dispatches fresh. The `finally` block now clears `inFlightSince` alongside `inFlight`.
- **Tests:** `test/auto-dispatch-stale.test.js` — `inFlightStale` false when idle / fresh, true past the ceiling; `staleMs` default 40m, env-tunable, floored at 60s.

### Design: Keystone-Σ₀ self-converging kernel + chat harness for sustained work

Adds `docs/KEYSTONE-SIGMA0-SUSTAINED-WORK-DESIGN.md` — the unified design tying **Keystone chat**, the owned **Σ₀ PLT model** (ADR-0011), and the **loopcoder-based Adaptive Loop Gate** adapter into one *self-converging contract* (depth + halt certificate + per-token surprise), framed as a pumped-lossy-resonator. Records honestly that the Verify-side surprise-leak valve (recalibration + wiring) already shipped on `master` (#1673/#1676/#1678/#1681); the open runtime work is the resonator drift monitor + patch abstention, and the substantive forward work is the GPU-gated Track M (own the PLT kernel + train the ALG halt head).
