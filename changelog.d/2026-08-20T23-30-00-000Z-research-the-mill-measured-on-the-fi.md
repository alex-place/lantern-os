### Research — the mill measured on the field's benchmark, not on controls we wrote

Automated novelty assessment is a studied problem and we had audited every idea for prior art
except the auditor. The established method is what we built (AI Scientist: LLM queries → scholarly
search → one-to-one comparison; SciMON-style iterative novelty optimisation is the gap mill), and
there is a benchmark: RINoBench, 1,381 ideas labelled from real ICLR peer review.

Its published baselines are the finding. The best model in the field scores macro F1 0.172 on five
classes. Automated novelty judgment does not work yet, which makes refusing to output "novel" the
defensible position rather than a timid one.

Our auditor scores 0.174 on 80 of the 277 test examples — not a win: our vocabulary can only emit
three of the five classes and 76% of predictions land on one value.

Two more Goodhart failures fixed in the gap mill: evasion is now blocked against kept survivors as
well as collisions, and diversity is measured, because four of six survivors on one run were
permutations of a single asset.
