---
name: one-world-leader-app
description: "Skill for designing and converging the One World Leader app: a Lantern OS product that compresses global knowledge into ethical leadership, learning, RAG, Bayesian world modeling, public-domain/commons media, science/art/math/game packets, and cashable services. Use when Codex needs to turn the product universe atlas into an app, roadmap, sprint, UI, report, or monetization plan."
---

# One World Leader App

Use this skill from `C:\tmp\lantern-os` when turning Lantern OS into the One
World Leader app.

## North Star

Build a local-first leadership and learning app that compresses world knowledge
into:

- understandable maps;
- evidence-backed decisions;
- art/music/math/science learning packets;
- public-domain and Creative Commons media indexes;
- ethical AI/RAG workflows;
- cashable productized services.

## Required Inputs

Read:

- `reports/LANTERN-PRODUCT-UNIVERSE-ATLAS.md`
- `reports/COMET-LEAP-11-DAY-CASH-SPRINT.md`
- `skills/super-jarvis-lantern-os/SKILL.md`
- `skills/bayesian-world-model/SKILL.md`
- `skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md`
- `skills/archive-commons-batch/SKILL.md`

## App Modules

| Module | Purpose | First Artifact |
|---|---|---|
| World Model | claims, priors, evidence, posteriors | belief ledger |
| Knowledge Atlas | all-domain maps and source anchors | product universe atlas |
| Learning Packets | K-12 to adult explanations | school/art/math packet |
| Commons Library | public-domain/CC/OSS media metadata | archive batch output |
| Product Lab | convert knowledge into offers | 11-day cash sprint |
| Local Wallet | invoices, factual cash events, cleared cash | `data/wallet/local-cash-wallet.json` |
| Local OS | Windows, dual boot, phone, server farm | readiness/inventory |
| Shareholder View | progress, gates, money, risk | front-page reports |

## 12-Step App Convergence

1. Inspect current repo/app state.
2. Poll sources and update beliefs.
3. Select one user persona.
4. Select one knowledge domain.
5. Build one useful packet/tool.
6. Attach evidence and rights state.
7. Price one manual service offer.
8. Draft or send one invoice through the local wallet.
9. Validate with one real user.
10. Record objections, outcomes, and cleared cash only.
11. Trim unused scope and ship the artifact.
12. Feed the result back into the world model.

## Boundaries

- Lead with service and education, not political authority claims.
- Do not claim all knowledge is contained; claim a path to iterative
  compression.
- Respect IP, school privacy, public-media rights, and physical-device safety.
- Keep v1.0.0 release held until explicit operator approval.

## First App Slice

The first slice is not a giant platform. It is:

```text
One World Leader -> Product Atlas -> 11-Day Cash Sprint -> Local Wallet -> One paid packet
```

Build this first, then expand.

## Local Wallet

Use `data/wallet/` to hold invoice drafts and factual cash state. Never record
fake revenue. Draft invoices, sent invoices, objections, and cleared payments
are separate events in `data/wallet/ledger.jsonl`.
