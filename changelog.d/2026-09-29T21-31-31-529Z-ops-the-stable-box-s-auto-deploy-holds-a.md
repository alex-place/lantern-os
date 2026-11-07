### Changed

- ops: the stable box's auto-deploy holds a restart while the market is open (weekdays 09:25-16:05 ET) — three mid-session restarts on 2026-09-29 let the armed trader buy inside a spent hour bar; one-shot override by flag file or -Force; also upstreams the lock-clear and process-priority fixes already running on the deploy host
