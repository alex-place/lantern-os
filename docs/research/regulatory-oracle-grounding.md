# Grounding the Convergence IO oracle in real cross-border regulation

**Status: VALIDATED (2026-06-25) via the deep-research harness.** 25 extracted claims went
through 3-vote adversarial verification against primary/official sources — **24 confirmed
(unanimous 3-0), 1 refuted** (an overreach, narrowed below). Every surviving finding rests
on a `.gov` / EU-regulator / eCFR / official source. Honest confidence gradient per
primitive below; nothing here is asserted beyond what a primary source supports.

> **Why this doc exists.** The [Convergence IO stack](../convergence-io/README.md) (DCF, NAP,
> AAPF, PCSF, CCF — principles P1–P10) is a *Regulatory Primitive Stack*. The grounded
> [Question Loop](question-machine.md) needs its **oracle** to ground in *real external
> truth*, not toy scalars. The strongest external truth for a governance stack is
> **existing, in-force regulation**. This validates which primitives map to real law, how
> they differ across borders, and which authoritative machine-readable feeds can keep the
> oracle live.

---

## TL;DR — the grounding is real, but the strength varies sharply

| Primitive | Maps to | Confidence | Live machine-readable feed |
|---|---|---|---|
| **NAP** (P2, denials) | OFAC blocking law (31 CFR `.201`) + Enforcement Guidelines (31 CFR 501 App A) | **SOLID** — near-literal | **OFAC Sanctions List Service** (XML/CSV/ASDM + delta); OpenSanctions (consolidated cross-border) |
| **PCSF** (P4, provider capacity) | EU **DORA** (applic. 17 Jan 2025) + UK **CTP** regime (1 Jan 2025) | **SOLID** for concentration/exit; **softer** for runtime failover | EUR-Lex (DORA text); regulator registers |
| **AAPF** (P3, provenance) | 21 CFR Part 11 §11.10(e); SEC 17a-4 (2022); GDPR Art 30; EU AI Act Art 12 | **SOLID** | EUR-Lex / eCFR full text |
| **CCF** (P4, capability claim) | US software supply-chain attestation (CISA form, EO 14028, NIST SSDF) | **REASONABLE — but currency risk** | CISA form; NIST SSDF |
| **DCF** (P1, data classification) | *(no verified regulatory anchor for "label propagates through transformations")* | **STRETCH / aspirational** | — |

**The headline for your thesis:** the primitive you emphasized — **NAP, "a denial overrides
any capability claim" — is the *most* solidly grounded of all five, near-literally.** And it
has the cleanest live feed. The oracle's strongest leg is exactly the denial leg.

---

## Per-primitive validation

### NAP (P2) — "denial overrides capability" — **SOLID, near-literal** ✅

US sanctions law is **civil strict-liability**: a prohibition stands *regardless of the
actor's intent, capability, or justification*. OFAC's Economic Sanctions Enforcement
Guidelines (31 CFR Part 501, App A) list "Willful or Reckless Violation" (Factor A) and
"Awareness of Conduct" (Factor B) as determinants of the **enforcement response / penalty**,
**not elements of a violation** — OFAC "does not need to prove fault or intent to enter an
enforcement action." (Criminal IEEPA prosecution still requires willfulness; the civil
strict-liability scoping is exact.)

The "**denial overrides capability *unless* an authorization/license exists**" structure is
the literal shape of the blocking prohibition: 31 CFR `594.201(a)` (and parallel `.201`
sections across parts 544/560/590…) — blocked property "**may not be transferred, paid,
exported, withdrawn or otherwise dealt in**" "**Except as authorized by … licenses or
otherwise.**" *Cite the program `.201` prohibition, not App A (App A is the penalties
framework; the verifier flagged this).*

- **Cross-border:** OFAC (US) is one of several. EU consolidated list, UN Security Council
  list, UK OFSI, and US BIS Entity List/EAR are parallel denial regimes (these non-US sources
  were *not independently verified here* — treat as well-established but unconfirmed in this
  evidence set). The 2024 BIS rule making an SDN designation auto-trigger EAR license
  requirements (no license exceptions) is the same "denial propagates, can't be overridden"
  pattern — extracted but pending verification.
- **Actionable goals:** (1) screen every counterparty/destination against the consolidated
  deny-list before any action; (2) treat a hit as a hard block that no capability/role can
  override; (3) record the license/authorization id when an action *is* permitted.
- **Sources:** [eCFR 31 CFR 501 App A](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-V/part-501/appendix-Appendix%20A%20to%20Part%20501), [Cornell LII](https://www.law.cornell.edu/cfr/text/31/appendix-A_to_part_501). Vote 3-0.

### PCSF (P4) — **SOLID for concentration/exit; softer for runtime failover** ✅⚠️

- **EU DORA** (Regulation (EU) 2022/2554) — in force 16 Jan 2023, **applicable 17 Jan 2025**.
  Establishes an EU-wide oversight framework directly supervising **critical ICT third-party
  providers**; explicitly targets **systemic/concentration risk** from reliance on a few ICT
  providers. Arts 31–44 give a per-provider Lead Overseer (EBA/ESMA/EIOPA) with inspection
  powers and penalties up to 1% of worldwide daily turnover. **First 19 CTPPs designated
  Nov 2025** (AWS/Azure/GCP, Bloomberg, LSEG) — the concentration concern is operational.
- **UK Critical Third Parties (CTP)** — PS24/16 (FCA) + PS16/24 (PRA/BoE), 12 Nov 2024,
  **in force 1 Jan 2025**, authority from FSMA 2023 (s.312L). Eight Operational Risk &
  Resilience Requirements (incl. R3 dependency/supply-chain, R8 termination) + six Fundamental
  Rules. Firm-level bite is **designation-gated** (HM Treasury designates; 12-month window).
- **Honest stretch flag:** PCSF's runtime **"circuit breaker / fallback chain / per-tier
  quota"** is only *analogical* to DORA/CTP **exit-strategy & substitutability** — the
  regulatory concern is concentration/resilience/exit, **not live runtime failover**. The
  *concentration* mapping is direct; the *runtime* mapping is softer.
- **Actionable goals:** (1) maintain a per-provider register of ICT dependencies for
  critical functions (DORA Art 28(3)); (2) maintain a documented exit/substitution plan per
  critical provider; (3) annual severe-but-plausible scenario test (UK CTP).
- **Sources:** [EIOPA DORA](https://www.eiopa.europa.eu/digital-operational-resilience-act-dora_en), [EBA DORA oversight](https://www.eba.europa.eu/activities/direct-supervision-and-oversight/digital-operational-resilience-act/dora-oversight), [FCA PS24/16](https://www.fca.org.uk/publications/policy-statements/ps24-16-operational-resilience-critical-third-parties-uk-financial-sector), [BoE PS16/24](https://www.bankofengland.co.uk/prudential-regulation/publication/2024/november/operational-resilience-critical-third-parties-to-the-uk-financial-sector-policy-statement). Votes 3-0.

### AAPF (P3) — append-only provenance — **SOLID** ✅

Four independent, in-force anchors, all 3-0:
- **21 CFR Part 11 §11.10(e)** (FDA): "secure, computer-generated, time-stamped audit trails
  … Record changes shall not obscure previously recorded information … retained … at least as
  long as … the subject electronic records … available for agency review." Maps 1:1 to
  append-only/timestamped/reviewable provenance. *Nuance:* the text mandates **non-obscuring
  of history**, which is slightly weaker than "immutable/no-delete" — the primitive's framing
  captures intent but is marginally stronger than the letter.
- **SEC Rule 17a-4 (2022 amendment)** — retains **WORM** *or* a new **audit-trail alternative**
  (all modifications/deletions, create/modify/delete timestamps, actor identity, enough to
  re-create the original). Compliance date 3 May 2023, in force.
- **GDPR Art 30** — records of processing: a specific, enumerable field set (purposes,
  categories of data/recipients, transfers + safeguards, retention, security measures). UK
  GDPR retains it unchanged.
- **EU AI Act Art 12** — **purpose-bound traceability** (not "lifetime logging" — see refuted),
  with a prescribed minimum log field set for Annex III(1)(a) biometric systems.
- **Sources:** [eCFR Part 11](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11), [SEC 17a-4](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers), [ICO Art 30](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/documentation/what-do-we-need-to-document-under-article-30-of-the-gdpr/), [AI Act Art 12](https://artificialintelligenceact.eu/article/12/).

### CCF (P4) — capability claim / attestation — **REASONABLE, but time-sensitive** ⚠️

Maps to the US software supply-chain attestation regime: **CISA Secure Software Development
Attestation Form** (released 11 Mar 2024), grounded in **EO 14028 → OMB M-22-18 / M-23-16 →
NIST SSDF (SP 800-218)**. Producers of federal-government software must *attest* (prove a
claimed secure-development capability) or file a POA&M — the "prove capability at action time,
honesty floor" shape, near-literally.

> **CURRENCY RISK (critical, flagged by the verifier):** **OMB rescinded M-22-18 and M-23-16
> on 23 Jan 2026** in favor of a risk-based approach. The historical/structural grounding is
> accurate, but **the underlying mandate is no longer in force** as of the 2026-06-25 research
> date. An oracle MUST track this — it's the live example of why regulatory grounding has to
> be *polled*, not memorized.

- **Sources:** [CISA attestation form](https://www.cisa.gov/secure-software-attestation-form), [NIST EO 14028 SSDF](https://www.nist.gov/itl/executive-order-14028-improving-nations-cybersecurity/software-supply-chain-security-guidance). Vote 3-0 (with the currency caveat).

### DCF (P1) — data classification — **STRETCH / aspirational** ❌ (unverified)

**No surviving verified claim grounds DCF.** Specifically, the "**label propagates through
transformations**" concept has **no regulatory anchor** in this evidence set. Regimes that
require classifying data *at rest* exist (GDPR Art 9 special-category, ISO/IEC 27002:2022
control 5.12, NIST SP 800-60 / FIPS 199), but a mandate for a *propagating, machine-readable
label that survives transformations* was not substantiated. This is the weakest mapping —
honestly aspirational, not yet grounded. (Open question below.)

---

## The live oracle feeds — what keeps it current

The meta-question — *can a cross-border oracle stay live?* — is **YES for the denial and
EU-law layers**, because authoritative machine-readable feeds exist (verified 3-0):

- **OFAC Sanctions List Service (SLS)** — launched 6 May 2024, `sanctionslist.ofac.treas.gov`.
  SDN + Consolidated lists in XML/CSV/fixed-field, the UN/Wolfsberg **Advanced Sanctions Data
  Model** (XML), **plus a delta file** for incremental updates. → grounds **NAP**.
- **OpenSanctions** (`data.opensanctions.org`) — *I verified this live separately:* a
  **consolidated** feed (OFAC + EU + UN + UK + more), **~100k entities, updated daily,
  keyless**. The single best cross-border NAP oracle.
- **EUR-Lex** — a SOAP web service (XML metadata/search) + the **Cellar RESTful API**
  (full-text retrieval by UUID). → grounds **DORA, GDPR, AI Act** text. *(Note: a
  10,000-results-per-search cap takes effect 1 Jan 2026 — a bulk-ingestion tweak.)*

**Feasibility verdict:** keeping the oracle *current* is feasible for NAP + EU-law (real
feeds). Decomposing statute into machine-actionable *goals* is still partly **human-in-the-loop**
rule-authoring — no regulator yet ships a structured "obligations" dataset rich enough to
auto-decompose (open question).

---

## What was refuted, and what's still open

**Refuted (1, vote 1-2):** *"AI Act Art 12 mandates automatic **lifetime** logging."* — Overreach.
Art 12 requires **purpose-bound traceability** + a prescribed minimum field set, not unbounded
lifetime logging. The primitive holds; the maximalist framing does not. **This is the
discipline working** — the verifier killed the one claim that overstated.

**Open questions (carry-forward):**
1. Can **DCF** be grounded at all? Does any in-force regime mandate a *propagating* label
   (vs. classify-at-rest), and is it exposed as a schema an oracle could ingest (ISO catalog,
   NIST **OSCAL**)?
2. **NAP cross-border completeness:** do the EU FSF / UN / UK OFSI / BIS feeds reconcile with
   OFAC's ASDM identifier scheme cleanly enough for a unified deny-list without false matches?
3. Given the **OMB rescission**, what's the new in-force basis for **CCF** attestation?
4. Is the **decompose-to-machine-actionable-goals** step automatable, or fundamentally manual?

---

## Wiring it — the `RegulationChannel` oracle

This converts directly into a grounding channel for the [Question Loop](question-machine.md),
exactly like the flourishing `WebChannel`:

- **`SanctionsChannel`** (NAP) — polls OpenSanctions / OFAC SLS; resolves "is this entity
  denied?" with a hard block + source. The *highest-confidence* oracle leg.
- **`EurLexChannel`** (DORA/GDPR/AI Act) — Cellar API by CELEX id; grounds AAPF/PCSF/CCF
  obligations in current statute text + its `last-modified` date (catches rescissions like
  OMB's).
- **CAP/NAP gating still applies:** the regulation oracle *informs* the deny-list; the existing
  `AuthorityGate` *enforces* it. Denial overrides capability — now grounded in the real
  31 CFR `.201` structure it was always modeling.

---

## Methodology + honesty note

Run by the deep-research harness: 6 angles → 30 sources fetched → 146 claims extracted → top
25 verified by **3 independent adversarial voters (2-of-3 refutes to kill)** → 24 confirmed,
1 killed → 12 synthesized findings. **First run reported "all 25 refuted" — but that was a
rate-limit artifact** (the verifier hit the account session limit and every vote came back
`0-0`/abstain, which defaulted to "refuted"). That false "all refuted" is itself a textbook
ungrounded-collapse failure: a system reporting confident verdicts while actually blind. The
**resume** (after the limit reset) re-ran only the verify stage and produced the real 24/25.
The lesson is the certificate's: *trust the verdict only when the verifier actually ran.*

*Source of record: deep-research run `wf_70e7797a-28e`, 2026-06-25. All findings 3-0 unanimous
on primary sources; cross-border completeness and DCF remain the honest gaps.*
