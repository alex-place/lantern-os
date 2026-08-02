change(docs): Knowledge Center rework — audience gating, real sorting, curated reports

The public docs page published operator runbooks (including one naming the live origin
IP behind Cloudflare), rendered the research-ingest directory verbatim — third-party
copyrighted PDFs and an internal revenue report among them — and re-sorted the whole
library alphabetically on load, which put ten hex-named uploads above the FAQ.

Catalog entries now carry an `audience` (public / builder / internal); internal never
renders. Reports come from a curated allowlist that fails closed, so nothing publishes
by sitting in the ingest folder. Sorting offers Recommended / Newest / A–Z and defaults
to the curation the generator computes. 87 dated research notes roll up into one card
plus a generated index, 13 category chips become 8, and the hero no longer advertises a
version six minors old. A new CI gate fails when a doc has no catalog entry, when the
page is stale, or when a public doc names a routable IP.
