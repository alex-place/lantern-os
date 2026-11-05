### Changed

- Sigma0 C3 is now machine-checked: a Lean proof (docs/formal/C3EngineLift.lean) of the anti-collapse covariance lift through the engine's own projection, bridge tests tying the proof's hypotheses to the shipped code, an adversarial forward_step fuzz over all three projection branches, and the theorem's rho hypothesis enforced: an armed step refuses to fire when d*eps/sigma_max exceeds 9e-4. The certificate's section 3 now describes the per-sample gate and right-kernel projector.
