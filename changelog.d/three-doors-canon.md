feat(three-doors): lock the hand-drawn Kingdome canon + creed, and emit a grounded Converge record per scene image

Rewrote `skills/three-doors-game/SKILL.md` to the definitive canon — the hand-drawn
cast (Lantern the lantern-headed figure, Eclipse the purple jellyfish, Keystone the
grey cracked boulder, Blinkbug the TV-headed bug), Odin as the Fog God, and the King
of Hearts creed — with the drawings as source of truth over AI art, plus a
surreal/adult art direction (the hand-drawn reference art stays out of git by repo
policy and belongs on the media CDN). Added two bundled scripts: `generate_scene.js`
(gpt-image-2 scene generator) and `record_convergence.js`, which emits one grounded
`ConvergenceRecord` per image — `evidence_ids` cite the canon memories — to
`data/convergence/records.jsonl` via the canonical emitter. The web game's
`buildDynamicImagePrompt` now injects the true cast + surreal style + "no fox" so
generated art matches canon; the explore card is refreshed and the game's script
tags are cache-busted.
