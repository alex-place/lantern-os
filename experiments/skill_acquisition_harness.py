#!/usr/bin/env python3
"""Skill-acquisition (procedural-learning) harness — the missing axis (#2783).

The cognitive-profile audit found we measure RETENTION (LongMemEval — does a learned fact
survive) but not ACQUISITION (does the system get BETTER at a task family across exposures,
using memory/retrieval alone — no weight update). Burnell (arXiv:2605.28405) draws the
dissociation: *failing to update* is a learning failure; *forgetting what was learned* is a
memory failure. We could detect the second, not the first. This harness detects the first.

The North-Star rule holds: **persistent learning, NOT weight modification.** A "skill" is a
hidden deterministic rule; instances apply it to different inputs. A learner that can RETRIEVE
its past (input, output) experiences for a skill can INFER the rule after enough examples and
then answer correctly — improvement with zero weight change (ICCL, arXiv:2509.22764). The
acquisition curve is the slope of accuracy over a skill's exposure index; a positive slope with
memory ON and a flat one with memory OFF is procedural learning, isolated.

Model-agnostic: `solve_fn(inp, examples) -> answer` is injected, so the same harness measures a
deterministic reference learner (for validating the instrument) OR a real model driven with its
retrieved memory in-context (the internal-mark row — the follow-on). Three axes are reported
SEPARATELY, per the dissociation: acquisition, retention, and the spacing effect.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


# ── task family ─────────────────────────────────────────────────────────────────
# Each skill is a hidden affine-mod rule y = (a*x + b) mod m. Instances vary x. Nothing about a/b
# is given; a learner must infer them from retrieved (x, y) examples — >=2 examples pin an affine
# rule exactly, so a competent learner acquires the skill after 2 exposures and is correct forever
# after. That sharp, known threshold is what makes the instrument checkable.

@dataclass
class Skill:
    sid: str
    a: int
    b: int
    m: int = 97

    def output(self, x: int) -> int:
        return (self.a * x + self.b) % self.m


def make_skills(n: int) -> list:
    # deterministic, distinct rules (no RNG — indices only)
    return [Skill(sid=f"s{i}", a=(2 * i + 3) % 96 + 1, b=(5 * i + 7) % 97) for i in range(n)]


# ── the reference learner (instrument validation) ────────────────────────────────
def affine_learner_solve(x: int, examples: list, m: int = 97):
    """Infer y=(a*x+b) mod m from >=2 retrieved (x,y) examples, else abstain (guess wrong).

    Two distinct-x examples determine (a, b) over Z_m by solving the linear system; with fewer,
    the rule is under-determined and the learner cannot yet do the task. This is procedural
    learning from accumulated experience — exactly what memory ON should enable and OFF should not.
    """
    pts = list({xi: yi for xi, yi in examples}.items())  # dedup by x
    if len(pts) < 2:
        return None  # not yet acquired
    (x0, y0), (x1, y1) = pts[0], pts[1]
    dx = (x1 - x0) % m
    inv = pow(dx, -1, m) if _coprime(dx, m) else None
    if inv is None:
        return None
    a = ((y1 - y0) * inv) % m
    b = (y0 - a * x0) % m
    return (a * x + b) % m


def _coprime(a: int, m: int) -> bool:
    while m:
        a, m = m, a % m
    return a == 1


# ── the harness ──────────────────────────────────────────────────────────────────
@dataclass
class RunResult:
    steps: list = field(default_factory=list)  # [{skill, exposure_idx, correct}]

    def accuracy(self) -> float:
        return sum(s["correct"] for s in self.steps) / len(self.steps) if self.steps else 0.0


def run_schedule(schedule, skills_by_id, solve_fn, memory_on: bool) -> RunResult:
    """Play an ordered schedule of (skill_id, x). With memory ON, each skill accumulates its own
    (x, y) history that solve_fn may retrieve; with memory OFF, solve_fn always sees []."""
    memory: dict = {sid: [] for sid in skills_by_id}
    exposure: dict = {sid: 0 for sid in skills_by_id}
    res = RunResult()
    for sid, x in schedule:
        sk = skills_by_id[sid]
        truth = sk.output(x)
        examples = memory[sid] if memory_on else []
        ans = solve_fn(x, examples)
        res.steps.append({"skill": sid, "exposure_idx": exposure[sid], "correct": ans == truth})
        # the environment always reveals the truth afterward — that is the experience to store
        memory[sid].append((x, truth))
        exposure[sid] += 1
    return res


def acquisition_slope(res: RunResult) -> float:
    """Least-squares slope of correctness vs a skill's EXPOSURE index (not wall order). Positive =
    the system does better the more times it has seen the skill = procedural learning."""
    xs = [s["exposure_idx"] for s in res.steps]
    ys = [1.0 if s["correct"] else 0.0 for s in res.steps]
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def massed_schedule(skills, reps: int):
    """All `reps` exposures of a skill back-to-back before the next skill (blocked practice)."""
    return [(sk.sid, _x(sk, r)) for sk in skills for r in range(reps)]


def distributed_schedule(skills, reps: int):
    """Round-robin: one exposure of each skill per round (spaced practice) — the ICCL spacing arm."""
    return [(sk.sid, _x(sk, r)) for r in range(reps) for sk in skills]


def _x(sk, r: int) -> int:
    # distinct, deterministic inputs per (skill, rep); guarantees the >=2-distinct-x acquisition
    return (r * 7 + (ord(sk.sid[-1]) if sk.sid[-1].isdigit() else 0) + int(sk.sid[1:]) * 3) % 97


def retention_probe(skills, solve_fn, spacing: str, reps: int, window: int | None = None):
    """Learn each skill under massed vs distributed practice, then RE-TEST each on a fresh input
    after all training. Retention = accuracy on that delayed re-test — separate from acquisition.

    `window` models a BOUNDED working memory: at probe time only the last `window` GLOBALLY
    inserted experiences are retrievable (older ones evicted). This is where the ICCL spacing
    effect lives: with massed practice a skill's examples are all early and get evicted before the
    probe; with distributed practice they're spread through the schedule, so recent ones survive.
    `window=None` = lossless memory (no spacing effect expected — a valid null)."""
    sbid = {sk.sid: sk for sk in skills}
    sched = distributed_schedule(skills, reps) if spacing == "distributed" else massed_schedule(skills, reps)
    run = run_schedule(sched, sbid, solve_fn, memory_on=True)

    # global insertion order; keep only the last `window` at probe time
    global_mem = [(sid, x, sbid[sid].output(x)) for sid, x in sched]
    retained = global_mem if window is None else global_mem[-window:]
    per_skill: dict = {sk.sid: [] for sk in skills}
    for sid, x, y in retained:
        per_skill[sid].append((x, y))

    correct = 0
    for sk in skills:
        probe_x = (999 + int(sk.sid[1:])) % 97
        ans = solve_fn(probe_x, per_skill[sk.sid])
        correct += (ans == sk.output(probe_x))
    return {"spacing": spacing, "window": window,
            "retention_accuracy": round(correct / len(skills), 4),
            "train_accuracy": round(run.accuracy(), 4)}


def measure(skills, solve_fn, reps: int = 6):
    sbid = {sk.sid: sk for sk in skills}
    dist = distributed_schedule(skills, reps)
    on = run_schedule(dist, sbid, solve_fn, memory_on=True)
    off = run_schedule(dist, sbid, solve_fn, memory_on=False)
    # per-exposure accuracy curve (memory ON) — the headline acquisition curve
    curve = {}
    for s in on.steps:
        curve.setdefault(s["exposure_idx"], []).append(s["correct"])
    acq_curve = {i: round(sum(v) / len(v), 4) for i, v in sorted(curve.items())}
    return {
        "n_skills": len(skills), "reps": reps,
        "acquisition": {
            "slope_memory_on": round(acquisition_slope(on), 4),
            "slope_memory_off": round(acquisition_slope(off), 4),
            "accuracy_memory_on": round(on.accuracy(), 4),
            "accuracy_memory_off": round(off.accuracy(), 4),
            "curve_by_exposure": acq_curve,
            "learned": acquisition_slope(on) > 0.05 and acquisition_slope(off) < 0.02,
        },
        # Spacing under a BOUNDED working memory (half the total experiences retrievable at probe)
        # — the regime where the ICCL spacing effect appears. Distributed practice keeps every
        # skill's examples recent; massed practice strands the early skills outside the window.
        "spacing": {
            "window": (len(skills) * reps) // 2,
            "distributed": retention_probe(skills, solve_fn, "distributed", reps, (len(skills) * reps) // 2),
            "massed": retention_probe(skills, solve_fn, "massed", reps, (len(skills) * reps) // 2),
        },
    }


def main(argv=None):
    skills = make_skills(8)
    report = measure(skills, affine_learner_solve, reps=6)
    report["learner"] = "affine_learner_solve (reference; validates the instrument)"
    report["note"] = ("Acquisition and retention are reported as SEPARATE axes (Burnell dissociation). "
                      "Plug a real-model solve_fn in for the internal-mark row.")

    a = report["acquisition"]
    print("# Skill-acquisition harness (#2783) — reference learner")
    print(f"acquisition slope: memory ON {a['slope_memory_on']:+.3f}  vs  OFF {a['slope_memory_off']:+.3f}")
    print(f"accuracy:          memory ON {a['accuracy_memory_on']:.3f}  vs  OFF {a['accuracy_memory_off']:.3f}")
    print("curve by exposure (memory ON): " + "  ".join(f"{i}:{v}" for i, v in a["curve_by_exposure"].items()))
    print(f"LEARNED (ON rises, OFF flat): {a['learned']}")
    s = report["spacing"]
    print(f"spacing retention: distributed {s['distributed']['retention_accuracy']}  "
          f"vs massed {s['massed']['retention_accuracy']}")

    out = os.path.join("experiments", "results", "skill_acquisition.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=1)
    print("full report ->", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
