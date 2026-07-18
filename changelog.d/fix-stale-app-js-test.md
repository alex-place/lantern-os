Removed the stale `test_dashboard_holds_unverified_aws_url_as_local_front_door`
test: its subject (`public/app.js` cloud-mirror front-door logic) was deleted as
dead code in #2685, leaving the test red on every open PR. (Improves Verify —
CI failures mean something again.)
