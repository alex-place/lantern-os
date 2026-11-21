"""Equal-budget successor test (Yang, arXiv:2607.12254 §13.2), run from saved snapshots.

"Does the updated improvement mechanism produce better descendants than the prior one
under equal budgets?" At each test generation g this asks it two ways, as a measurement
outside every arm's budget (nothing here feeds back into a run):

own      from the arm's own population at g: the 8 programs it believes best are each
         given one proposal by v_g, by v_{g-1} and by v_0 (equal budget: 8 each).
         v_g is the improver the arm would use next. For arm 1 an "improver" is the
         instruction text its PromptDB would pick next.
ref      from 8 fixed reference parents shared by every arm and seed: one proposal each
         by v_g (and once per run by v_0). Comparable across arms because the parents
         are the same.

Children are only generated and stored here. `measure.py` scores parents and children
on the final holdout; descendant quality is max(0, child - parent) there, so what is
measured is the improvement a correct gate could keep from each proposal.

A call that fails is not a proposal. The group it belongs to is not recorded, and the
next run of this test asks again; a failed call would otherwise count as an invalid child.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List, Optional

import numpy as np
from openevolve.database import Program

from . import binpack, sandbox
from .evaluation import Evaluator
from .improver import Improver, seed_improver
from .llm import LLM, Ledger
from .loop import Prompter, make_child

REFERENCE_PROGRAMS = {
    "best_fit": binpack.SEED_PROGRAM,
    "first_fit": "import numpy as np\n\n\ndef priority(item, bins):\n"
                 "    # First fit: the earliest bin that fits.\n"
                 "    return -np.arange(len(bins), dtype=float)\n",
    "bf_new_bin_penalty": "import numpy as np\n\n\ndef priority(item, bins):\n"
                          "    return -(bins - item) - 5.0 * (bins == 150)\n",
    "worst_open_fit": "import numpy as np\n\n\ndef priority(item, bins):\n"
                      "    r = bins - item\n    return np.where(bins == 150, -1e6, r)\n",
    "exact_fit_bonus": "import numpy as np\n\n\ndef priority(item, bins):\n"
                       "    r = bins - item\n    return -r + 10.0 * (r == 0)\n",
    "gap_avoid": "import numpy as np\n\n\ndef priority(item, bins):\n"
                 "    r = bins - item\n    return -r - 3.0 * ((r > 0) & (r < 8))\n",
    "log_fit": "import numpy as np\n\n\ndef priority(item, bins):\n"
               "    r = bins - item\n    return -np.log1p(r) - 2.0 * (bins == 150)\n",
    "quadratic": "import numpy as np\n\n\ndef priority(item, bins):\n"
                 "    r = bins - item\n    return -(r ** 2) / 100.0\n",
}
N_PARENTS = 8


class CallFailed(RuntimeError):
    """A successor-test call failed; nothing is recorded for its group."""


def _improver_view(arm: int, snap: dict, improvers: Dict[str, dict]) -> dict:
    """What the arm would use next: system text, retrieval counts, temperature."""
    if arm == 1:
        pdb = snap["prompt_db"]
        text = pdb[snap["prompt_choice"]]["text"]
        return {"id": snap["prompt_choice"], "system": text, "num_top": 3, "num_diverse": 2,
                "temperature": 0.7}
    imp = Improver.from_dict(improvers[snap["improver"]])
    return {"id": imp.vid, "system": imp.system_message(), "num_top": imp.num_top,
            "num_diverse": imp.num_diverse, "temperature": imp.temperature}


def _seed_view() -> dict:
    imp = seed_improver()
    return {"id": "v0", "system": imp.system_message(), "num_top": imp.num_top,
            "num_diverse": imp.num_diverse, "temperature": imp.temperature}


def _db_from(programs: List[Program]) -> SimpleNamespace:
    islands = [set() for _ in range(3)]
    for p in programs:
        islands[int(p.metadata.get("island") or 0) % 3].add(p.id)
    return SimpleNamespace(programs={p.id: p for p in programs}, islands=islands,
                           config=SimpleNamespace(feature_dimensions=["complexity", "diversity"]))


def _reference_population(ev: Evaluator) -> List[Program]:
    insts = binpack.make_instances("refmetrics", range(16))
    out = []
    for name, code in REFERENCE_PROGRAMS.items():
        ok, metrics, err = ev.metrics(code, insts)
        if not ok:
            raise RuntimeError(f"reference program {name} failed: {err}")
        out.append(Program(id=f"ref:{name}", code=code, metrics=metrics, metadata={"island": 0}))
    return out


async def _proposals(llm, prompter: Prompter, db, parents: List[Program], view: dict, tag: str,
                     gen: int, rng: np.random.Generator, out: Path) -> List[dict]:
    rows = []
    for parent in parents:
        others = [p for p in db.programs.values() if p.id != parent.id]
        pick = rng.choice(len(others), size=min(2, len(others)), replace=False) if others else []
        insp = [others[int(i)] for i in pick]
        island = int(parent.metadata.get("island") or 0) % 3
        # the prompt sampler draws from the global `random`: seed it per proposal so the
        # test is deterministic even when many runs share a process
        random.seed(f"successor/{tag}/{gen}/{parent.id}")
        prompt = prompter.build(db, parent, insp, island, gen, view["system"], view["num_top"],
                                view["num_diverse"])
        text, usage = await llm.chat(prompt["system"], prompt["user"], "successor",
                                     temperature=view["temperature"])
        if text is None:
            raise CallFailed(f"{tag} gen {gen} parent {parent.id}: model call failed")
        code, err, _ = make_child(parent.code, text)
        row = {"gen": gen, "variant": tag, "improver": view["id"],
               "parent_id": parent.id, "parent_hash": sandbox.code_hash(parent.code),
               "child_hash": None, "valid": code is not None, "error": err[:200],
               "prompt_tokens": (usage or {}).get("prompt_tokens", 0),
               "completion_tokens": (usage or {}).get("completion_tokens", 0)}
        for c in (parent.code, code):
            if c is not None:
                p = out / "programs" / f"{sandbox.code_hash(c)}.py"
                if not p.exists():
                    p.write_text(c, encoding="utf-8")
        if code is not None:
            row["child_hash"] = sandbox.code_hash(code)
        rows.append(row)
    return rows


async def run_successor(run_dir: Path, gens: List[int], llm, seed_offset: int = 0,
                        pool: Optional[sandbox.SandboxPool] = None) -> dict:
    run_dir = Path(run_dir)
    binpack.FORBIDDEN_STREAMS.add("holdout")
    cfg = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    arm = cfg["arm"]
    improvers = {}
    for ln in (run_dir / "improvers.jsonl").read_text(encoding="utf-8").splitlines():
        if ln.strip():
            d = json.loads(ln)
            improvers[d["vid"]] = d
    done_path = run_dir / "successor.jsonl"
    done = set()
    if done_path.exists():
        for ln in done_path.read_text(encoding="utf-8").splitlines():
            if ln.strip():
                r = json.loads(ln)
                done.add((r["gen"], r["variant"]))
    prompter = Prompter()
    own_pool = pool is None
    pool = pool or sandbox.SandboxPool(1)
    ev = Evaluator(pool)
    ref_pop = _reference_population(ev)
    ref_db = _db_from(ref_pop)
    rows_all = []

    def emit(rows):
        with done_path.open("a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        rows_all.extend(rows)

    try:
        for g in gens:
            snap_p = run_dir / "snapshots" / f"gen_{g:03d}.json"
            prev_p = run_dir / "snapshots" / f"gen_{g - 1:03d}.json"
            if not snap_p.exists() or not prev_p.exists():
                continue
            snap = json.loads(snap_p.read_text(encoding="utf-8"))
            prev = json.loads(prev_p.read_text(encoding="utf-8"))
            rng = np.random.default_rng([cfg["seed"], arm, g, 13 + seed_offset])
            progs = []
            for d in snap["programs"]:
                code = (run_dir / "programs" / f"{d['hash']}.py").read_text(encoding="utf-8")
                progs.append(Program(id=d["id"], code=code, metrics=d["metrics"],
                                     metadata={"island": d["island"]}))
            db = _db_from(progs)
            parents = sorted(progs, key=lambda p: (-p.metrics.get("combined_score", 0.0), p.id))[:N_PARENTS]
            v_g, v_prev, v_0 = _improver_view(arm, snap, improvers), _improver_view(arm, prev, improvers), _seed_view()
            plan = [("own_v_g", v_g, db, parents)]
            if v_prev["id"] != v_g["id"] or v_prev["system"] != v_g["system"]:
                plan.append(("own_v_prev", v_prev, db, parents))
            plan.append(("own_v_0", v_0, db, parents))
            plan.append(("ref_v_g", v_g, ref_db, ref_pop))
            if g == gens[0]:
                plan.append(("ref_v_0", v_0, ref_db, ref_pop))
            for tag, view, the_db, the_parents in plan:
                if (g, tag) in done:
                    continue
                rows = await _proposals(llm, prompter, the_db, the_parents, view, tag, g,
                                        np.random.default_rng([cfg["seed"], arm, g, len(tag)]),
                                        run_dir)
                emit(rows)
    finally:
        if own_pool:
            pool.close()
    return {"rows": len(rows_all), "usage": llm.ledger.totals(getattr(llm, "model", "?"))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Equal-budget successor test from snapshots")
    ap.add_argument("run_dir")
    ap.add_argument("--gens", default="5,10,15,20,25,30")
    ap.add_argument("--model", default=None)
    ap.add_argument("--provider", default="openai")
    a = ap.parse_args(argv)
    cfg = json.loads((Path(a.run_dir) / "config.json").read_text(encoding="utf-8"))
    led = Ledger()
    llm = LLM(a.model or cfg["model"], a.provider, temperature=0.7, max_tokens=cfg["max_tokens"], ledger=led)
    res = asyncio.run(run_successor(Path(a.run_dir), [int(x) for x in a.gens.split(",")], llm))
    (Path(a.run_dir) / "successor_usage.json").write_text(json.dumps(res["usage"], indent=2))
    print(json.dumps({"run": a.run_dir, **res["usage"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
