### Fixed

- oracle(grounding): third strike of the bare-cosmology-word disease. #1268 stopped defaulting
  every question to the NOW band and #1275 dropped "now"/"today"/"current", but real cosmology
  terms that also live in everyday/technical language still false-matched alone — "transparent"
  grounded a CSS question in the CMB, "begin"/"beginner" in the Planck epoch, "inflation" (the
  economic kind) in cosmic inflation, "final state" (a reducer) in the heat death, "singularity"
  (the AI kind) in the initial singularity. The matcher now splits **STRONG** phrases
  (unambiguous — match alone) from **WEAK** words (real anchors that additionally require
  cosmology context in the same question), applied identically in the Node hot-path twin
  (`lib/convergence-oracle.js`) and the Python canonical (`src/convergence/oracle.py`). Covered
  by 5 Node cases + 6 Python cases (the measured false positives + the still-must-ground set).
