Docs: repo-wide markdown consolidation pass — every tracked `.md` was dispositioned
keep / merge / delete against the doc-catalog and a full inbound-reference scan.
138 stale files removed (status snapshots, completed-work reports, superseded
plans, relic skill contracts, personal outreach packets), 23 merged into canonical
docs (new consolidated READMEs for bettersafe, payment-bridge, discord bots, and
brand prompts; salvaged content folded into API-REFERENCE, CONVERGENCE-LOOP,
ARXIV-CORPUS, PATREON-OAUTH, SIGMA0-MODEL-DESIGN, SIGMA0-CONTINUAL-TRAINING,
creator-intelligence-architecture, the prediction-market survey, and the wallet
README). doc-catalog.json pruned 259→185 entries; Knowledge Center + knowledge
index regenerated; QA report outputs redirected from docs/ to gitignored
reports/; orphaned changelog fragments moved to the root changelog.d/.
(Improves Remember — one canonical doc set, less retrieval noise.)
