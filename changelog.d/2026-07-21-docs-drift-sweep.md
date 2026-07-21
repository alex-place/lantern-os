### Changed

- docs(drift sweep): the canonical entry docs caught up with the code. **Rename sweep** — all
  eleven stale `dream-chat.html` references across README, CLAUDE.md, QUICKSTART, and AGENTS
  now say `chat.html` (renamed #2751), each keeping one deliberate legacy-redirect note; the
  CLAUDE.md testing charter's `dream-chat-agent-select` scenario (personas were removed in
  #1664) is replaced with a real `chat-provider-select` scenario. **Chat commands documented
  for humans** — README now lists the deterministic `!work` / `!review` / `!prs` commands (they
  were taught to the model in #2804 but documented nowhere user-facing). **Act-stage honesty**
  — README's v1.10 Act row and the AGI blueprint's Act GAP now carry the 2026-07-21 measured
  evidence: the autowork pipeline has not yet resolved a real issue end-to-end (live run failed
  at apply with hallucinated patch context; SWE-bench Lite single-shot 0/5; #2762), with the
  freshness-law diagnosis. **ARCHITECTURE.md** gets a targeted 2026-07-21 delta note (rename,
  the `!work` claim now actually true, loop-strip panels) and an honest "full re-ground remains
  due" marker. Follow-ups filed: PROVIDERS.md re-ground and a CI check for references to
  renamed/removed public surfaces.
