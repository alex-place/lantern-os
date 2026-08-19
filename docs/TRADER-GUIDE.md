# Trader Guide — from zero to a running autopilot

This is the complete path for a new user: create an account, connect a broker,
choose what runs, turn it on, understand what it does, and turn it off.
Everything here matches what the app actually enforces — where a step is gated
(by plan tier or by safety rule), the gate is stated.

---

## 1. Create your account {#signup}

1. Go to **unisona.ai** and open **Sign in → Create account**.
2. Enter your name, email, and a password, accept the terms, and submit.
3. **Check your email** for a 6-digit verification code and type it into the
   boxes on the page. You cannot log in until the address is verified.
4. Log in with your email and password.

> No code arrived? Check spam; the sender is `no-reply@unisona.ai`. The code
> entry stays on the same page — don't navigate away.

## 2. Connect your Alpaca account {#connect}

The trader runs on **your own** Alpaca paper account. We never see your Alpaca
password, and pasted keys are stored encrypted on the server — they are never
shown again, logged, or shared.

1. Create a free account at **alpaca.markets** if you don't have one.
2. In Alpaca, open **Paper Trading → API Keys** and generate a key pair.
3. In unisona.ai, open **Settings → Connections → Alpaca → Connect**.
4. Paste the **API Key ID** (`PK…`) and **Secret Key**, and connect.
   The server validates the keys against Alpaca before storing them — a typo
   fails immediately, nothing broken is ever saved.

**Paper only.** The connect flow accepts paper keys and refuses live ones —
live trading is a separate, deliberately gated step and is not enabled through
this form.

## 3. Choose whose money and which strategy {#choose}

Two independent switches, both in the trader UI / Settings:

**Account mode** — whose money the trader acts on:
| mode | what it is |
|---|---|
| **Demo** | Read-only tour of the Champion book. Can *never* place an order — enforced server-side. |
| **Paper** | Your own practice account: your connected Alpaca paper account, or (until you connect one) a house practice ledger. |
| **Trade** | Live money. Requires live keys and separate arming; not available through the normal flow. |

**Trader** (Settings → Connections → *Autopilot on your account*):
| setting | what runs |
|---|---|
| **⏸ Off** | Nothing. The autopilot never touches your account — no entries, no exits. You trade manually. **This is the default.** |
| **📈 Intraday** | The day-trader: automated washout entries and ladder exits on liquid ETFs, plus your own manual buy/sell alongside. |
| **🏆 Champion** | The slow allocation book: a diversified ETF portfolio, rebalanced on a schedule. The intraday trader is paused while this is active. |

One account runs one strategy at a time. Switching is instant and takes effect
on the next scan.

## 4. Turn it on, and what to expect {#running}

Flip the Trader switch from **Off** to **Intraday** (or **Champion**). That's
the whole arming step on your side.

What the intraday autopilot does with your account:

- **Scans about once a minute** during market hours (slower when closed).
- **Enters long positions only**, on liquid ETFs from the curated watchlist,
  when a symbol is washed out (trading at the bottom of its session range).
- **Sizes positions** as a percentage of your account equity, with a hard cap
  on how many positions are open at once and a cash reserve that is never
  spent.
- **Every position carries a protective stop** at the broker from the moment
  it's opened — the stop exists even if the app goes down.
- **Exits on a ladder**: it banks profit at the first resistance level, lets a
  runner ride through the second, and trails it after that. Losses exit at the
  stop, full stop.
- **Records everything** in your trade journal: every entry, every exit with
  its P&L, and every opportunity it *declined* with the reason.

You can place your own manual orders at any time; the autopilot manages only
the positions it opened.

> **Plan note:** paper trading needs the Pro plan; the autonomous AI trader is
> a Pilot-plan capability. The Settings page shows exactly what your plan
> includes.

## 5. Turn it off {#stopping}

- **Pause the autopilot:** Settings → Connections → Trader → **⏸ Off**.
  Takes effect on the next scan (within ~1 minute). *Off is fully hands-off*:
  the autopilot will not open **or close** anything — positions it had open
  are now yours to manage, along with their broker-side protective stops,
  which stay in place.
- **Disconnect Alpaca:** Settings → Connections → Alpaca → **Disconnect**.
  Your stored keys are deleted from the server. Open positions and stops
  remain in your Alpaca account (we never had custody — it was always your
  account).
- **Delete your account:** Settings → Account → Delete. Broker credentials
  are removed with it.

## 6. Where to look when something seems off {#troubleshooting}

| symptom | first check |
|---|---|
| "Not signed in" flickers | The server may be restarting; reload in ~30s. |
| Connect Alpaca fails | Regenerate the key pair in Alpaca (paper section!) and paste both values fresh. |
| Autopilot "isn't trading" | Is the Trader switch on? Is the market open? The journal's *skip log* shows every declined opportunity and why — most "not trading" is the trader correctly declining. |
| A position closed "by itself" | Check the journal: stops and ladder exits are recorded with their reason. |

The algorithm itself — what the signals are, why the stops are wide, what was
measured and rejected — is documented separately in the trader algorithm paper
(ask in chat or see the docs index).
