### Fixed

- Question Machine convergence no longer treats a stationary plan as sufficient to act: the grounded loop checks the worst-sample predicted terminal distance to the grounded goal and routes an unmet endpoint to `replan`. The residual and tolerance are included in the reconciliation record. This closes the known false-`act` case for a goal dimension with no control authority. It is an endpoint check, not a proof of mathematical reachability or global optimality; callers must calibrate `goal_tol` for their state units.
