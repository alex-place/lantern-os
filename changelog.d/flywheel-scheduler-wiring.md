Added: the continual-improvement flywheel (self-improvement-cron.js) is now wired
into server.js startup (#2145). It was built but never fired. The scheduler is
gated behind `SIGMA0_IMPROVEMENT_SCHEDULER=1` and defaults OFF, so dev/CI boots
are unaffected; when enabled it arms a weekly harvest → exec-verify → train →
eval-gated-promote pass. A GPU training run is only dispatched by
`maybeDispatchTraining()` once promoted patterns clear `TRAINING_PROMOTE_THRESHOLD`
(default 20), so arming the scheduler alone never forces a training run. Covered by
`apps/lantern-garage/test/flywheel-scheduler-wiring.test.js`.
