### Changed

- Looped-model routing and depth-collapse theory, machine-checked in Lean (docs/formal/TokenRouting.lean): per-token routing receipts, the capacity cost of one-step contraction, the hybrid composition, and the depth-collapse alarm. Adds Sigma0LoopLM.step_ratio_alarm, a sound alarm that fires only when the loop's step ratio proves its contraction receipt false; it is not wired into generate().
