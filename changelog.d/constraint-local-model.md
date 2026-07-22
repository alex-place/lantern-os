- Local model is now picked by the user's hardware constraints × our capability
  shaping and can run on a local CPU or a cheap GCP CPU instance as a cheap chat
  stand-in. No-GPU boxes CPU/RAM-gate (was: VRAM-only, falling back to 8GB and
  picking an unservable 7B → cloud). Adds Qwen2.5-Coder 3B/1.5B CPU tiers +
  selectCheapStandin(); GPU boxes unchanged.
