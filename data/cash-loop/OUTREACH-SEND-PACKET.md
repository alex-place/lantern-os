# Outreach Send Packet

Generated: 2026-05-26.

Status: ready for operator send.

Purpose: convert the cash sprint from draft-only into executable outreach
without inventing new offers.

## Existing Offers Only

1. Local RAG / Repo Cleanup Sprint: `$199-$999`.
2. COMET LEAP Founder Report Pack: `$99-$299`.
3. Parent / Homeschool Creative Learning Packet: `$49-$149`.
4. Windows / Lantern Setup Session: `$99-$299`.
5. Small-Business AI Cleanup and Training Session: `$199-$750`.

## Primary Send

Use this first for warm builders, founders, consultants, and small-business
owners:

```text
I have 2 paid pilot slots open this week.

I can take one messy folder, repo, PDF set, or AI/tool stack and turn it into a
clean before/after packet:

- source inventory
- RAG-ready flat file
- claim/evidence index
- blockers and next actions
- short PDF/report if useful

Entry pilot is $199. Want me to run one small before/after on a project?
```

## Parent / School Send

Use this for parent, teacher, homeschool, and school-adjacent leads:

```text
I built a printable art/math/music learning packet style that turns visual
work into a warm K-12 explanation teachers and parents can understand.

I am doing a few small custom packets for $49-$149.

Want me to turn one set of images or ideas into a clean school/family packet?
```

## Founder Report Send

Use this for founders and indie builders:

```text
I built a local-first COMET LEAP report pack that turns scattered docs, repos,
PDFs, and decisions into a concise operator/shareholder packet.

I am doing a few pilot report packs at $99-$299.

Want me to run one project through it and send a before/after?
```

## Recording Rule

After each send or response, append a factual event with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Add-WalletLedgerEvent.ps1 -Event outreach_sent -Status sent -Evidence "Sent warm message to lead label only; no private details in Git."
```

If someone says yes, send:

```text
data/wallet/invoices/INV-COMET-LEAP-RAG-001.md
```

Do not record cleared cash until funds clear.
