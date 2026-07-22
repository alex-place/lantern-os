- Coding turns now log the exec-verify outcome as a router-training row (#2798):
  [intent, tier, provider/model, verified pass/fail, latency] →
  data/convergence/coding-outcomes.jsonl. The verify gate already ran; this only
  records its real label — the data a cascade-router needs and that the
  convergance records / pcsf receipts don't carry. Additive, never breaks a reply.
