# Public Puzzle And Math Bounty Radar - 2026-05-30

Status: public-source bounty radar for Lantern `!one`; no live trading, no
account action, no prize claim, and no proof claim.

Purpose: rank public puzzle/math bounty lanes that Lantern can attack in a
novel but bounded fashion: local solver loops, RAG-compressed strategy cards,
Lean/checkable proof gates, and human review before public submission.

## Source Receipts

| Source | Current public signal | URL |
|---|---|---|
| ARC Prize 2026 overview | `$2M` total across three tracks; submissions due `2026-11-02`, papers due `2026-11-08`, results `2026-12-04`; open-source solutions required for prize eligibility. | https://arcprize.org/competitions/2026 |
| ARC-AGI-3 | `$850K` total; interactive agents in novel environments; top-score and milestone awards; no internet during evaluation. | https://arcprize.org/competitions/2026/arc-agi-3 |
| ARC-AGI-2 | `$700K` total; static reasoning tasks; target is `85%` private accuracy inside Kaggle limits; no internet during evaluation. | https://arcprize.org/competitions/2026/arc-agi-2 |
| ARC Paper Prize | `$450K` total for conceptual progress tied to a Kaggle code submission; rubric values universality, theory, completeness, and novelty. | https://arcprize.org/competitions/2026/paper |
| Clay Millennium Prize Problems | `$1M` allocated per problem; six remain unsolved after Poincare. | https://www.claymath.org/millennium-problems/ |
| AMS Beal Prize | `$1M` held by AMS for a proof or counterexample published in a refereed and respected math publication. | https://www.jointmathematicsmeetings.org/prizes-awards/paview.cgi?parent_id=41 |
| ICML 2026 AI for Math / TCS Proving | `$8K` across tracks; Lean 4 / CSLib theorem proving, deadline `2026-06-15` AoE. | https://www.codabench.org/competitions/16161/ |

## Ranked Collection Lanes

| Rank | Lane | Prize ceiling | Lantern fit | Collection status |
|---:|---|---:|---|---|
| 1 | ARC-AGI-3 interactive agent | `$850K` | Best match for Lantern's local agent/world-model loop: explore, model, plan, act. | Open research lane; build local simulator and reproducible Kaggle agent. |
| 2 | ARC Paper Prize paired with ARC-AGI-3/2 | `$450K` | Best near-term publication lane: document a novel solver architecture even before top leaderboard score. | Prepare methods paper only after a real code submission exists. |
| 3 | ARC-AGI-2 static puzzle solver | `$700K` | Good fit for RAG-compressed puzzle transforms, program search, and two-answer output. | Build offline notebook; no API calls at evaluation time. |
| 4 | ICML AI for Math / TCS Proving | `$8K` | Low-payout but high-validation Lean lane; good for proof-kernel discipline and fast feedback. | Urgent if pursued; deadline is close. |
| 5 | Beal Prize | `$1M` | Long-horizon symbolic search and formalization sandbox only. | No cash sprint; requires serious published proof/counterexample. |
| 6 | Clay Millennium problems | `$1M` each | Long-horizon research moonshot; use as verifier benchmark, not revenue plan. | No collection claim without peer-reviewed breakthrough. |

## Novel Lantern Attack Shape

1. Build one offline ARC workbench: task loader, visual transform DSL, hypothesis
   search, self-play perturbations, and two-output submission writer.
2. Route ARC-AGI-3 through a small agent stack: curiosity policy, map memory,
   action replay, failure compression, and deterministic seed receipts.
3. Route math bounties through proof gates: natural-language conjecture card,
   Lean/proof assistant scratch, verifier log, and expert-review hold.
4. Keep all bounty work public-safe: no copied book text, no hidden benchmark
   leakage, no private solution dumping, and no prize claim before official
   acceptance.
5. Use game-theory/wargame reader data as a strategy reference only: allocate
   compute to bounded experiments, stop losing branches early, and preserve
   reproducibility.

## Best Immediate Objective

Build the ARC-AGI-3/ARC Paper Prize starter lane first. It has the strongest
fit to Lantern's agent identity, the largest practical near-term public puzzle
pool, and a credible route to a public demo even before a prize win.

Minimum useful next commit:

- add an `arc-bounty-workbench` folder with task-loader stubs;
- add a receipt format for experiment runs;
- add a no-internet evaluation boundary test;
- add a short paper-outline template tied to actual results.

## Boundaries

- This report is not investment, gambling, legal, or prize-submission advice.
- No claim is made that Lantern can win any bounty today.
- Bounty collection requires official contest submission, rules compliance,
  and acceptance by the prize authority.
- Clay/Beal work must be treated as formal research, not a fast cash lane.

## Reader Link

```text
http://127.0.0.1:4177/view?path=manifests/evidence/public-puzzle-math-bounty-radar-2026-05-30.md
```
