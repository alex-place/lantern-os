### Research — a bench list to pipette, and the harvester bug that hid a stale corpus

The Robin loop only admitted candidates it could execute itself, which threw away every idea that
needs a GPU, a dataset, or a week of someone's time. `run_bench.js` is the other half: a ranked
list of experiments for a human to run, each with a mechanism, the experiment, the result that
would kill it, what it needs from you, and its retrieved arXiv ids. Same sham arm, same grounding
count, and the rendered document states at the top that nothing in it has been run.

The arXiv harvester retried connection errors but not read timeouts — a socket timeout during
`resp.read()` raises TimeoutError, which is not a URLError, so it escaped the retry loop. The
2026-08-20 run connected, hung on a large page, and re-indexed the same 115,761 papers with zero
new ones, reporting success. Read timeouts are the normal failure mode for that endpoint and now
back off like everything else; the read timeout is also configurable via ARXIV_HTTP_TIMEOUT.
