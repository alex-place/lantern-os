### Changed

- Sigma0 C3 is now machine-checked: a Lean proof (docs/formal/C3EngineLift.lean) of the anti-collapse covariance lift through the engine's own projection, bridge tests tying the proof's hypotheses to the shipped code, a forward_step fuzz that reaches all three branches of the lift's projection, and the theorem's rho hypothesis enforced: an armed step refuses to fire when d*eps/sigma_max exceeds 9e-4. This re-lands #3815, which merged into a branch that was closed instead of reaching master.
