### Fixed

- trading: the plan watchdog reads a sleeve journal that does not exist yet as an empty one. A sleeve that has never traded has no journal file, and the watchdog's first read of it threw ENOENT and journaled a plan_watch_error (the engine's month-end sleeve T, 2026-11-09 04:00:10 ET). A missing journal now means nothing to watch: no error row, nothing said, and the sleeve's first rows are read from the start once they come. Any other failed read is still journaled once an hour. Tests: a journal that never existed, and an unreadable one (EACCES), in plan-watch.test.js.
