feat(orchestration): normie copy pass + full convergence API wiring

- Plain-English section headers: "Code Safety Check", "Your Turn", "Provider Leaderboard"
- New "Who Keystone Trusts" panel wired to /api/convergence/calibration — trust bars for each grounding source with % and check count
- New "Self-Tests" panel wired to /api/convergence/keystone-test/runs — audit trail with confidence score and filed issue links
- Fix duplicate escapeHtml (was defined twice, second shadowed first + missed quote escaping)
- Wire renderCalibration + renderKeystoneTests into DOMContentLoaded and 30/60 s refresh intervals
- Fix Dispatch/Poll/Refresh buttons (were dead inside IIFE — exposed on window)
