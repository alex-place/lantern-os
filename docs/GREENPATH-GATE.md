# Greenpath Gate — the release gate for the first-50 invite program

**Status: RELEASE GATE.** Before any real person from the first-50 cohort is
invited, the full user journey must run green for **all 10 demo accounts** —
every step, every account (product plan v5 §05 "Getting the first 50 people",
step 1; tracked as [#2545](https://github.com/alex-place/lantern-os/issues/2545)).
A RED run blocks the invite program until fixed and re-run green.

```bash
npm run test:greenpath                       # the gate: 10 accounts × 9 steps
GREENPATH_ACCOUNTS=2 npm run test:greenpath  # smoke run while iterating
```

The Playwright exit code is the machine-readable verdict (any red step fails the
run). Every run also appends one audit record to **`data/greenpath-runs.jsonl`**
(per-account × per-step status + duration + failure details) and prints the
matrix with a `Gate: GREEN|RED` line.

## The journey (per account)

The harness registers a fresh local account (`greenpath-<runId>-aNN@greenpath.test`)
and walks the 9 steps from #2545. Steps keep the issue's numbering; execution
runs **s6 before s4/s5** because every `/api/trading/*` mutation is server-gated
on the `trade` entitlement (Pro) today — the Free account meets the upgrade gate
exactly when it first tries to trade, which is what s6 verifies.

| Step | What is verified | How |
|---|---|---|
| s1 | Sign up (email+password) through the real form, **hard email gate included** | UI: register → dev confirm link → typed login |
| s2 | Paper-trading account view for Free | `GET /api/trading/positions?demo=champion` |
| s3 | Watchlist persists per-user | `POST/GET /api/trading/watchlist` |
| s6 | Free→Pro gate renders + upgrade works | UI CTA "Upgrade to trade →" on stock-trader, API 403 `{entitlement:"trade"}`, "Unlock this feature" page on kalshi-terminal; then staff `POST /api/accounts/role` (stands in for the purchase), session invalidation + re-login |
| s4 | Place a paper trade | `POST /api/trading/kalshi/paper-trade` (1 YES @5¢ on the paper ledger) |
| s5 | Chat remembers the trade context | UI: two typed turns in dream-chat; turn 2 must recall the traded ticker |
| s7 | Connect a test broker (Pro) | `GET /api/broker/alpaca/status` must report connected or configured |
| s8 | BYOK provider keys persist server-side (#2505) | `POST/GET/DELETE /api/providers/set-key` set → masked → cleared |
| s9 | Trade journal + tag the trade | `GET paper-history` shows the s4 trade; `POST paper-close {exitTag}` tags it; re-read confirms |

Real-browser rule: signup, the upgrade prompt, and both chat turns are typed and
clicked in the page. The data-plane steps call the same `/api` endpoints the
pages call, through the same browser context and session cookie — no header
spoofing, no server-side injection. The only test-auth usage is the **staff**
role-upgrade + cleanup calls (`X-Test-Auth`), standing in for the purchase
webhook, since real payments cannot (and must not) be automated.

## Host prerequisites

The gate runs against a real server boot (`tests/playwright-greenpath.config.ts`
starts it on port 4323 with trading routes live and collectors off). For all
steps to be green the host needs:

1. **No mail provider for the gate server.** s1 depends on the loopback no-mailer
   `devVerifyCode` flow. The config force-blanks `RESEND_API_KEY` and
   `SMTP_HOST/USER/PASS` — both are required, since `mailerConfigured()` is
   Resend **or** SMTP — **but a repo-root `.env.local` overrides env at boot**, so
   run the gate from a checkout whose `.env.local` configures neither (the failure
   message names this).
2. **A working LLM provider key** in the host env (chat, s5).
3. **Alpaca paper access** (s7): either operator server keys
   (`ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`, `ALPACA_ENV=paper`) or the OAuth
   app (`ALPACA_OAUTH_CLIENT_ID`/`SECRET`). Without either, s7 is honestly RED —
   the journey a Pro invitee would hit is broken on that host.
4. Playwright installed (`npm i` at repo root + `npx playwright install chromium`).

Budget note: registrations + logins are IP-throttled (40 auth writes / 15 min /
IP in `lib/local-auth.js`). A 10-account run spends 30; the config never retries
and always boots a fresh server (the throttle is per-process), so back-to-back
full runs are safe. Don't raise `GREENPATH_ACCOUNTS` above ~13.

Housekeeping: demo accounts are archived (soft-deleted) in teardown
(`GREENPATH_KEEP_ACCOUNTS=1` to keep them for inspection). Paper positions are
closed flat in s9, so the shared wallet only pays the ~2¢ round-trip fee per
account per run.

## Known product gaps the gate encodes honestly

- **No per-user auto-provisioned paper account** (the #2545 "depends on" item):
  Free sees the champion demo; the Kalshi paper wallet is one shared ledger and
  unlocks at Pro. s2's pass detail records this every run.
- **Trade tagging** is the journal's close-tag (`exitTag`), not a free-form
  annotate-any-trade feature; s9 exercises what exists.
- **BYOK is not Pro-gated server-side** (plan-matrix says `byok_keys: pro`; the
  routes only require a session). The harness runs s8 as Pro, matching the
  intended journey, and this divergence is noted here rather than asserted.

## Run record schema (`data/greenpath-runs.jsonl`, one line per run)

```json
{ "ts": "…", "runId": "…", "kind": "greenpath-gate", "issue": 2545,
  "baseURL": "http://127.0.0.1:4323", "accounts": 10, "durationMs": 0,
  "gate": "GREEN|RED", "greenAccounts": 10, "totalSteps": 90,
  "passed": 90, "failed": 0, "skipped": 0,
  "steps": { "a01": { "s1": { "status": "pass|fail|skipped", "ms": 0, "detail": "…" }, "…": {} } },
  "failures": [ { "account": "a01", "step": "s5", "detail": "…" } ] }
```

Related: [docs/TEST-AUTH.md](TEST-AUTH.md) (the token-gated test-auth mechanism),
`tests/e2e-greenpath/` (spec + report writer), issue #2545.
