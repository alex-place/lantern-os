# CSF — patent prior-art & freedom-to-operate review

**Date:** 2026-07-22
**Type:** Patent prior-art search + FTO assessment for the CSF compression format.
**Status:** Planning-grade. Not legal advice — an attorney prior-art/FTO review precedes any filing (per [`KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §7).
**Grounding contract:** every patent cited was surfaced by a live search 2026-07-22 and links to its Google Patents / USPTO record; verdicts are tagged **[prior-art]** (technique is covered/anticipated), **[public-domain]** (open standard, no patent), or **[thin novelty]** (a narrow composition sliver, routed to defensive publication not patent).

> **⚠️ On the patent corpus.** The repo's worldwide patent corpus (PR #2826) is a separate lane's infrastructure and is **empty** (harvest gated on an EPO OPS key). This review was done via **live web patent search**, not that corpus — so it stands on its own and can be re-verified from the linked records. When the corpus is populated, a `patent_search` over the same queries should reproduce these hits.

---

## TL;DR

> A patent search on CSF's shipped techniques finds **named prior art or open standards for every one of them** — best-fit codec selection, seed/regeneration storage, byte-shuffle, BCJ filters, and framed random-access archives are all occupied or public-domain. This **confirms and deepens** the IP register's existing honest grade (CSF §4.7: *"LOW novelty — format identity + integrity, not algorithm"*). The genuine deliverable is not a patent — it is **(1) clean freedom-to-operate** (the blocking-looking patents are narrow, packet-header-specific, or expired) and **(2)** one thin composition sliver worth a **defensive-publication timestamp**, not a filing. No CSF compression *mechanism* is patentable; the moat remains systems + owned data, exactly as the register already states.

---

## Technique-by-technique prior art

| CSF technique (shipped) | Closest prior art | Verdict |
|---|---|---|
| **Multi-codec best-fit + self-describing header** (omni: try the panel, keep the smallest, header names the codec) | [US8111704B2](https://patents.google.com/patent/US8111704) *Multiple compression techniques for packetized information* · [US6804238](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6804238) *selects best compression by analyzing compression ratios* · [US5953503A](https://patents.google.com/patent/US5953503) *multiple preset dictionaries; header indicates the scheme used* (filed 1997 — **term-expired**) | **[prior-art]** — "try several, keep smallest, self-describe in the header" is squarely anticipated. Not novel. |
| **Generative members / recompute-as-storage** (store a generator spec + the sha-256 of the materialized bytes; regenerate on read) | [US20040267773A1](https://patents.google.com/patent/US20040267773A1/en) *Generation of repeatable synthetic data — a deterministic generator + seed regenerates any particular entry* (2004 — **term-expired**) · [US11967975](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11967975) *recursive compression using seed bits* · [US7184597B1](https://patents.google.com/patent/US7184597B1/en) | **[thin novelty]** — the "regenerate from a seed/recipe instead of storing bytes" core is prior art (US20040267773 even covers regenerating *one entry* on demand = our observer-slice). The only unoccupied sliver is the **composition**: a mixed lossless container that stores generative members *verified by materialize-then-sha* **alongside** best-fit-compressed members. Defensive-publication material, not a patentable algorithm. |
| **Byte-shuffle / SoA planes; bitshuffle** (transform 3/4/5) | HDF5 **shuffle** filter + **Blosc bitshuffle** — documented open standards ([HDF Group filters](https://docs.hdfgroup.org/archive/support/services/filters.html), [Blosc/hdf5-blosc](https://github.com/Blosc/hdf5-blosc)); no patent surfaced | **[public-domain]** — an open, widely-implemented filter. CSF auto-selecting the stride per file is *application*, not invention. |
| **BCJ / executable branch filter before LZMA** (codec 9) | xz/LZMA **BCJ** filters (x86/ARM/…), UPX — public-domain, in the xz-utils standard | **[public-domain]** — a standard LZMA prefilter. Not novel. |
| **Framed solid + slice-addressable random access** (frames cut at member boundaries; O(window) reads) | [US20120109909A1](https://patents.google.com/patent/US20120109909A1/en) *Random Access Data Compression* · [US9503123](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9503123) *random access via bitwise indices* · [US11934346](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11934346) *random access of a member in a compressed tar* · the **zstd seekable format** (BSD) + Mark Adler's `zran.c` (public) | **[prior-art]** — "split into independent frames + a seek table mapping compressed↔decompressed offsets" is exactly the zstd seekable format and these patents. Not novel. |
| **Per-file SHA-256 + footer integrity + path-traversal guard** (the format identity) | Standard archive integrity (zip CRC, tar, OCI content-addressing) | **[prior-art]** — integrity + content addressing is ubiquitous. The *value* is the coined name + the guarantee, not novelty (matches register §4.7). |

---

## The two real gains (neither is a patent)

**1. Freedom-to-operate is clean [planning-grade].** The patents that *look* blocking are not: US5953503A (1997) and US20040267773 (2004) are past their 20-year term; US8111704/US6804238 are **packet-header** compression (a different field of use); the seekable-archive art is either expired-adjacent or matched by BSD-licensed open formats (zstd seekable). Net: **nothing found blocks CSF from shipping any of its techniques.** This is worth recording — it's the FTO half of a real IP review, and it came back green. (Attorney confirmation still precedes reliance, per register §7.)

**2. One defensible sliver → defensive publication, not a filing [thin novelty].** The only composition without a clean direct hit is: *a single integrity-checked container that stores (a) best-fit-compressed members, (b) generative members verified by materialize-then-hash, and (c) framed + slice-addressable reads, with loop-grounded tier selection.* Even this is an assembly of known parts. The right vehicle is a **defensive-publication timestamp** (this doc + the CSF spec on the public repo) that blocks others from patenting the composition and preserves freedom-to-operate — exactly the strategy the register already commits to (§1: "publish the methods, trademark the names").

---

## What this changes in the register

Nothing structurally — it **validates** the existing routing. [`KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §4.7 already grades CSF **LOW** and routes it to **defensive publication + the CSF trademark**. This review supplies the *named prior art* that §7 says must precede any filing, and adds the FTO-green finding. Recommended one-line register update: cite this doc as the CSF prior-art record.

## Honest scope
- Live web search, not an exhaustive professional patent database (no Derwent/PatBase); a formal FTO adds a claims-chart review by counsel.
- "Term-expired" is inferred from filing year + the 20-year term; a real expiry check accounts for maintenance-fee lapse and adjustments.
- The "no patentable mechanism" verdict is *specifically about CSF's compression*; the register's genuinely-novel systems items (the accountability layer, the decode/verify controller, the dilation-as-grounding-budget primitive) are graded separately there and are unaffected by this review.
