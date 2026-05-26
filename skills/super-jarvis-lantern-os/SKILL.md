---
name: super-jarvis-lantern-os
description: Top-level Super Jarvis Lantern OS skill that routes all Lantern OS convergence, RAG dollhouse memory, COMET LEAP PDFs/art, dual boot, Windows/iPhone/server-farm surfaces, Archive.org/Wayback/OSS/free-media batching, shareholder packets, and v1 readiness work into one local-first operating system. Use when the user asks for one Super Jarvis, one Lantern OS, all skills combined, or aggressive convergence across local repos and public-domain/open-source media.
---

# Super Jarvis Lantern OS

Use this as the top-level router from `C:\tmp\lantern-os`.

## Priority Order

1. Inspect repo state and latest adds.
2. Use `skills/clean-storm-agile/SKILL.md` for lightning sprint execution.
3. Use `skills/bayesian-world-model/SKILL.md` for real-time polled confidence.
4. Run `scripts/Invoke-LanternConvergenceLoop.ps1`.
5. Use `skills/lantern-rag-dollhouse/SKILL.md` for flat memory and literal
   PDF/image assets.
6. Use `skills/comet-leap-agile/SKILL.md` for the master PDF and next agile
   sprint.
7. Use `skills/foundry-shareholder/SKILL.md` for shareholder/repo surfaces.
8. Use `skills/archive-commons-batch/SKILL.md` for Archive.org, Wayback, OSS,
   public-domain, Creative Commons, free music, movies, software, and games.
9. Fix the first 2-4 concrete issues before expanding.
10. Validate, commit, and push.

## Operating Posture

Be aggressive about convergence, but preserve boundaries:

- no destructive disk or bootloader actions;
- no pretending metadata-only repos are locally cloned;
- no pirate media ingestion;
- no cloud token accounting for offline/server-farm Foundry capacity;
- no v1.0.0 release until operator approval.

## Clean Storm

When the operator says "storm", "hammer", "trim the fat", or "lightning",
switch to the 12-step Clean Storm loop:

```text
Status -> Fetch -> Scan -> Sort -> Strike -> Trim -> Tighten -> Validate ->
Re-scan -> Record -> Ship -> Repeat
```

## Memory Spine

Primary flat memory file:

```text
skills/lantern-rag-dollhouse/references/LANTERN-OS-RAG-DOLLHOUSE.flat.md
```

Literal asset bundle:

```text
skills/lantern-rag-dollhouse/assets/
```

## World Model Spine

Belief method:

```text
skills/bayesian-world-model/SKILL.md
```

Durable ledger:

```text
data/world-model/belief-ledger.jsonl
```

## Batch Spine

Archive/Wayback/commons batch script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-ArchiveCommonsBatch.ps1 -Query "subject:\"public domain\"" -MediaType movies -Rows 25
```

Default behavior is metadata-only. Downloading full media requires a deliberate
future expansion with rights checks, rate limits, and storage planning.
