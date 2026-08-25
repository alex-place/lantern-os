### Research — the self experiment, and four controller defects it found

World S asks whether the machine can diagnose a defect in its own experiment-selection policy
from the pattern of its own mistakes. Pre-registered gates; verdict **KILLED** — the strict
evidence rule is specific (0% false firing on both controls) but almost never fires and buys
0.8%; loosening it doubles firing and fires on the controls. Recorded with the mechanism.

Building it found four defects in the shipped controller: probe accounting that made experiment
order free, a failed expansion that left the model unfitted (so the cheapest candidate always
won), rejected candidates being re-bought, and unbudgeted probing that let one episode spend 11x
its budget. Fixing them moved world H's commit variant from 66% to 92% and the discovery
benchmark from 0.107 to 0.146 per experiment with zero false discoveries — and superseded world
H's earlier headline, which was mostly that unfitted-refit bug.
