### Changed

- Entry cadence: one decision per bar. The scan loop is setTimeout(60s) after each scan completes (live spacing 8/18–8/21: median 58 s, p90 139 s, p99 564 s), so a fixed 3-minute window missed an hourly boundary outright roughly once in 15–20 and skipped that hour's decision for every symbol. Now the first scan after a boundary decides even if late (up to half a bar) and a second scan in the same bar never decides twice; skip rows say 'already decided this bar' vs 'between bar closes'. 3 new tests; engine suites 54/54
