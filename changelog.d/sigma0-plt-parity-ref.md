### Σ₀ PLT Stage-0: scripted reference-logits capture + ADR-0011 status reconcile (#1933, #1934)

Advance the owned-Σ₀-model epic (#1933) on the non-GPU front:

- **`models/keystone-sigma0-plt/capture_ref_logits.py`** — the previously-unscripted
  Stage-0 step ("dump reference logits → `ref_logits.pt`") is now a real script. It
  writes exactly the `{input_ids[1,T], logits[1,T,V]}` dict `check_parity --ref`
  consumes, tokenizing the **same** `PROMPTS` imported from `check_parity` (no drift),
  and captures from the vendor's trusted HF forward (clean full-sequence logits). A
  `--self-test` verifies the check_parity contract on CPU. So the faithful parity run
  (#1934) is now push-button; its only remaining blocker is a ≥24 GB box.
- **`tests/test_plt_ref_logits_contract.py`** — CPU gate (3 tests) pinning the
  capturer↔gate shape/dtype contract and the no-drift prompt import, so the parity
  number can't be silently meaningless.
- **`colab_parity.ipynb` §7** — replaces the manual bash-comment step with a scripted
  capture + compare cell.
- **ADR-0011 `## Status`** — reconciled to **Accepted** (approved by Alex Place
  2026-07-04) to match the frontmatter, which already recorded the approval; clarifies
  acceptance binds the staged plan, not model promotion (still `verified:false`).

Loop stage: **Reason** (own the reasoning kernel) + **Verify** (faithful parity gate).
