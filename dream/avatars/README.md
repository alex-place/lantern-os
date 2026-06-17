# Agent Avatars

Drop agent avatar images here. Served statically at `/avatars/<file>`.

## Keystone (the Σ₀ coding agent)

Current avatar: **`keystone.svg`** — a hand-built ink stand-in of the cracked keystone
stone (the cracks show its evidence, nothing hidden). Both persona files
(`apps/data/contexts/personas.json` and `data/contexts/personas.json`) point
Keystone's `avatar` field at `/avatars/keystone.svg`.

To swap in the canonical hand-drawn scan instead:
1. Save it as `apps/lantern-garage/public/avatars/keystone.png`
   (square-ish, ~256×256+, transparent or paper-colored background).
2. Change the `avatar` field in **both** persona files to `/avatars/keystone.png`.

If the referenced file is ever missing, the agent-status UI falls back to the 🔑
emoji automatically (the `<img onerror>` handler swaps it back), so nothing breaks.
The ink-wash / neon-cyberpunk variants work as alternates.
