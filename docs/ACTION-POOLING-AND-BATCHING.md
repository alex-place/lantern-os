---
author: Alex Place
created: 2026-05-27
updated: 2026-06-20
---

# Action Pooling and Action Batching

Status: candidate operating method
Date: 2026-05-27

## Purpose

Use action pooling and action batching to turn many scattered asks into safe, repeatable work packets that can run in parallel without hiding risk.

This method is for legal asset growth, hardware expansion, local-model migration, and CI/CD throughput. It does not authorize fake accounts, CAPTCHA bypass, payment abuse, scraping against site rules, spam, or destructive local actions.

## Definitions

Action pooling means collecting similar operator requests into one normalized queue so they can share discovery, validation, and rollback logic.

Action batching means executing independent, low-risk actions together after they are classified. Read-only searches, file scans, tests, link checks, and manifest validation can batch. Purchases, account actions, hardware mutation, payment actions, boot changes, and public publication do not batch automatically.

## Typed Intent Triggers

Remote search should happen from typed natural-language intent, not from secret trigger strings.

Run remote search when the operator types a request that needs freshness, external validation, available grants, current hardware offers, current docs, URLs, unknown terms, prices, schedules, public programs, or legal source checks.

Do not require magic words such as `!search`, `!perfect`, or hidden codes for ordinary remote research. These words can still select a report style, but they must not be the only route to current evidence.

## Pool Lanes

| Lane | Examples | Safe batch action | Held boundary |
|---|---|---|---|
| Repo scan | workflows, tests, reports, manifests | parallel read and validation | destructive cleanup |
| Remote research | docs, grants, legal asset sources, current specs | parallel search/fetch with citations | account actions or ToS evasion |
| Free/legal assets | public domain, CC, open-source, donated media, published free programs | metadata-first intake and rights review | downloads without rights decision |
| Hardware expansion | donated PCs, free local listings, grants, dev kits, recycling streams | inventory, shortlist, honest outreach draft | purchase, pickup, payment, identity verification |
| Local model migration | CPU/GPU/RAM inventory, model fit, quantized weights, local runtime | compatibility matrix and smoke tests | unverified model license or secret/token storage |
| CI/CD | docs, HTML links, pytest, policy anchors, provenance | independent jobs plus summary gate | release deployment without approval |

## Legal Free Asset Loop

1. Search current legal sources and official program pages.
2. Record source, license, cost, required account, and usage limits.
3. Prefer public domain, CC0, permissive open-source, explicit free tiers, grants, donations, and local give-away listings.
4. Store metadata before downloading bodies or binaries.
5. Add a rights decision before ingestion: `allowed`, `metadata_only`, `needs_review`, or `held`.
6. Convert allowed assets into repo manifests, local cache entries, or build inputs.
7. Re-run validation.

## Hardware Expansion Loop

1. Inventory current local machines and bottlenecks.
2. Define the next smallest hardware need: RAM, storage, GPU, mini PC, router, UPS, monitor, cable, sensor, or server shelf.
3. Search legal free/low-cost paths: donations, recycling centers, local free listings, surplus programs, maker spaces, grants, school/community reuse, manufacturer developer programs, and friends/family offers.
4. Draft honest outreach. No fake identities, fake need, spam, or account evasion.
5. Treat pickup, payment, warranty, and identity checks as operator-held.
6. On receipt, record serial/specs locally, wipe storage where appropriate, run hardware smoke tests, and add rollback/recovery notes.

## CAPTCHA and Account Boundary

Human-in-the-loop CAPTCHA completion is allowed only for normal manual use where the site permits it. Do not automate CAPTCHA solving, do not route CAPTCHA farms, do not bypass access controls, and do not create fake or duplicate accounts.

## Local Model Migration Loop

1. Inventory CPU, RAM, GPU, VRAM, disk, OS, and local runtimes.
2. Choose the smallest useful open/local model for the task.
3. Verify model license and source.
4. Download only from trusted official or model-host sources.
5. Run a local smoke test and record latency, memory, context size, and failure modes.
6. Connect through a local-first bridge only after MCP/tool exposure is inspected.
7. Keep GPT/cloud as fallback until local quality and reliability meet the actual workflow requirement.

## CI/CD Upgrade Rule

Parallelize independent checks, but keep a final summary gate. The summary gate must fail if any lane fails. This gives streaming feedback without pretending a partial pass is a full pass.
