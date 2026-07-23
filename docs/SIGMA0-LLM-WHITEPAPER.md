---
author: Alex Place (drafted by Claude lane, 2026-07-23)
created: 2026-07-23
audience: everyone — no AI background needed
technical-companion: research/2026-07-23-sigma0-llm-design.md (the precise version, with evidence classes)
---

# The Σ₀ White Paper — a small AI you actually own

*The plain-English version of our model design. Every claim here has a precise, sourced twin in
the [technical design doc](research/2026-07-23-sigma0-llm-design.md). Where we're guessing, we
say so and say how confident we are.*

---

## The idea in one sentence

**A small AI that lives on your own computer, works a problem for as long as you let it, checks
every answer against reality before claiming it, and only "phones a friend" in the cloud when
it's truly stuck — so you own your intelligence instead of renting it.**

## The problem

Today's best AIs live in datacenters. You rent them by the message. That means: no internet, no
AI. Your questions travel to someone else's computer. And the bill never ends. The obvious fix —
run an AI on your own machine — has an obvious catch: models small enough to fit on a normal
computer are noticeably dumber than the giants.

Our bet is that for a huge slice of real work, that catch can be beaten. Not by making a small
model magically as smart as a giant one — that's impossible and we won't claim it — but by
making a small model **careful** in a way giants aren't asked to be.

## The trick: it's easier to check an answer than to create one

Some work is *verifiable*: code either passes its tests or it doesn't; a math answer either
checks out or it doesn't. For that kind of work, you don't need a genius on the first try. You
need a decent guesser plus a ruthless checker.

That's the whole design:

1. **Try** — the small model proposes an answer.
2. **Check** — we actually *run* it (real tests, real execution — not the model's opinion of
   itself). Wrong answers die here.
3. **Try again, smarter** — the model sees exactly *what failed* and refines. It keeps only
   steps that provably moved forward. We call this loop **the Spiral**, and it can keep working
   one problem for as long as your budget allows — an "anytime" machine: the longer it runs, the
   better its answer, never worse.
4. **Phone a friend — rarely, and smartly** — if the small model is genuinely stuck, we send its
   best attempt *plus the exact failing tests* to a big cloud model, which acts as a **repair
   shop, not a replacement**. Then the fix is re-checked the same way. Every rescue is saved as
   a lesson the small model trains on later, so it escalates less over time.
5. **Or say "I can't"** — if nothing verifies, it says so plainly. It never bluffs a success.

The math behind step 1–2 is old and solid: if one guess is right 30% of the time, ten
independent checked guesses get you above 97% — *provided the checker is real*. Ours is.

## Why it doesn't quietly go crazy

Small AIs that "think in loops" have a known failure: run the loop too long and they spiral into
nonsense or freeze into repeating themselves — like a person ruminating instead of thinking. We
spent months building the mathematics of this (our [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md)
— partly *proven*, partly measured, honestly labeled which is which). The product enforces three
guards from it:

- **A stability meter on every thought-loop.** If the loop's internal dynamics start spinning
  out (a measurable number crosses 1), that answer is rejected automatically.
- **An anti-freeze nudge.** If the system starts locking up into a rut, a small controlled kick
  keeps it moving. Proven to prevent permanent freeze in our test regime; switched on with a
  strict budget and receipts.
- **The reality rule.** The system's *own* confidence is only ever treated as a smoke alarm —
  never as proof. Only fresh external checks (tests, executions, held-out problems) can promote
  an answer or a new version of the model. We measured why: a model grading itself flatters
  itself; a memorized answer can pass every test it has seen and still fail the one it hasn't.
  So we always hold some tests back, like a teacher keeping the real exam sealed.

## What it runs on

- **Your machine:** a normal laptop or desktop — the working target is a model of **3 billion
  parameters or less, in about 4GB of memory, viable on a CPU**. (For scale: frontier cloud
  models are hundreds of times larger.) The bigger 7B-class model is strictly the "phone a
  friend on your own network" tier — it's too heavy to be the product.
- **Tomorrow:** a compression technique called *ternary* (weights that are just −1, 0, or +1)
  that in published work fits a 7B-class brain into ~2GB and runs fast on plain CPUs. If our
  honesty signals survive that compression — a make-or-break test we've flagged — that's the
  path to "big-model feel on the computer you already own."

## Who else is out there (and where we honestly fit)

| Them | What they are | How we differ |
|---|---|---|
| **Frontier clouds** (GPT/Claude/Gemini class) | The smartest, at $10–$200 per hard task, online only | We don't compete on peak genius. We compete on *verified answers per dollar, offline*. |
| **Small open models** (Qwen, Phi, Gemma, ~1.5–4B) | Excellent raw material — we build *on* one | Alone they answer once and hope. We wrap one in the check-refine-escalate machine. |
| **Looped research models** (Ouro / HRM / TRM family) | Our closest architectural cousins — small models that think in loops | They're research artifacts; some score by memorizing. We add the stability guards + the external checker they lack. |
| **Cost-router products** (FrugalGPT-style cascades) | Same "cheap first, escalate rarely" economics | They're cloud-to-cloud cost tools. Ours is local-first, and quality is enforced by *execution*, not price alone. |

**On the famous ARC leaderboard** (a test of learning new puzzles, plotted as score vs. cost):
the giants sit high and far right — 50–80% at $10–$200 per task. Our target is the *efficient
corner*: the band around **20–35% at well under $0.50 per task**, where the best budget systems
live today. With the budget dial open (the Spiral running longer, structured search, smart
repair), we aim at the top of that band. We are **not** claiming the giants' corner — a 3B model
can't out-think a datacenter, and anyone who tells you otherwise is selling something.

## What we promise — with numbers and confidence

These are design-stage estimates, each tied to something measured. "Confidence" is our honest
probability the claim survives real measurement.

| Promise | How much | Confidence | What it rests on |
|---|---|---|---|
| Cheaper than always calling a big model | **5–10×** on everyday verifiable tasks | **High (~70%)** | already measured 8.3× in one live setting |
| More right answers than one small-model call | **+30–80%** verified solves via try-check-retry | **Medium (~60%)** | standard pass-many math + our real checker |
| When it says "solved," it's actually solved | precision near **100%** | **High (~70%)** | answers must pass held-out tests to count |
| Works fully offline for the common case | — | **Very high (~85%)** | that's the architecture, not a feature flag |
| Doesn't degrade in long sessions | stability guards active | **Medium (~55%)** | proven in our test regime; not yet on the final core |
| Big-model feel in ~2GB (ternary path) | — | **Open bet (~45%)** | published elsewhere; our make-or-break test is queued |

## What it can't do (read this part)

- **Open-ended creative and deep-knowledge work, offline, at frontier quality: no.** Without a
  checker, a small model is just a small model. We escalate or we abstain.
- **Beat the giants at their own leaderboard corner: no.** Different game, deliberately.
- **Everything above is partly aspirational until one number exists:** the full
  try-check-escalate score on a standard 164-problem coding exam at the ≤3B tier, with cost
  counted. It's the first thing we run. If it disappoints, you'll read that here, with the same
  candor as this sentence.

## Where this stands today

Real and running: the Spiral loop with its real execution checker (it has already solved live
task sets cheaply and *honestly reported* the one it couldn't), the honesty probes, the
stability mathematics, and the cascade economics measurements. Being wired now — before any new
training or model shopping: the stability guards onto the default serving path. Decided and
written down: the full design, its six kill-tests, and this document.

The one-line summary of the whole project: **we can't make a small model into a genius, but we
can make it into something rarer — a worker that checks, that improves with budget, that knows
when to ask for help, and that never claims what it can't prove.**

*— unisona.ai / Lantern OS, 2026-07-23. The precise version, with every citation and every
proof status, is the [technical design doc](research/2026-07-23-sigma0-llm-design.md).*
