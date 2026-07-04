docs(desktop): correct the .exe signing strategy — drop Azure, ship MSIX-Store + SignPath (ADR-0014, #1946)

Research (Alex, 2026-07-04) corrected two stale premises the docs still carried:
EV certs stopped granting instant SmartScreen reputation in 2024, so Azure Trusted/
Artifact Signing (paid) buys the same reputation ramp as the free options — dropped.
Cloudflare/Google credits can't sign a Windows exe (different cert type). The
desktop README's "Sign" step and ADR-0014 (Phase-1-package follow-up + a new dated
Update section with evidence rows) now specify the two $0 channels we ship — MSIX
via the Microsoft Store (primary; MS re-signs → no first-launch warning; free
registration) + SignPath Foundation for direct download off unisona.ai (public repo
eligible; "SignPath Foundation" publisher label). Delivery of North Star principle
[12] (local-first ownership); no code change.
