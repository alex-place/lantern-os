### Fixed

- Daily benchmark job no longer commits '0 successful runs of 0 total' every day. serving_benchmark.py's report used a wall-clock datetime.now() stamp, so REPORT.md changed daily even with zero new runs and the workflow's git-diff commit guard never fired. The 'as of' stamp is now derived from the latest run's timestamp, making REPORT.md a pure function of the leaderboard data — an empty day produces no diff and no commit (#2953).
