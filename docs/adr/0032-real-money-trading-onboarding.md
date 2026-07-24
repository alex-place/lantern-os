# ADR-0032: Real-money trading onboarding — how a user goes from paper to live, safely

- **Status:** Proposed (awaiting Alex's approval) — **design only; no live trading is enabled by this ADR**
- **Date:** 2026-07-24
- **Deciders:** Alex Place (pending)
- **Loop stage:** Reason (gating) + Act (contained execution) + Verify (mandate + audit)
- **Relates to:** ADR-0027 (one-click broker connect / per-user Alpaca), ADR-0028 (managed-strategy Sharpe-CI mandate + contained execution), ADR-0020 (live order gating), the Alpaca BYOK paste-your-keys work (paper), the active-trader switch (Stock ↔ Champion). Prohibited-action policy: the assistant never executes trades or enters credentials on the user's behalf — a person always decides.

## Context

We now let a user paste their own **Alpaca PAPER** API keys and trade a paper account, pick which trader (Stock day-trader / Champion allocation) runs it, and the whole stack is **paper-only, DRY-by-default**. The obvious next want is **real money**. That is a categorically higher-risk surface (irreversible loss of the user's actual funds, plus regulatory exposure), so before any of it is built we fix *the rules* for how a user is allowed to cross from paper to live — and make explicit what stays impossible.

Nothing here turns on live trading. This ADR is the contract the eventual implementation must satisfy.

The pieces that already exist and this ADR leans on:
- **Per-user encrypted credential store** (`lib/alpaca-credentials.js`, AES-256-GCM) with an `env` field that already distinguishes `paper` vs `live`, and a paper-only guard that **refuses a non-paper account outright** in the allocation engine.
- **The hard order gate** (`lib/trading-guard.js`): DRY unless `TRADER_LIVE=1`; a live account additionally requires `TRADER_ALLOW_LIVE_ACCOUNT=1`; per-order notional/qty caps; a global kill-switch file. Paper fills bypass the gate (simulated money); **only live orders are gated**.
- **The ADR-0028 Sharpe-CI mandate**: no autopilot strategy may manage real capital until its Sharpe **confidence-interval lower bound ≥ the mandate (0.79, the "Buffett bar")**. Nothing has met it; everything sits in paper.

## Decision (proposed)

**1. Live keys are a separate, explicit credential — never a promotion of paper keys.**
A user who wants real money enters a **distinct** live Alpaca key/secret (`env: 'live'`), stored in the same encrypted per-user store but never derived from, or auto-switched from, their paper keys. Paper and live coexist; the active one is an explicit choice, defaulting to paper. Removing/rotating live keys is one click and always available.

**2. Enabling live is a deliberate, multi-step opt-in — never a toggle buried in settings.**
Before a user's account can place a live order, ALL must hold:
   a. The operator has enabled the capability on the deployment (`TRADER_LIVE=1` **and** `TRADER_ALLOW_LIVE_ACCOUNT=1` — the existing double-gate).
   b. The user has entered live keys (step 1) and passed a **explicit risk attestation** (see §4).
   c. The order passes the existing hard gate (caps, kill-switch, known account mode).

**3. Manual live trades: allowed with per-order confirmation. Autopilot on live: gated on ADR-0028.**
   - **Manual** buy/sell on a live account is permitted once §2 holds, but **every live order requires an explicit, non-default confirmation** showing symbol, side, qty, est. notional, and account — **never one-click, never a rapid-fire mode**. (The assistant itself still never places the order; the user confirms and the UI submits.)
   - **Autopilot** (day-trader *or* Champion) may manage **real** capital **only for a strategy whose measured Sharpe CI lower bound clears the ADR-0028 mandate** on that account's own paper track record. Until then, autopilot on a live account stays **plan-only / DRY** — it can show what it *would* do, but places nothing. This is the whole point of the paper track record the engines already log.

**4. Informed-consent gate (regulatory posture).**
First time a user enables live, they must read and affirm a plain-language disclosure: this is **self-directed** trading of their own funds through their own broker; **we are not a broker-dealer or investment adviser and this is not financial advice**; past/paper performance does not predict results; they can lose money; they are responsible for their trades and taxes. The attestation (version + timestamp) is recorded. This is a product/compliance checkpoint, not a checkbox to rush.

**5. Auditability + reversibility.**
Every live order (intent, gate decision, broker response) is appended to an audit log distinct from the paper ledger. The global kill-switch halts all live placement instantly. Live can be disabled (and keys removed) by the user at any time, immediately reverting to paper.

## Consequences

- The safe default is unchanged: **everything is paper** until a user *and* the operator *and* the mandate all say otherwise. Shipping paper features never risks real money.
- Real money for **autopilot** is expected to stay gated for a long time — nothing has met the Sharpe-CI bar — which is intended: the gate holds strategies in paper until they've earned live capital.
- Manual live trading can be offered earlier (it's the user's own decision per order), but only behind the operator capability flag, the attestation, and per-order confirmation.
- New surface to build when approved: a live-key entry UI (separate from paper), the attestation flow + record, the per-order live-confirm dialog, and the live audit log. None exist yet.

## Rejected alternatives

- **One flag flips paper→live on the same keys.** Rejected: conflates two different accounts, invites an accidental live trade, and makes "am I on real money?" ambiguous. Live is always a separate, explicitly-entered credential.
- **Let the autopilot trade live once the operator arms it (skip the Sharpe-CI mandate).** Rejected: contradicts ADR-0028; no strategy has demonstrated an edge whose CI clears the bar. Arming ≠ evidence.
- **One-click / rapid live orders for parity with the paper UX.** Rejected for live: every real-money order gets an explicit confirmation. Paper can stay fast; live cannot.
- **The assistant places live orders when asked.** Rejected — prohibited by policy regardless of this ADR; the assistant never executes trades or enters credentials. It can prepare and explain; the human confirms and submits.

## Sources

- ADR-0027 (per-user broker connect), ADR-0028 (Sharpe-CI mandate + contained execution), ADR-0020 (live order gating).
- `lib/trading-guard.js` (the existing DRY / `TRADER_LIVE` / `TRADER_ALLOW_LIVE_ACCOUNT` / caps / kill-switch gate); `lib/alpaca-credentials.js` (encrypted per-user store with `env` paper/live); `lib/sigma-trader.js` (paper-only refusal, DRY-by-default governance).
