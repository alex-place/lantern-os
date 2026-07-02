feat(three-doors): grounded narration + runtime doors — every turn generated from the painting

Each turn's text is now generated from the context of the actual scene image
(vision model describes the painting when a provider is up; the exact image
generation prompt is the grounding fallback) plus the play context (theme,
lesson, recent choices, and the player's typed desires). The three choices are
generated at runtime as EITHER existing doors of the shared world OR new doors
with metadata created on the spot (name, description, target scene) —
registered in playerProgress.dynamicDoors so an invented door stays real
across reloads and routes to its own target. Engine content still renders
instantly and stays whenever generation is unavailable (offline-safe).

Also fixes silently-dead narration: the game requested the removed "lantern"
persona (#1664 left only "keystone"), so every narration call had been 503ing
since then. Each enrichment logs a Σ₀ evidence record of what it was grounded
on (vision / image_prompt / canon_only).
