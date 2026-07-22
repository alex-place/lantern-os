### Fixed

- ci: the anti-sprawl gate now allows `.claude` as a top-level directory for new files (repo-managed skills already live at `.claude/skills/*` — four are tracked), and the Boilerplate / duplication check treats `SKILL.md` as `UBIQUITOUS` (one per skill directory by definition, like `__init__.py` per package). Both were false positives blocking #2822's `/bandits` skill; same class as the Node-manifest allowlist (#2767).
