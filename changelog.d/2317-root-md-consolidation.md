docs(repo): remove 6 stale root-level .md docs documenting removed subsystems (#2317)

Root .md files compete for an agent's first-read attention. These 6 were both
orphaned (not linked by any canonical doc) and stale — describing systems that
no longer exist, so they actively mislead: KEYSTONE.md + ENGINEERING_MODE.md
(keyword task-detector/task-aware routing + keyword "engineering mode" +
RP personas, all removed in #2303/#1664), TRAINING_ORCHESTRATION_COMPLETE.md +
GPU_TRAINING_PLAN.md + DISPATCH_ISSUES.md (2026-06-23 point-in-time training
snapshots), BACKLOG.md (2026-06-14 trading backlog, superseded by GH issues).
Git history retains them. Required-reading + standard root files untouched.
Improves Remember.
