"""
The Oracle active loop (ACT-TO-KNOW) — the fifth move, first real brick.

Certificate Part IV / Oracle design §7: *passive* grounding (inference from a fixed
corpus) ceilings at the ideal inductive predictor (Solomonoff/AIXI) — it reaches
everything inferable from the data and no more, and that ceiling is unbeatable BY
INFERENCE. *Active* grounding manufactures a fact no corpus contained by executing an
action and reading reality's answer, so it escapes the ceiling where an action resolves.

This harness runs that loop on the cheapest, most reversible ground-truth surface the
design mandates first: **local code execution** — no money, fully undoable. The
money/irreversible surfaces (Kalshi, etc.) stay behind the design's authority gates and
are deliberately NOT touched here.

Each question carries:
  - `act`      — executes real code NOW and returns reality's answer (the ground truth);
  - `passive`  — the best an inference-only predictor offers, recorded as the pre-action
                 belief (here a frozen heuristic prior, honestly labeled; a real frontier
                 model is the stronger next rung — see "Honest scope" below);
  - `inference_reachable` — False when the answer is live-state or a computation that no
                 fixed text corpus can contain (only acting resolves it);
  - `actionable` — False when no action can resolve it now → a boundary `pin`.

Classification per question (the Oracle's four-way verdict, resolved by action):
  pin           — no action can resolve it. Named, never bluffed (resolved stays None).
  confirmed     — the action agreed with the passive belief (inference was already right).
  ceiling_break — the action produced a fact the passive baseline got WRONG, or that was
                  not inference-reachable at all. A corpus-absent fact manufactured by
                  action — THIS is the measured quantity.

Honest scope. This proves the MECHANISM — action manufactures corpus-absent facts,
recorded in the grounding discipline (`[claim, evidence, confidence→1.0, source]`) — on a
real surface. The `inference_reachable=False` count is rigorous by construction: those
facts are live-state / computation, provably not retrievable from any fixed corpus,
regardless of any baseline. The baseline-correction count (on inference-reachable
questions) is baseline-dependent and reported separately. What this does NOT prove: that
the active loop beats a frontier model at a task — that needs the model-in-the-loop run,
the next rung. No novelty is claimed; the mechanism is Bayesian optimal experimental
design / value of information / active inference (Lindley 1956; Howard 1966; Friston 2010).

Run:  python experiments/oracle_active_loop.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Question:
    """One question the active loop can resolve by acting."""
    id: str
    text: str
    act: Callable[[], Any]                 # execute real code NOW → reality's answer
    passive: Optional[Any] = None          # best inference-only belief (None = no prior)
    passive_conf: float = 0.0              # the predictor's confidence in `passive`
    inference_reachable: bool = True       # False = live-state/computation, corpus-absent
    actionable: bool = True                # False = no action resolves it now → pin
    note: str = ""


def classify(q: "Question", resolved: Any) -> str:
    """The four-way verdict, decided by what the action returned. Pure — unit-tested."""
    if not q.actionable:
        return "pin"
    if not q.inference_reachable:
        # A live-state or computation fact: no fixed corpus could contain it, so knowing
        # it at all is a ceiling-break, independent of any baseline. This is the rigorous
        # core of the measurement.
        return "ceiling_break"
    if q.passive is not None and str(q.passive) == str(resolved):
        return "confirmed"
    # Inference had a belief and reality overruled it (or it had none): baseline-dependent
    # ceiling-break — action produced knowledge inference lacked.
    return "ceiling_break"


def run_active_loop(questions: List["Question"], stamp: str = "") -> List[dict]:
    """Walk each question through ACT-TO-KNOW, returning grounded resolution records."""
    records: List[dict] = []
    for q in questions:
        if not q.actionable:
            records.append({
                "id": q.id, "question": q.text, "class": "pin",
                "passive_belief": q.passive, "passive_conf": q.passive_conf,
                "resolved": None, "resolved_conf": None,
                "inference_reachable": q.inference_reachable,
                "unknown": q.text, "source": "none (structurally unactionable)",
                "surface": "local-code", "note": q.note, "stamp": stamp,
            })
            continue
        resolved = q.act()
        cls = classify(q, resolved)
        records.append({
            "id": q.id, "question": q.text, "class": cls,
            "passive_belief": q.passive, "passive_conf": q.passive_conf,
            "resolved": resolved, "resolved_conf": 1.0,   # reality answered — certain
            "inference_reachable": q.inference_reachable,
            "source": "execution", "surface": "local-code", "note": q.note, "stamp": stamp,
        })
    return records


def summarize(records: List[dict]) -> dict:
    n = len(records)
    breaks = [r for r in records if r["class"] == "ceiling_break"]
    corpus_absent = [r for r in breaks if r["inference_reachable"] is False]
    baseline_corrected = [r for r in breaks if r["inference_reachable"] is True]
    return {
        "questions": n,
        "confirmed": sum(1 for r in records if r["class"] == "confirmed"),
        "pins": sum(1 for r in records if r["class"] == "pin"),
        "ceiling_breaks_total": len(breaks),
        "ceiling_breaks_corpus_absent_rigorous": len(corpus_absent),
        "ceiling_breaks_baseline_corrected": len(baseline_corrected),
    }


# ── The seed question set — real, live-state / computation, on the code surface ──
# Every `act` executes real code against THIS repo/environment right now. The
# corpus-absent ones are facts no fixed training corpus could hold (current git state,
# current file counts, a hash you must compute) — resolvable only by acting.

def _git_short_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True,
            stderr=subprocess.DEVNULL).strip()
    except Exception as e:  # pragma: no cover - environment-dependent
        return f"<git unavailable: {e}>"


def _count_py(rel: str) -> int:
    return sum(1 for _ in (REPO_ROOT / rel).glob("*.py"))


def _line_count(rel: str) -> int:
    p = REPO_ROOT / rel
    return len(p.read_text(encoding="utf-8", errors="ignore").splitlines()) if p.exists() else -1


def seed_questions() -> List["Question"]:
    return [
        Question(
            id="git-sha",
            text="What is the repo's current git HEAD short SHA?",
            act=_git_short_sha,
            passive=None, passive_conf=0.0, inference_reachable=False,
            note="Live VCS state — no corpus frozen in the past can contain the current SHA."),
        Question(
            id="cio-py-count",
            text="How many .py files are directly under src/cio_sde/?",
            act=lambda: _count_py("src/cio_sde"),
            passive=8, passive_conf=0.3, inference_reachable=False,
            note="Current filesystem state; passive is a reasonable prior, action resolves."),
        Question(
            id="sha256-fixed",
            text="What is sha256('act-to-know') (first 12 hex)?",
            act=lambda: hashlib.sha256(b"act-to-know").hexdigest()[:12],
            passive=None, passive_conf=0.0, inference_reachable=False,
            note="Deterministic computation — knowable only by computing (acting), not by retrieval."),
        Question(
            id="cert-partiv-present",
            text="Does the collapse certificate currently contain a '# Part IV' heading?",
            act=lambda: (REPO_ROOT / "docs/SIGMA0-COLLAPSE-CERTIFICATE.md").read_text(
                encoding="utf-8", errors="ignore").find("# Part IV") >= 0,
            passive=False, passive_conf=0.6, inference_reachable=False,
            note="Current doc state; a corpus predating today would answer False — action corrects."),
        Question(
            id="oracle-line-count",
            text="How many lines is docs/CONVERGENCE-ORACLE-DESIGN.md right now?",
            act=lambda: _line_count("docs/CONVERGENCE-ORACLE-DESIGN.md"),
            passive=120, passive_conf=0.2, inference_reachable=False,
            note="Current file length; live state."),
        Question(
            id="pin-future-run",
            text="Will the next autowork run on issue #2762 pass its tests?",
            act=lambda: None, actionable=False,
            note="A boundary pin — an un-run future action; no action available NOW resolves it. "
                 "Named, never bluffed (this is the Oracle's `pin` class)."),
    ]


def main() -> int:
    from datetime import datetime, timezone
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    records = run_active_loop(seed_questions(), stamp=stamp)
    summary = summarize(records)

    out_dir = REPO_ROOT / "data" / "oracle"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "active-loop-runs.jsonl"
    with out.open("a", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
        fh.write(json.dumps({"summary": summary, "stamp": stamp}) + "\n")

    # ASCII-only console output (Windows cp1252-safe); the JSONL file keeps full unicode.
    print(f"ACT-TO-KNOW active loop - {stamp}")
    print(f"  surface: local-code (cheapest, reversible; money surfaces stay gated)")
    for r in records:
        if r["class"] == "pin":
            print(f"  [pin]           {r['id']}: {r['question']}  -> named, unresolved")
        else:
            print(f"  [{r['class']:<13}] {r['id']}: resolved = {r['resolved']!r}  "
                  f"(passive belief: {r['passive_belief']!r})")
    print("summary:", json.dumps(summary))
    print(f"  -> {summary['ceiling_breaks_corpus_absent_rigorous']} corpus-absent facts "
          f"manufactured by action (rigorous); {summary['pins']} pin named, not bluffed.")
    print(f"records appended: {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
