docs(adr): fix repo-root link prefixes in backfilled ADRs 0002/0003/0004/0007/0008

The backfilled ADRs linked repo-root targets (CLAUDE.md, AGENTS.md,
src/convergence/*, src/csf/*, apps/lantern-garage/lib/*, scripts/*,
.claude/agent-slots.json) with a single `../` prefix, which resolves from
docs/adr/ to nonexistent docs/-level paths. All such hrefs now use `../../`;
docs/-level links (ARCHITECTURE.md, CONVERGANCE-SIGMA0-BRIEFING.md,
CODEMAP.md, convergence-core-mapping.md) are unchanged. Every relative link
in the five files was verified to resolve (61/61). Link text, ADR content,
status, and wording are untouched. Improves the Verify stage (evidence links
in ADRs actually resolve to their cited sources).
