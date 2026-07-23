Σ₀ technical paper (docs/SIGMA0-TECHNICAL-PAPER.md): academic-style technical report of the
program — abstract, related work, architecture, the Spiral (persistent verified inference),
the Collapse Certificate stability results, the from-scratch training program with staged
G0-G3 gates, measured system results, the trading delayed-verifier application, and honest
limitations. Passed a 4-agent adversarial evidence-class audit; all 3 major findings fixed
before landing: the headline probe number was relabeled from an unsourced "0.980/0.774 @ 1.5B"
to the actually-committed Ouro-1.4B result (AUROC 0.9939 on a length-matched set, logprob
baseline 0.767, data/sigma0/hidden_probe_report.json), the 18/18 cascade run was un-welded
from the separate 5/6 honest-halt run, and premise P3 was softened to track the ARC Prize
source rather than overclaim "verification". Minor citation hygiene fixed too.
