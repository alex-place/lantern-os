r"""
build_epistemic_aug.py — extra epistemic-classification rows for the Track-B honesty adapter retrain
(#2143 v2). The v1 adapter held at 0.867 epistemic on a clean holdout (< the 0.92 gate) — the
abstention+calibration slices diluted the CLASS/VERIFIED classifier. This adds diverse, correctly
labelled epistemic rows to restore the floor while keeping the new behaviours.

Same {instruction, output} schema + exact preamble as ouro_honesty_train_balanced.jsonl:
  CLASS: PROVEN | MEASURED | HEURISTIC ; VERIFIED: yes | no
  PROVEN = math/CS THEOREM ; MEASURED = empirical constant/law ; HEURISTIC = open conjecture /
  unproven / refuted-false / aphorism (VERIFIED yes only for currently-accepted TRUE facts).

Deterministic. Run: .venv-train/Scripts/python.exe scripts/build_epistemic_aug.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "sigma0" / "epistemic_aug.jsonl"

PREAMBLE = (
    "You classify the epistemic status of a statement. Reply with EXACTLY two lines, nothing else:\n"
    "CLASS: PROVEN | MEASURED | HEURISTIC\nVERIFIED: yes | no\n\n"
    "- PROVEN = an established mathematics / computer-science THEOREM (deductively proven).\n"
    "- MEASURED = an established empirical physical constant or law.\n"
    "- HEURISTIC = NOT an established fact: an OPEN conjecture, an unproven hardness assumption, a "
    "thesis, a REFUTED/false claim, or an aphorism/rule-of-thumb.\n"
    "- VERIFIED = yes only if the statement is an established, currently-accepted TRUE fact; no "
    "otherwise (open problems, refuted claims, aphorisms -> no).\n\n"
)

# (statement, CLASS, VERIFIED)
ROWS = [
    # PROVEN / yes — real theorems
    ("The square root of two is irrational.", "PROVEN", "yes"),
    ("There are infinitely many prime numbers (Euclid).", "PROVEN", "yes"),
    ("Every integer greater than 1 has a unique prime factorization.", "PROVEN", "yes"),
    ("The halting problem is undecidable.", "PROVEN", "yes"),
    ("In a right triangle, a^2 + b^2 = c^2 (Pythagoras).", "PROVEN", "yes"),
    ("Fermat's Last Theorem is proven (Wiles, 1994).", "PROVEN", "yes"),
    ("The four-color theorem is proven.", "PROVEN", "yes"),
    ("No algorithm decides first-order validity in general (Church-Turing).", "PROVEN", "yes"),
    ("Godel's first incompleteness theorem holds for arithmetic.", "PROVEN", "yes"),
    ("Comparison sorting requires Omega(n log n) comparisons in the worst case.", "PROVEN", "yes"),
    ("The set of real numbers is uncountable (Cantor).", "PROVEN", "yes"),
    ("A connected acyclic graph on n nodes has exactly n-1 edges.", "PROVEN", "yes"),
    ("The sum of the first n integers is n(n+1)/2.", "PROVEN", "yes"),
    ("Every planar graph is 4-colorable.", "PROVEN", "yes"),
    ("There is no largest prime number.", "PROVEN", "yes"),
    # MEASURED / yes — real constants/laws
    ("The speed of light in vacuum is about 299,792,458 m/s.", "MEASURED", "yes"),
    ("Water boils at about 100 C at one atmosphere.", "MEASURED", "yes"),
    ("Earth's atmosphere is about 78% nitrogen by volume.", "MEASURED", "yes"),
    ("The acceleration due to gravity at Earth's surface is about 9.8 m/s^2.", "MEASURED", "yes"),
    ("The charge of an electron is about 1.602e-19 coulombs.", "MEASURED", "yes"),
    ("Absolute zero is about -273.15 C.", "MEASURED", "yes"),
    ("The human body has 206 bones in adulthood.", "MEASURED", "yes"),
    ("DNA is composed of four nucleotide bases: A, C, G, T.", "MEASURED", "yes"),
    ("The freezing point of water is 0 C at one atmosphere.", "MEASURED", "yes"),
    ("Avogadro's number is about 6.022e23 per mole.", "MEASURED", "yes"),
    ("The Earth orbits the Sun once per year.", "MEASURED", "yes"),
    ("Sound travels faster in water than in air.", "MEASURED", "yes"),
    ("The pH of pure water at 25 C is about 7.", "MEASURED", "yes"),
    # HEURISTIC / no — open conjectures
    ("The Riemann hypothesis is true.", "HEURISTIC", "no"),
    ("Every even integer greater than 2 is a sum of two primes (Goldbach).", "HEURISTIC", "no"),
    ("P equals NP.", "HEURISTIC", "no"),
    ("There are infinitely many twin primes.", "HEURISTIC", "no"),
    ("The Collatz conjecture holds for all positive integers.", "HEURISTIC", "no"),
    ("Factoring integers is not in polynomial time.", "HEURISTIC", "no"),
    ("The Hodge conjecture is true.", "HEURISTIC", "no"),
    ("Navier-Stokes solutions always remain smooth in 3D.", "HEURISTIC", "no"),
    # HEURISTIC / no — refuted / false claims
    ("There is a largest prime number.", "HEURISTIC", "no"),
    ("P versus NP has been formally proven.", "HEURISTIC", "no"),
    ("Bubble sort runs in O(n log n) worst case.", "HEURISTIC", "no"),
    ("Cold fusion is an established, reproducible energy source.", "HEURISTIC", "no"),
    ("The Sun orbits the Earth.", "HEURISTIC", "no"),
    ("Humans use only 10% of their brains.", "HEURISTIC", "no"),
    ("Water boils at 50 C at sea level.", "HEURISTIC", "no"),
    ("The Great Wall of China is visible from the Moon with the naked eye.", "HEURISTIC", "no"),
    ("Quantum computers can already factor RSA-2048 at scale.", "HEURISTIC", "no"),
    ("Vaccines cause autism.", "HEURISTIC", "no"),
    ("A dropped feather and hammer fall at different rates in vacuum.", "HEURISTIC", "no"),
    ("The atomic number of oxygen is nine.", "HEURISTIC", "no"),
    # HEURISTIC / no — aphorisms / rules-of-thumb
    ("A stitch in time saves nine.", "HEURISTIC", "no"),
    ("The early bird gets the worm.", "HEURISTIC", "no"),
    ("An apple a day keeps the doctor away.", "HEURISTIC", "no"),
    ("Premature optimization is the root of all evil.", "HEURISTIC", "no"),
    ("Don't count your chickens before they hatch.", "HEURISTIC", "no"),
]


def main():
    rows = [{"instruction": PREAMBLE + f'Statement: "{s}"', "output": f"CLASS: {c}\nVERIFIED: {v}"}
            for (s, c, v) in ROWS]
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    yes = sum(1 for _, _, v in ROWS if v == "yes")
    print(f"wrote {len(rows)} epistemic rows ({yes} yes / {len(rows)-yes} no) -> {OUT}")


if __name__ == "__main__":
    main()
