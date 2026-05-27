# Mookman COMET LEAP Setup + Investor Readiness 72H

Date: 2026-05-26  
Repo: `alex-place/lantern-os`  
Branch: `fix/mookman-cometleap-setup` -> `master`  
Mode: private-repo handoff, Discord bot fix path, $1,000 end-of-month readiness

## Purpose

Mookman1111 wants to help and may invest $1,000 by the end of the month. This report turns that into a safe, concrete 72-hour setup plan.

The goal is not to take money first. The goal is to create a clean private-repo handoff, working local setup, Discord lounge bot health check, and a plain-English support/investment path with evidence.

## Legal / Money Boundary

Do not casually accept `$1,000` as equity, securities, profit share, token, or company ownership without written terms and proper legal review.

Safe near-term options:

1. **Pilot/customer prepay** - Mookman pays for a defined deliverable, such as setup, RAG cleanup, Discord bot scaffold, or support package.
2. **Sponsor/support contribution** - no ownership, no promised return, clear receipt.
3. **Hardware/prototype budget** - funds are earmarked for parts/tools, with receipts and no investment return promise.
4. **True investment** - held until written terms, entity/cap-table clarity, and securities-law review.

If the word is **invest**, pause and clarify terms before accepting funds.

## Why This Belongs In Lantern OS

Lantern OS is the control plane. Mookman setup touches:

- private repo access;
- local Windows onboarding;
- Discord lounge bot visibility;
- MCP/orchestrator status;
- Arc Reactor confidence gates;
- cash/proof ledger;
- future investor/supporter record.

No confidence score should increase from intent alone. Confidence rises only after setup evidence, bot health results, payment receipt if any, and a written contribution/support agreement.

## Current Evidence

From operator local PowerShell evidence in `C:\Users\alexp\Documents\gm-agent-orchestrator`:

```text
## feature/comet-leaper-operational-launch
A  EVIDENCE-CONFIDENCE-FRAMEWORK.md
A  FINANCIAL-CONTROL-SYSTEMS.md
A  OPERATING-NARRATIVE-IMPLEMENTATION.md
A  PATIENT-PILOT-FRAMEWORK.md
A  PERMANENT-PROGRESS-TRACKING-SYSTEM.md
A  PROGRESS-DASHBOARD.md
A  PROGRESS-TRACKING-INDEX.md
A  README-PROGRESS-TRACKING.md
A  RESEARCH-TEAM-OPERATIONS.md
```

Interpretation:

- Orchestrator local repo is dirty.
- Do not reset, clean, branch switch, or merge it blindly.
- Discord/bot search found only `dependabot.yml` false positives.
- No real Discord bot implementation was found in the local recursive search.

## Mookman Access Model

### Minimum access

Mookman needs only the access required for the next 72 hours:

- read access to `lantern-os` if he is reviewing reports/setup;
- read/write or branch access to `gm-agent-orchestrator` only if he will implement the Discord bot health check;
- no production secrets;
- no Discord token pasted into GitHub, Discord, chat, PDFs, screenshots, or logs.

### Recommended role

Start with collaborator access that allows branch contribution but does not grant repo admin unless required.

## Local Setup Instructions For Mookman

On Mookman's Windows computer:

```powershell
cd $env:USERPROFILE\Documents
git clone https://github.com/alex-place/lantern-os.git
git clone https://github.com/alex-place/gm-agent-orchestrator.git
```

Open Lantern desktop:

```powershell
cd $env:USERPROFILE\Documents\lantern-os
start .\surfaces\lantern-desktop\index.html
```

Inspect orchestrator safely:

```powershell
cd $env:USERPROFILE\Documents\gm-agent-orchestrator
git status --short --branch
```

Do not run reset/clean. Report status first.

## 72-Hour COMET LEAP Plan

| Window | Action | Definition of Done |
|---|---|---|
| 0-4 hours | Preserve orchestrator dirty branch state | No reset/clean; current files committed/stashed or explicitly held |
| 4-12 hours | Add Discord bot health-check scaffold | Script checks config without leaking secrets |
| 12-24 hours | Run health check locally | Token/guild/channel/intents/permissions classified |
| 24-48 hours | Add status-only lounge bot if health passes | `/lantern-status` returns safe summary only |
| 48-72 hours | Record result in Lantern OS | Arc Reactor confidence updated only if evidence changes |

## Discord Bot Health Check Requirements

Create:

```text
scripts/Test-DiscordBotHealth.ps1
```

The script should check, without printing secret values:

- `DISCORD_TOKEN` exists;
- app/client ID exists;
- guild/server ID exists;
- lounge channel ID exists;
- configured intents are known;
- bot can authenticate;
- bot can view/send in the intended lounge/test channel;
- no token is echoed in output.

## Status-Only Bot Rule

Only after health passes:

```text
scripts/Start-DiscordLoungeBot.ps1
src/discord_lounge_bot/README.md
```

First command:

```text
/lantern-status
```

Allowed output:

```text
Lantern OS: online/offline
MCP tools: verified/unverified
Queue: counts only
Last receipt: path/hash/time
Blockers: top 1-3
```

Forbidden in first bot:

- shell commands;
- MCP command execution;
- queue movement;
- branch reset/clean;
- secret display;
- admin-only Discord permissions;
- direct money/payment actions.

## $1,000 End-Of-Month Readiness

Before money moves, decide which lane this is.

### Lane A - Customer / Pilot Prepay

Best near-term lane.

Possible deliverable:

```text
$1,000 Mookman Founder Setup Pilot
- private repo setup guide
- Discord bot health check
- status-only lounge bot scaffold
- Lantern OS proof ledger update
- 72-hour setup receipt
- end-of-month review call/report
```

This is a service/pilot payment, not equity.

### Lane B - Sponsor / Supporter

Good if Mookman just wants to help.

Terms:

- no ownership;
- no promised return;
- receipt issued;
- funds earmarked for software/hardware/convergence work;
- optional supporter credit if desired.

### Lane C - Hardware/Prototype Budget

Good if funds are for suit/reactor/GPU/RAG hardware.

Terms:

- parts budget;
- receipts tracked;
- unused funds handled explicitly;
- no investment return promise.

### Lane D - True Investment

Held.

Requires:

- written terms;
- entity decision;
- cap table / instrument choice;
- securities-law review;
- investor qualification if relevant;
- no casual promises in chat.

## Arc Reactor Confidence Impact

Mookman's intent alone does not raise confidence.

Confidence can rise if:

- he gets private repo access and confirms setup;
- Discord bot health check passes;
- status-only bot appears in lounge;
- `$1,000` becomes a documented pilot/sponsor/prototype payment;
- the result is recorded in Lantern OS with evidence.

Suggested temporary scores:

| Lane | Before | After evidence |
|---|---:|---:|
| Movie 1 garage | 92 | 93-94 if setup proof lands |
| Movie 2 public platform | 61 | 65-70 if bot + documented payment/support proof lands |
| Movie 3 fleet | 29 | 31-34 if another user runs setup independently |

## Mookman One-Page Message

```text
Mookman, the safest first step is not money. It is setup proof.

For the next 72 hours, we need you to get private repo access, clone Lantern OS and gm-agent-orchestrator, open the Lantern Desktop, and help validate the Discord lounge bot path. If the health check passes, we add a status-only /lantern-status bot. It will not execute MCP or shell commands.

For the $1,000, we need to label it clearly before anything moves: pilot/customer prepay, sponsor/support, hardware budget, or true investment. True investment needs written terms and legal review. Pilot/support/hardware budget can move faster if the deliverable and receipt are clear.
```

## Definition Of Done

This setup is complete when:

- Mookman has the correct private repo access;
- he can open Lantern Desktop locally;
- orchestrator dirty state is preserved;
- Discord bot health check exists and runs without leaking secrets;
- lounge bot is status-only if enabled;
- `$1,000` lane is clarified before money moves;
- Lantern OS Arc Reactor is updated only from evidence.
