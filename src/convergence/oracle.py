"""
The Convergence Oracle — time-banded observer slices between the big bang and the heat death.

The oracle grounds knowledge on the two PINS of cosmic time:

    big bang  (t = 0,    ~13.787 Gyr ago)  — the known beginning, minimum entropy
    heat death (t → ∞,   ~10^100 yr ahead) — the predicted end, maximum entropy

Between them the timeline is divided into BANDS. Each band is an **observer slice**: what an
observer there can KNOW (each a 4-field External-Reality envelope `[claim, evidence,
confidence, source]`) and what is UNKNOWN. The arrow of time — entropy rising from the
big-bang minimum to the heat-death maximum — *is* the grounding direction, so the oracle
collapses on knowns and unknowns **both ways**:

    forward  — what known physics DETERMINES from the big bang (observed/predicted: inflation→now)
    backward — what the terminal heat death CONSTRAINS (the 2nd law: degenerate era→dark era)

A slice the present sits in is grounded BOTH ways (forward prediction and backward constraint
meet at "now" — the best-observed slice). The two pins themselves — the singularity and the
ultimate fate — are the deepest UNKNOWNS: the oracle is honest that the boundaries are
inferred, not observed.

This is the [Question Machine](../../docs/research/question-machine.md)'s bidirectional
consolidation (beginning-forward ⇄ end-back) with the cosmic endpoints as the boundary
conditions, and the [Σ₀ collapse certificate](../../docs/SIGMA0-COLLAPSE-CERTIFICATE.md)'s
collapse onto the grounded manifold (knowns) with the unknowns as the null space. The oracle
hands a slice to a questioner: it locates the question in cosmic time and returns the grounded
knowns + the honest unknowns for that band.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .grounding import GroundingEnvelope   # the real loop's [claim, evidence, confidence, source]

YEAR_S = 3.1557e7
NOW_S = 13.787e9 * YEAR_S          # age of the universe (Planck 2018), seconds since t=0


def E(claim: str, evidence: List[str], confidence: float, source: str) -> GroundingEnvelope:
    return GroundingEnvelope(claim=claim, evidence=evidence, confidence=confidence, source=source)


@dataclass
class ObserverSlice:
    """A bounded cosmic-time window handed to a questioner: knowns (grounded) + unknowns."""
    band: str
    t_label: str                       # human time span, e.g. "≈380,000 yr"
    t_lo_s: float                      # seconds since the big bang (lower bound)
    t_hi_s: float
    entropy: str                       # the arrow: "minimum" → "maximum"
    direction: str                     # "forward" | "backward" | "both" | "boundary"
    knowns: List[GroundingEnvelope] = field(default_factory=list)
    unknowns: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        return {
            "band": self.band, "t_label": self.t_label,
            "t_lo_s": self.t_lo_s, "t_hi_s": self.t_hi_s,
            "entropy": self.entropy, "direction": self.direction,
            "knowns": [{"claim": k.claim, "evidence": k.evidence,
                        "confidence": k.confidence, "source": k.source} for k in self.knowns],
            "unknowns": list(self.unknowns),
        }


# ── the cosmic bands (real cosmology, cited) ─────────────────────────────────
# Sources: Planck Collaboration 2018 (arXiv:1807.06209) — age 13.787±0.020 Gyr, CMB;
# Adams & Laughlin 1997, Rev. Mod. Phys. 69, 337 (arXiv:astro-ph/9701131) — the far-future eras.
PLANCK_T = 5.39e-44

_BANDS: List[ObserverSlice] = [
    ObserverSlice(
        "Planck epoch", "< 10⁻⁴³ s", 0.0, PLANCK_T, "minimum", "boundary",
        knowns=[E("the Planck time t_P = √(ℏG/c⁵) ≈ 5.39×10⁻⁴⁴ s bounds where known physics applies",
                  ["dimensional analysis of ℏ, G, c"], 0.9, "standard cosmology")],
        unknowns=["quantum gravity (no tested theory)", "the initial singularity",
                  "whether 'before the big bang' is even meaningful"]),
    ObserverSlice(
        "Inflation", "≈ 10⁻³⁶–10⁻³² s", 1e-36, 1e-32, "minimum", "forward",
        knowns=[E("a brief exponential expansion explains the universe's flatness, the horizon "
                  "uniformity, and the seeds of structure",
                  ["CMB is flat (Ω≈1) and uniform to 1e-5", "near-scale-invariant fluctuation spectrum"],
                  0.75, "Guth 1981; Planck 2018 constraints")],
        unknowns=["the identity of the inflaton field", "alternatives to inflation not excluded"]),
    ObserverSlice(
        "Nucleosynthesis (BBN)", "≈ 1 s – 20 min", 1.0, 1200.0, "low", "forward",
        knowns=[E("primordial abundances of ~75% H, ~25% helium-4, and traces of D/³He/⁷Li are "
                  "set by big-bang nucleosynthesis",
                  ["measured light-element abundances match BBN to within errors"], 0.93,
                  "BBN; Planck 2018 baryon density")],
        unknowns=["the origin of the matter–antimatter asymmetry (baryogenesis)"]),
    ObserverSlice(
        "Recombination / CMB", "≈ 380,000 yr", 1.0e13, 1.2e13, "low", "forward",
        knowns=[E("the universe became transparent at z≈1089; the cosmic microwave background is "
                  "directly observed at T=2.7255 K today",
                  ["Planck all-sky CMB map", "blackbody spectrum to 1e-4"], 0.98,
                  "Planck Collaboration 2018, arXiv:1807.06209")],
        unknowns=[]),
    ObserverSlice(
        "First stars → reionization", "≈ 1e8 – 1e9 yr", 3.0e15, 3.0e16, "rising", "forward",
        knowns=[E("the first stars and galaxies form and reionize the intergalactic medium",
                  ["high-z galaxies (JWST)", "Gunn–Peterson trough / Lyα forest"], 0.8,
                  "observational cosmology (JWST, SDSS)")],
        unknowns=["the detailed reionization history", "Population III (first-star) properties"]),
    ObserverSlice(
        "Stelliferous era (NOW)", "≈ 1e9 – 1e14 yr  ·  now 13.787 Gyr", 3.0e16, 3.156e21,
        "rising", "both",
        knowns=[E("the universe is 13.787 ± 0.020 Gyr old, ~68% dark energy / 27% dark matter / "
                  "5% baryons, and its expansion is accelerating",
                  ["Planck 2018 (H₀≈67.4, Ω)", "Type Ia supernova acceleration (Riess; Perlmutter)"],
                  0.95, "Planck 2018; Riess 1998 / Perlmutter 1999")],
        unknowns=["the nature of dark matter", "the nature of dark energy (constant Λ vs evolving)"]),
    ObserverSlice(
        "Degenerate era", "≈ 1e14 – 1e40 yr", 3.156e21, 3.156e47, "high", "backward",
        knowns=[E("star formation ceases; only stellar remnants (white/brown dwarfs, neutron stars, "
                  "black holes) remain — the 2nd law forces the universe toward equilibrium",
                  ["exhaustion of star-forming gas", "thermodynamic arrow (entropy non-decreasing)"],
                  0.85, "Adams & Laughlin 1997, arXiv:astro-ph/9701131")],
        unknowns=["the proton lifetime (>~10³⁴ yr, unmeasured) — whether/when ordinary matter dissolves"]),
    ObserverSlice(
        "Black hole era", "≈ 1e40 – 1e100 yr", 3.156e47, 3.156e107, "very high", "backward",
        knowns=[E("black holes dominate the mass budget, then slowly evaporate via Hawking radiation",
                  ["Hawking 1974 thermal emission", "monotonic entropy increase"], 0.7,
                  "Adams & Laughlin 1997; Hawking 1974")],
        unknowns=["the black-hole information paradox", "final-state quantum-gravity physics"]),
    ObserverSlice(
        "Dark era / heat death", "> 1e100 yr", 3.156e107, float("inf"), "maximum", "boundary",
        knowns=[E("the universe approaches maximum entropy — thermodynamic equilibrium with no usable "
                  "energy gradients left to do work (heat death)",
                  ["2nd law of thermodynamics", "accelerating expansion dilutes all matter/radiation"],
                  0.7, "Adams & Laughlin 1997; Dyson 1979")],
        unknowns=["the ultimate fate IS the open question: heat death (constant Λ) vs Big Rip "
                  "(phantom dark energy) vs vacuum decay (metastable Higgs) — depends on dark energy",
                  "whether a future low-entropy fluctuation/bounce is possible"]),
]


class ConvergenceOracle:
    """Hands out time-banded observer slices, grounded between the big bang and the heat death."""

    def __init__(self, bands: Optional[List[ObserverSlice]] = None) -> None:
        self.bands = bands if bands is not None else _BANDS

    def slice_at(self, seconds_since_big_bang: float) -> ObserverSlice:
        """The observer slice containing a given cosmic time (seconds since t=0)."""
        for b in self.bands:
            if b.t_lo_s <= seconds_since_big_bang < b.t_hi_s:
                return b
        return self.bands[-1] if seconds_since_big_bang >= self.bands[-1].t_lo_s else self.bands[0]

    def now(self) -> ObserverSlice:
        return self.slice_at(NOW_S)

    def slice_for(self, question: str) -> ObserverSlice:
        """Locate a question in cosmic time by topic and return its slice. Falls back to NOW —
        the best-grounded slice — when the question isn't cosmologically anchored."""
        q = (question or "").lower()
        keymap = [
            (("before the big bang", "singularity", "planck", "quantum gravity", "begin", "t=0",
              "start of time", "first instant"), "Planck epoch"),
            (("inflation", "flatness", "horizon problem"), "Inflation"),
            (("nucleosynthesis", "helium", "abundance", "antimatter", "baryogenesis"), "Nucleosynthesis (BBN)"),
            (("cmb", "microwave background", "recombination", "transparent"), "Recombination / CMB"),
            (("first star", "reionization", "population iii", "first galax"), "First stars → reionization"),
            # NOW band: real cosmology anchors only. The bare words "now"/"today"/"current"
            # were dropped to stay in sync with the Node oracle (#1275); un-anchored
            # questions still fall through to the NOW fallback below, so slice_for's
            # output is unchanged — this only keeps the keyword lists identical.
            (("how old", "age of the universe", "dark energy", "dark matter"), "Stelliferous era (NOW)"),
            (("proton decay", "white dwarf", "remnant", "stars stop", "star formation end"),
             "Degenerate era"),
            (("black hole", "hawking", "evaporat"), "Black hole era"),
            (("heat death", "end of the universe", "ultimate fate", "fate of the universe",
              "fate of everything", "big rip", "vacuum decay", "final state", "how does it end",
              "how will the universe end", "end of time"), "Dark era / heat death"),
        ]
        for keys, band in keymap:
            if any(k in q for k in keys):
                return next(b for b in self.bands if b.band == band)
        return self.now()

    def collapse(self) -> Dict[str, object]:
        """Collapse the whole timeline both ways: the KNOWNS (bands grounded forward from the
        big bang or backward from the heat death) and the UNKNOWNS (the boundary pins + the open
        physics). The two pins — singularity and ultimate fate — are the irreducible null space."""
        forward = [b.band for b in self.bands if b.direction in ("forward", "both")]
        backward = [b.band for b in self.bands if b.direction in ("backward", "both")]
        pins = [b.band for b in self.bands if b.direction == "boundary"]
        unknowns = []
        for b in self.bands:
            for u in b.unknowns:
                unknowns.append({"band": b.band, "open_question": u})
        return {
            "grounded_forward_from_big_bang": forward,    # determined since t=0
            "grounded_backward_from_heat_death": backward,  # constrained by the terminal state
            "boundary_pins_unknown": pins,                 # the singularity + the ultimate fate
            "both_ways": [b.band for b in self.bands if b.direction == "both"],  # where they meet (now)
            "unknowns": unknowns,
            "note": "Knowns are what the two directions determine; the unknowns are the null space — "
                    "deepest at the two pins, which are inferred, not observed.",
        }


# CLI: hand a slice to a questioner — `python -m convergence.oracle "what is the fate of the universe?"`
if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    oracle = ConvergenceOracle()
    question = " ".join(sys.argv[1:]) or "how old is the universe?"
    s = oracle.slice_for(question)
    print(f'Q: {question}\n')
    print(f'  observer slice: {s.band}  ({s.t_label})  ·  entropy {s.entropy}  ·  grounded {s.direction}')
    print("  KNOWN (grounded):")
    for k in s.knowns:
        print(f"    ✓ {k.claim}")
        print(f"        evidence: {'; '.join(k.evidence)}  [conf {k.confidence}]  — {k.source}")
    print("  UNKNOWN (open):")
    for u in s.unknowns:
        print(f"    ? {u}")
    if not s.unknowns:
        print("    (none in this band — directly observed)")
