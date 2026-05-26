# ADS Architecture Review v0.1

Generated: 2026-05-26.

Repo: `https://github.com/alex-place/lantern-os`

Status: current architecture review for Lantern OS after whitepaper, RAG
dollhouse, local wallet, dual-boot workforward, and COMET LEAP cash sprint.

## Definition

ADS means `Architecture Decision System` for this repo.

It is the operating layer that decides:

- what gets promoted;
- what stays held;
- what becomes a skill;
- what becomes a PDF/report;
- what becomes a cash offer;
- what is unsafe, speculative, or not yet validated.

## Executive Finding

Lantern OS is now a coherent local-first control plane, not a skeleton.

The architecture is strong enough for:

- shareholder/operator review;
- RAG-backed memory;
- printable whitepaper distribution;
- manual cash sprint execution;
- dual-boot preparation;
- school/art packet sharing;
- local wallet and invoice tracking.

It is not yet v1.0.0 because the following remain held or operator-action
dependent:

- no operator approval for v1 release;
- dual boot install is now prep-scripted, but partition shrink and installer
  action remain physical operator steps;
- cash sprint is now send-ready, but cleared cash remains `$0` until money
  actually clears;
- orchestrator dirty state was fixed and pushed in `gm-agent-orchestrator`
  commit `f4eb6b5`;
- Archive/Wayback/media lane now has an explicit rights gate; full downloads
  remain held until operator rights/storage review.

## Architecture Map

| Layer | Current Surface | Path | Review |
|---|---|---|---|
| Control Plane | Lantern OS repo | `C:\tmp\lantern-os` | PASS: clean pushed master |
| Memory Plane | RAG Dollhouse | `skills/lantern-rag-dollhouse/` | PASS: flat file plus hashed assets |
| Evidence Plane | manifests and evidence records | `manifests/` | PASS: Bitcoin/Ethereum/governance anchors recorded |
| Decision Plane | Bayesian world model | `data/world-model/belief-ledger.jsonl` | CANDIDATE: ledger exists, needs continuous polling |
| Money Plane | Local wallet and invoice drafts | `data/wallet/` | PASS: factual ledger, no fake revenue |
| Execution Plane | Orchestrator queue | `C:\Users\alexp\Documents\gm-agent-orchestrator` | PASS: dirty health-check fix pushed in `f4eb6b5`; cash task queued |
| Device Plane | Dual boot bundle | `dual-boot/` | CANDIDATE: prep-ready, install held |
| Product Plane | Whitepaper, atlas, cash sprint | `reports/` and `artifacts/` | PASS: printable artifacts exist |
| Learning Plane | Gage school art packet | `school-packets/gage-high-intel-art/` | PASS: packet exists, privacy-aware framing |
| Commons Plane | Archive/Wayback/OSS batch | `scripts/Invoke-ArchiveCommonsBatch.ps1` | CANDIDATE/HOLD: explicit rights gate added; downloads still operator-held |

## Top Decisions

| Decision | Status | Evidence | Reason |
|---|---|---|---|
| Make `lantern-os` the master repo | promote | pushed `master`, clean status | one control plane beats scattered repos |
| Make the RAG dollhouse the memory spine | promote | flat file plus 42 asset manifest rows | gives retrieval a stable body |
| Make the whitepaper canonical | promote | `reports/LANTERN-OS-WHITEPAPER-v0.1.md` and PDF | gives the project one printable thesis |
| Track money in a local wallet first | promote | `data/wallet/local-cash-wallet.json` | avoids fake revenue and premature payment plumbing |
| Execute existing offers only | promote | 11-day cash sprint and wallet rules | stops offer sprawl |
| Treat current PC dual boot as prep-ready only | promote/hold | readiness JSON: `readyForPrep=true`, `readyForInstall=false` | no unallocated install space yet |
| Treat iPhone/phones as edge nodes first | hold true dual boot | phone boundary manifests | phone boot paths need device-specific review |
| Treat offline/server-farm tokens as unmetered capacity | promote | Lantern consolidate/offline token rule | separates owned compute from cloud billing |
| Keep Archive/Wayback media metadata-first | promote/hold | archive commons policy | rights and storage review required |
| Hold v1.0.0 release | hold | readiness gates | operator approval not yet given |

## Strengths

1. Local-first architecture is now explicit.
2. RAG memory has a single flat canonical file.
3. Assets are copied intentionally and hashed.
4. Whitepaper exists in Markdown and PDF.
5. Cash sprint has an invoice and wallet ledger without fake balance.
6. Dual boot has clear readiness evidence and a safe physical boundary.
7. Skills now route repeatable work instead of relying on chat memory.
8. Governance is modeled as evidence-backed offchain review, not one-shot
   impulse.

## Risks

| Risk | Severity | Current Control | Next Fix |
|---|---:|---|---|
| Physical disk mutation during dual boot | high | hard boundary in docs/scripts | operator-only Disk Management step |
| Fake revenue or blurred wallet state | high | cleared cash remains `$0` | record sent/paid events only when real |
| Repo sprawl returning | medium | master repo and RAG flat file | update dollhouse after every sprint |
| Orchestrator dirty state | resolved | committed and pushed `f4eb6b5` | keep supervisor health checks responsive |
| External media rights | medium | metadata-first commons lane plus rights gate | operator verifies rights before downloads |
| Whitepaper overclaiming | medium | v0.1 draft status and boundaries | revise after first cash result |
| V1 release too early | high | release gate hold | operator says promote only after gates pass |

## ADS Gate Review

| Gate | Status | Evidence | Action |
|---|---|---|---|
| Repo Cleanliness | pass | `master...origin/master`, no local changes before this review | keep small commits |
| RAG Integrity | pass | 42 copied assets, SHA manifest rebuilt | rehash after any asset add |
| Whitepaper | pass | Markdown and PDF built | use as canonical public artifact |
| Wallet | pass | local wallet JSON and JSONL parse | record only factual events |
| Cash Sprint | candidate/send-ready | P0 orch task queued, send packet and invoice draft exist | send/record 5 warm messages |
| Dual Boot Prep | candidate | prep-ready, no failures | run elevated and shrink D: manually |
| Dual Boot Install | held | 0 GB unallocated space | operator physical action |
| Commons Batch | candidate/held-downloads | metadata script and rights gate exist | downloads need operator rights/storage review |
| v1.0.0 | held | operator approval missing | no release/tag yet |

## Current Dual Boot ADS Finding

The machine is not blocked by capability. It is blocked by prepared space.

```text
readyForPrep:    true
readyForInstall: false
primary blocker: 0.0 GB unallocated install space
D: free:         1636.9 GB of 1863.0 GB
```

ADS decision: promote preparation, hold installation. Preparation is now
scripted by `dual-boot/Start-DualBootPrep.ps1`.

Next physical step:

```text
Run elevated readiness -> backup/recovery keys -> shrink D: 100-250GB -> leave unallocated -> rerun readiness.
```

## Current Wallet ADS Finding

The wallet architecture is correct for now because it prevents fantasy money.

```text
clearedCashUsd:    0
pendingInvoiceUsd: 199
firstInvoice:      INV-COMET-LEAP-RAG-001
```

ADS decision: promote local ledger and send packet, hold payment-provider
integration until a real buyer needs a real payment path.

Send-ready packet:

```text
data/cash-loop/OUTREACH-SEND-PACKET.md
```

Wallet event logger:

```text
scripts/Add-WalletLedgerEvent.ps1
```

## Current RAG ADS Finding

The RAG house is the correct memory spine because it makes every major artifact
findable from one file.

Current anchor:

```text
skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md
```

ADS decision: promote. Every future sprint should update the flat file and
asset manifest before pushing.

## Immediate Next Actions

1. Print or share `artifacts/LANTERN-OS-WHITEPAPER-v0.1.pdf`.
2. Execute the P0 orchestrator cash-loop task.
3. Record 5 outreach attempts or 5 explicit contact blockers.
4. If one buyer says yes, send the $199 RAG cleanup invoice draft.
5. Run elevated dual-boot readiness.
6. Shrink D: manually by 100-250GB only after backup/key checks.
7. Rerun readiness and save the result.
8. Update this ADS review after the first cash outcome or dual-boot prep change.

## Blocker Fix Pass

The operator-requested blocker fix pass created:

- `dual-boot/Start-DualBootPrep.ps1`;
- `data/cash-loop/OUTREACH-SEND-PACKET.md`;
- `scripts/Add-WalletLedgerEvent.ps1`;
- `data/archive-commons/RIGHTS-REVIEW-GATE.md`;
- `manifests/BLOCKER-FIX-2026-05-26.md`;
- orchestrator fix commit `f4eb6b5`.

## Architecture Verdict

Lantern OS is architecturally converged enough to operate.

It is not release-final, but it is now action-ready:

```text
ship whitepaper -> run cash sprint -> record wallet events -> prepare dual boot -> update RAG house -> repeat
```
