# What our own model actually has to be — measured from index.html and the trader, not from theory

**Date:** 2026-07-27 · **Type:** Product-grounded specification for the in-house model.
**Scope:** ties ADR-0021 / ADR-0024 / ADR-0026 / ADR-0030 to the workload the app actually
serves today, and to the scale target (~6 founders now → thousands of users inside 2 years).

This is a design document. It commits no training run and changes no code.

---

## 1. What the product actually asks a model to do (measured, not assumed)

Every chat surface in the app posts to **one endpoint**: `POST /api/dream/chat/stream`.

| surface | who uses it | what it sends |
|---|---|---|
| `index.html` | first-touch visitor | free text + starter chips |
| `chat.html` | the main assistant | free text, files, tools |
| `stock-trader.html` | the trader, mid-session | `message` + `history.slice(-10)`, docked beside the chart |
| `kalshi-terminal.html` | the event trader | same |

**That single endpoint is the most valuable asset we have for this plan.** Swapping the model
underneath the whole product is a one-file change, not a rewrite. Nothing about the in-house model
requires touching four front-ends.

**The measured workload** (70 real turns on disk, `data/conversations/garage-conversations.jsonl`):

| | median | p90 | max |
|---|---|---|---|
| user message | 351 chars | 411 | 446 |
| assistant reply | 485 chars (~121 tokens) | 774 (~193 tok) | 3,266 |

Fixed prompt: **438 tokens**. History: **last 10 turns**. Total input ≈ **3.3k tokens/turn**.

**Two facts fall straight out of this, and they should govern the whole design:**

1. **This is a short-context, high-frequency workload.** Not a 200k-context workload. Every
   "we need a huge context window" instinct is wrong for this product.
2. **We are already serving it on the cheap tier and nobody complains.** The models actually
   answering today are `gemini-2.5-flash` (18 turns) and `gpt-4.1-mini` (17). Not frontier.
   **The common path does not need a better model.**

The landing page's own starter chips say who the user is: *"What's moving today?"*,
*"Explain SPY's chart"*, *"How do paper trades work?"* — **two of three are trader questions.**
The trader is not a segment of this product. The trader is the first touch.

---

## 2. Where the money actually goes at scale

Public list prices, applied to the measured turn above:

| | $/turn |
|---|---|
| gemini-2.5-flash (serving now) | $0.0013 |
| gpt-4.1-mini (serving now) | $0.0015 |
| frontier tier, when a hard question escalates | **$0.0874** |

**One escalated turn costs 67× a normal turn.**

| users | turns/mo | if all cheap | if 20% escalate | the difference |
|---|---|---|---|---|
| 1,000 | 450k | $585 | $8,336 | $7,751 |
| 5,000 | 2.25M | $2,927 | $41,681 | $38,754 |
| 10,000 | 4.5M | $5,854 | $83,361 | **$77,507/mo** |

**Read that carefully, because it inverts the usual argument for building your own model.**

Serving 10,000 users' ordinary chat on rented cheap models costs about **$5.9k/month** — against
Pro at $20/mo that is a rounding error. **Cost is not a reason to replace the cheap tier, and we
should stop pretending it is.**

The entire cost curve is the **escalation tier** — the hard questions where the answer has to be
right. That is the ~$78k/month line at 10k users, and it is the only line an in-house model can
meaningfully attack.

**So the target is settled: our model does not replace `gemini-flash` on "what's moving today."
It replaces the frontier call on "is this real, and how sure should I be?"**

---

## 3. What a stock/day trader specifically needs that no rented API sells

Four things, in order of how badly they are needed:

**a) A calibrated "how sure are you" that is measured, not written.**
A trader acting on "this setup looks strong" needs to know whether that means 55% or 80%. Rented
models emit confidence as *prose*, and this repo has already measured that prose confidence tracks
writing style rather than truth (the gloss trap, `v1-10-white-box-honesty-design`). Our own weights
mean we can read the model's internal state instead of its adjectives. **This is the single feature
a trader would pay for and cannot buy.**

**b) Depth on demand, priced accordingly.**
"What's SPY doing?" is a lookup. "Should I take this setup?" deserves ten times the thinking. A flat
API charges the same shape for both. A model that can spend one pass or eight on the same weights
lets the product spend compute where it matters — which is exactly the escalation tier from §2.

**c) Positions and P&L that never leave the machine.**
The trader surface already shows balance, positions, orders, and history. Sending that to a third
party to get an answer about it is a real objection from a real customer, and it gets worse the more
serious the customer is. Local serving answers it completely.

**d) Latency inside the decision.**
The chat rail is docked *beside the chart*, in the moment. A local model on the trader's own box has
no network leg.

Note what is **not** on this list: knowledge, writing quality, long context. Those stay rented, and
that is the correct call (`agi-convergence-blueprint-rent-capability-own-grounding`).

---

## 4. The architecture claim, stated so it can be checked

The honest version of "fundamentally unique in the spiral design" is this:

> **The model's inner loop and the product's outer loop should be the same loop.**

Right now they are strangers. The Spiral (ADR-0030) is an outer loop: propose, verify, keep what
survived, escalate if not. Ouro/LoopLM (ADR-0021) is an inner loop: the same weights applied
repeatedly in latent space, with a learned early exit. Today the outer loop calls the inner loop as
a black box and cannot see it — so the Spiral has to decide "was that good enough?" from the text
that came out, which is the weakest possible signal, and the same weakness §3(a) describes.

**Fusing them:** train the model so its own early-exit signal *is* the Spiral's escalation trigger.
The model stops when it is done; when it cannot get there, it says so *from the inside* rather than
producing confident prose and letting a text-level verifier guess. Depth becomes a measured dial
instead of a fixed price.

That is a real architecture, it is not something any vendor sells, and it is the same mechanism that
delivers §3(a) and §3(b). **It is one build, not three.**

**Verifier-first, not generalist.** The capability audit found six of seven capabilities rented and
only *Verify* genuinely ours. That is not a gap to close — it is the specialisation. Our model
should be trained to **judge**, not to know: given a claim, a chart, and evidence, produce a
calibrated verdict. That is what §2 says we need (the escalation tier is a verification tier), what
§3 says traders need, and — critically — **it is the only thing six people can actually build**,
because it is the one task where we own the training data. Every verified trace the Spiral has ever
run is a labelled example, and the trading surfaces generate ground truth on a schedule the market
sets for free.

---

## 5. What this changes about the current plan

The existing ADRs are close, and the corrections are small but load-bearing:

| ADR | stands | correction |
|---|---|---|
| **0021** retain the Ouro loop | ✅ | the loop is the *reason*, not an implementation detail — it becomes the escalation signal |
| **0024** frontier program | ⚠️ | six people cannot pretrain a frontier model. Re-scope to **post-train a strong open base into a verifier**, keeping knowledge rented |
| **0026** ternary ≤8GB | ✅ | correct for the trader's own box. But **8GB local cannot serve thousands** — the same artifact needs a batched cloud shape too (ADR-0018 web-tier split) |
| **0030** Spiral | ✅ | Phase 0 stands. §4 is the concrete content of its gated Phase 1 |

**Two deployment shapes, one artifact:** local ≤8GB for the trader who wants their positions to stay
home, and a batched cloud copy for everyone else. Same weights, same endpoint.

---

## 6. What would kill this, stated up front

- **If the escalation rate is low, the business case is thin.** The §2 table assumes 20%. If the
  real rate is 3%, rented frontier costs $12k/mo at 10k users and building is a worse use of six
  people than shipping features. **This number is not measured yet, and it is the single most
  important number in this document.** It is a one-week instrumentation task on the live endpoint.
- **If our verifier is not better than the frontier at judging, there is no product.** The whole
  case rests on being better at one narrow thing, not at everything.
- **If calibration does not survive ternary,** the local shape is dead and only the cloud shape
  ships. ADR-0026's accept gate already covers this; it must include a calibration check, not just
  a quality check.

## 7. The next measurement, not the next build — **now shipped, and it already bites**

**Instrumented 2026-07-27.** `lib/chat-escalation-meter.js`, hooked into the single
`logConversation` funnel in `lib/stream-chat.js` (one site covers all ~15 provider legs), readable
at **`GET /api/metrics/escalation`**. Records derived scalars only — tier, sizes, latency, a
one-way session hash — and never message text, because the trader surface carries positions and
P&L through this same path. Fail-open: metering cannot break a chat turn. 20 unit tests.

### The first reading contradicts this document's own headline assumption

Backfilled over the 35 real assistant turns already on disk:

| | value |
|---|---|
| realized escalation rate | **0%** (0 of 35 — all cheap tier) |
| demand signal (turns that *looked* hard) | **2.9%** (1 of 35) |
| sample adequate? | **no** — the bar is 1,000 turns |

**§2 assumed 20% escalation. The only data we have says the demand is nearer 3%.** At n=35 that is
not decisive — the 95% interval on 1/35 spans roughly 0–15% — but the point estimate sits an order
of magnitude below the assumption, and every conclusion in §2 that leaned on 20% must be treated as
unsupported until re-measured. The $78k/mo escalation premium is, on current evidence, more likely
to be single-digit thousands.

### Why the 0% is not itself the answer

Realized tier measures **what we chose**, not what was needed. Chat escalation is effectively off
by default (`lib/router-gate.js` only escalates under `ROUTER_GATE=1`), so a 0% realized rate is
guaranteed by configuration and says nothing about demand. That trap is why the meter computes the
router gate in **measure-only mode** on every turn regardless of the flag, and why `summarize()`
returns `POLICY-BOUND` rather than `BUILD-NEGATIVE` when realized is zero but demand is not — with
a test pinning exactly that case.

### What this changes about the argument

**The cost case for owning a model is weaker than §2 implied.** What survives is §3: calibrated
confidence, positions that stay on the box, latency inside the decision, depth on demand. Those are
capability arguments, not cost arguments, and they do not depend on the escalation rate at all.

That is the honest position: **build it for what it lets traders do, not for what it saves.**

### Still open

- **n ≥ 1,000 turns** before this reading means anything. Needs the server running.
- **Enable escalation on a slice.** Demand measured by a hand-tuned heuristic gate is a proxy; the
  real number needs turns that were actually allowed to escalate, with the outcome compared.
- **Live end-to-end verification of the hook** — unit-tested and handler-tested, but both local
  servers are down, so no turn has yet flowed through it in production.
