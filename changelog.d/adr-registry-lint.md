ci(adr): mechanical ADR registry lint — unique numbers, index membership, status agreement

ADR numbers collided three times (3×0001 #1813, 2×0008 #1126/#1144, 2×0023
#2147/#2158) because concurrent PRs pick the "next free number" against a stale
base and nothing caught it at merge. New dependency-free gate
`scripts/lint-adr-registry.mjs` (job `adr-registry` in pr-gates.yml) fails on:
duplicate 4-digit prefixes in docs/adr/; an ADR file with no row in
README.md's index table (also dangling rows, number↔filename disagreement,
duplicate rows); an index status cell contradicting the file's own status
(frontmatter `status:` → `- Status:` bullet → `## Status` section, compared by
leading keyword). Also lands the registry repairs the gate needs to be green
(mirrors #2164 byte-for-byte: 0023-sigma0 renumbered to 0024, index rows for
0018/0020/0022/0023/0024). Strengthens the Verify stage (docs registry
integrity is now machine-checked). Suggested as follow-up in ADR-0001's review.
