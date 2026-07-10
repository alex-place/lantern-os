r"""
build_honesty_calibration_aug.py — author the abstention + calibration slice for the
Track-B honesty/calibration adapter (#2143).

The balanced epistemic corpus (data/sigma0/ouro_honesty_train_balanced.jsonl, 147 rows) teaches
the CLASS/VERIFIED two-line classifier but has ZERO abstention rows and no confidence-calibration
examples. This emits the two missing slices the issue calls for, in the same {instruction, output}
schema the trainer consumes:

  * ABSTENTION — a question answerable ONLY with evidence not provided (a project unknowable, an
    unstated private fact). Correct behaviour: refuse + low confidence, never fabricate. Phrasing
    is DIVERSE and deliberately DISJOINT from the 4 built-in probes in eval_sigma0_adapter.py, so
    the gate measures generalization, not memorization.
  * CALIBRATION — a claim carried in the claim/evidence/confidence/source structure with a stated
    confidence that MATCHES its correctness (high for solid facts, low for shaky/uncertain ones),
    so ECE/Brier have signal to learn from.

Deterministic (no RNG) — reproducible. Run:
  .venv-train/Scripts/python.exe scripts/build_honesty_calibration_aug.py
Writes data/sigma0/honesty_calibration_aug.jsonl.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "sigma0" / "honesty_calibration_aug.jsonl"

ABSTAIN_SYS = (
    "You are a Σ₀ assistant. Ground every claim in given evidence. If you lack the evidence to "
    "answer, say so explicitly and give low confidence — never fabricate. End with: confidence: <0-1>."
)

# Questions answerable ONLY from context/evidence that is NOT provided here. Correct = abstain.
# Deliberately different from eval_sigma0_adapter.py's 4 built-in probes.
ABSTAIN_QS = [
    "What is the default timeout in milliseconds for the HTTP client in this codebase?",
    "Which branch is this repository's production deploy cut from?",
    "How many rows are currently in the user's `conversations` table?",
    "What email address did the account owner register with?",
    "What is the value of the environment variable `SESSION_SECRET` on the server?",
    "Which model does the user have selected as their default provider right now?",
    "What was the exact commit SHA of the last release tag?",
    "How much disk space is free on the training box at this moment?",
    "What is the user's home city?",
    "Which port does the staging database listen on in this deployment?",
    "What did the last failed CI run report as the error message?",
    "How many open pull requests does this repo have today?",
    "What is the API rate limit configured for the Kalshi collector here?",
    "What password did the user set for the admin panel?",
    "Which GPU is installed in the machine running this server?",
    "What is the current balance of the user's paper-trading account?",
    "What time zone is the server configured to use?",
    "Which files were changed in the most recent commit on this branch?",
    "What is the exact version string of the deployed frontend build?",
    "How many Discord members are in the user's server right now?",
]

ABSTAIN_OUTS = [
    "I don't have the evidence to answer this — the value isn't in the provided context, and I won't guess. confidence: 0.1",
    "Insufficient evidence: this depends on project state I haven't been shown. I cannot determine it. confidence: 0.1",
    "I can't verify this from what's provided — no source establishes it here, so I'll abstain rather than fabricate. confidence: 0.05",
]

# (claim, is_true, calibrated_confidence, evidence, source-domain, cls, verified)
CALIB = [
    ("Water boils at 100 °C at one atmosphere of pressure.", True, 0.97, "standard sea-level boiling point", "physics", "MEASURED", "yes"),
    ("The halting problem is undecidable.", True, 0.99, "Turing 1936, diagonalization proof", "CS-theory", "PROVEN", "yes"),
    ("There are infinitely many prime numbers.", True, 0.99, "Euclid's theorem", "mathematics", "PROVEN", "yes"),
    ("P equals NP.", False, 0.05, "open problem; widely believed false but unproven", "CS-theory", "HEURISTIC", "no"),
    ("The Riemann hypothesis has been proven.", False, 0.03, "still an open conjecture as of 2026", "mathematics", "HEURISTIC", "no"),
    ("The speed of light in vacuum is about 3.0e8 m/s.", True, 0.97, "defined constant c = 299792458 m/s", "physics", "MEASURED", "yes"),
    ("Every even integer > 2 is the sum of two primes.", False, 0.1, "Goldbach conjecture — unproven", "mathematics", "HEURISTIC", "no"),
    ("The Earth's atmosphere is mostly nitrogen.", True, 0.95, "~78% N2 by volume", "chemistry", "MEASURED", "yes"),
    ("Bubble sort runs in O(n log n) worst case.", False, 0.05, "bubble sort is O(n^2) worst case", "CS", "HEURISTIC", "no"),
    ("A SHA-256 hash is 256 bits long.", True, 0.96, "by definition of the algorithm", "CS", "PROVEN", "yes"),
    ("Dark matter has been directly detected in a laboratory.", False, 0.05, "no confirmed direct detection as of 2026", "physics", "HEURISTIC", "no"),
    ("The derivative of sin(x) is cos(x).", True, 0.98, "elementary calculus", "mathematics", "PROVEN", "yes"),
    ("HTTP status 200 means the request succeeded.", True, 0.95, "RFC 9110", "web", "PROVEN", "yes"),
    ("Quantum computers can already break RSA-2048 at scale.", False, 0.05, "no such fault-tolerant machine exists in 2026", "CS", "HEURISTIC", "no"),
    ("The mitochondrion produces most of a cell's ATP.", True, 0.93, "oxidative phosphorylation", "biology", "MEASURED", "yes"),
    ("There is a largest prime number.", False, 0.02, "contradicts Euclid's theorem", "mathematics", "PROVEN", "no"),
    ("Big-O notation describes an asymptotic upper bound.", True, 0.96, "standard definition", "CS", "PROVEN", "yes"),
    ("Cold fusion is an established, reproducible energy source.", False, 0.04, "not reproduced/accepted", "physics", "HEURISTIC", "no"),
    ("A byte is 8 bits.", True, 0.97, "standard definition", "CS", "PROVEN", "yes"),
    ("The four-color theorem is unproven.", False, 0.05, "proven (Appel–Haken 1976, computer-assisted)", "mathematics", "PROVEN", "no"),
]


def calib_output(claim, is_true, conf, evidence, cls, verified):
    verdict = "This is well-supported." if is_true else "This is NOT established / is false."
    return (f"claim: {claim}\n"
            f"assessment: {verdict}\n"
            f"evidence: {evidence}\n"
            f"CLASS: {cls}\nVERIFIED: {verified}\n"
            f"confidence: {conf}")


def main():
    rows = []
    for i, q in enumerate(ABSTAIN_QS):
        out = ABSTAIN_OUTS[i % len(ABSTAIN_OUTS)]
        rows.append({"instruction": f"{ABSTAIN_SYS}\n\nQuestion: {q}", "output": out})
    for (claim, is_true, conf, ev, dom, cls, ver) in CALIB:
        instr = ("You are a Σ₀ assistant. Assess the claim below. Give claim, a one-line "
                 "assessment, the evidence, then two lines CLASS: PROVEN|MEASURED|HEURISTIC and "
                 "VERIFIED: yes|no, and end with confidence: <0-1> that MATCHES how sure you are.\n\n"
                 f"Claim: {claim}")
        rows.append({"instruction": instr, "output": calib_output(claim, is_true, conf, ev, cls, ver)})
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    n_abstain = len(ABSTAIN_QS)
    print(f"wrote {len(rows)} rows ({n_abstain} abstention + {len(CALIB)} calibration) -> {OUT}")


if __name__ == "__main__":
    main()
