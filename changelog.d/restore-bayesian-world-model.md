fix(ui): restore the Bayesian World Model page and rework its UX to match index.html

`flourishing.html` had reverted to the old generic "Dashboard"; restore the
grounded world model (domain posteriors, beliefs-and-evidence ledger, Question
Machine, methodology) and rework every section into color-coded panels with the
home-tile identity (top accent bar + hover). Also give the home `flourish-panel`
the same accent-bar treatment so it matches the rest of the home tiles. Backend
(`lib/flourishing-feeds.js` + `/api/flourishing/panel`) already on master.
