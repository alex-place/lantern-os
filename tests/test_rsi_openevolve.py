"""Offline tests for the three-arm RSI harness (experiments/rsi_openevolve).

No network: the end-to-end runs use FakeLLM. Skipped when OpenEvolve is not installed.
"""
import asyncio
import json
import random
import re
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("openevolve")

HERE = Path(__file__).resolve().parent
for cand in (HERE.parent / "experiments" / "rsi_openevolve", HERE / ".." / "experiments" / "rsi_openevolve"):
    if cand.exists():
        sys.path.insert(0, str(cand.resolve()))
        break

from rsi_oe import binpack, sandbox  # noqa: E402
from rsi_oe.gate import Calibration, GateConfig, TaskIssuer, paired_t, welch_t  # noqa: E402
from rsi_oe.improver import (BOUNDS, PromptDB, parse_prediction, seed_improver)  # noqa: E402
from rsi_oe.llm import FakeLLM  # noqa: E402
from rsi_oe.loop import ArmRun, RunConfig, make_child  # noqa: E402


@pytest.fixture(scope="module")
def pool():
    p = sandbox.SandboxPool(1)
    yield p
    p.close()


# ------------------------------------------------------------------ problem and scorer

def test_instances_are_deterministic_and_streams_differ():
    a = binpack.make_instance("s", 3)
    b = binpack.make_instance("s", 3)
    c = binpack.make_instance("t", 3)
    assert np.array_equal(a.items, b.items) and a.family == b.family
    assert not np.array_equal(a.items, c.items) or a.family != c.family
    assert a.items.min() >= 1 and a.items.max() <= binpack.CAPACITY
    assert a.lb == -(-int(a.items.sum()) // binpack.CAPACITY)


def test_forbidden_stream_cannot_be_generated():
    binpack.FORBIDDEN_STREAMS.add("holdout")
    try:
        with pytest.raises(binpack.ForbiddenStream):
            binpack.make_instance("holdout", 0)
    finally:
        binpack.FORBIDDEN_STREAMS.discard("holdout")


def test_verify_rejects_overfull_and_out_of_order():
    inst = binpack.make_instance("v", 0)
    assign, n = binpack.pack(inst.items, inst.capacity, binpack.best_fit_priority)
    assert binpack.verify_assignment(inst, assign) == n
    with pytest.raises(ValueError):
        binpack.verify_assignment(inst, np.zeros_like(assign))          # everything in one bin
    bad = assign.copy()
    bad[0] = 5
    with pytest.raises(ValueError):
        binpack.verify_assignment(inst, bad)                             # opens bin 5 first


def test_best_fit_scores_zero(pool):
    insts = binpack.make_instances("bf", range(6))
    out = pool.run(binpack.SEED_PROGRAM, insts, 60)
    assert out.ok, out.error
    m = binpack.summarize(insts, [out.bins[i.key] for i in insts])
    assert m["combined_score"] == 0.0


# ------------------------------------------------------------------ sandbox

@pytest.mark.parametrize("code,needle", [
    ("import os\ndef priority(item, bins):\n    return bins\n", "import os"),
    ("import numpy as np\ndef priority(item, bins):\n    return np.random.rand(len(bins))\n", ".random"),
    ("def priority(item, bins):\n    return bins.__class__\n", "__class__"),
    ("def priority(item, bins):\n    g = (x for x in [1])\n    return g.gi_frame\n", "gi_frame"),
    ("import numpy as np\nnp.argmax = None\ndef priority(item, bins):\n    return bins\n", "module np"),
    ("def priority(item, bins):\n    return open('x')\n", "open"),
    ("def helper(item, bins):\n    return bins\n", "no top-level function"),
])
def test_static_check_rejects(code, needle):
    with pytest.raises(sandbox.CodeRejected) as exc:
        sandbox.check_code(code)
    assert needle in str(exc.value)


def test_runtime_caps(pool):
    insts = binpack.make_instances("cap", range(2))
    hog = "import numpy as np\ndef priority(item, bins):\n    x = np.ones(10**10)\n    return bins\n"
    assert "MemoryError" in pool.run(hog, insts, 30).error
    loop = "def priority(item, bins):\n    while True:\n        pass\n"
    assert "timeout" in pool.run(loop, insts, 5).error
    assert pool.run(binpack.SEED_PROGRAM, insts, 30).ok    # the pool recovers


def test_child_env_carries_no_keys(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")
    env = sandbox._child_env()
    assert not any("KEY" in k or "TOKEN" in k or "SECRET" in k for k in env)


# ------------------------------------------------------------------ gate and budget rule

def test_issuer_never_reissues_and_refuses_holdout(tmp_path):
    iss = TaskIssuer("fresh0", tmp_path / "ledger.jsonl")
    a = iss.draw(5, "promotion", 1)
    iss.burn(a, 1)
    b = iss.draw(5, "promotion", 1)
    assert not {i.idx for i in a} & {i.idx for i in b}
    assert set(iss.burned) == {i.idx for i in a}
    with pytest.raises(ValueError):
        TaskIssuer("holdout", tmp_path / "x.jsonl")


def test_t_statistics():
    assert paired_t(np.array([1.0, 1.0, 1.0])) == float("inf")
    assert paired_t(np.array([0.0, 0.0])) == 0.0
    assert paired_t(np.array([1.0, -1.0, 0.0, 0.0])) == 0.0
    assert welch_t(np.array([1.0, 2.0, 3.0]), np.array([0.0, 0.0, 0.0])) > 2.0


def test_calibration_caps_budget():
    c = Calibration(window=30, min_n=10)
    assert c.k_cap() == 3                                  # no cap before min_n
    rng = np.random.default_rng(0)
    for _ in range(30):
        c.add(2.0, float(rng.normal(-0.2, 0.3)))           # overconfident, uninformative
    assert c.skill() < 0 and c.k_cap() == 1
    good = Calibration(window=30, min_n=10)
    for _ in range(30):
        a = float(rng.normal(0, 1))
        good.add(a, a)                                     # perfect predictions
    assert good.skill() == pytest.approx(1.0) and good.k_cap() == 3


def test_gate_config_is_frozen():
    cfg = GateConfig()
    with pytest.raises(Exception):
        cfg.t_min = 0.0


# ------------------------------------------------------------------ improver pieces

def test_parse_prediction():
    assert parse_prediction("blah\nPREDICTED_DELTA: +0.35") == pytest.approx(0.35)
    assert parse_prediction("PREDICTED_DELTA: -1e-1") == pytest.approx(-0.1)
    assert parse_prediction("no number here") is None


def test_improver_clipping_bounds():
    imp = seed_improver()
    d = imp.to_dict()
    d.update(k_base=99, temperature=-5, exploration=0.9, exploitation=0.9, proposer="x" * 9999)
    from rsi_oe.improver import Improver
    c = Improver.from_dict(d).clipped()
    assert c.k_base == BOUNDS["k_base"][1]
    assert c.temperature == BOUNDS["temperature"][0]
    assert c.exploration + c.exploitation <= 1.0 + 1e-9
    assert len(c.proposer) <= 1500


def test_prompt_db_prefers_untried_then_best():
    db = PromptDB("seed text")
    db.entries["p1"] = type(db.entries["p0"])("p1", "other", "p0", 1)
    for _ in range(5):
        db.credit("p0", 0.1)
    assert db.select().pid == "p1"                         # untried gets the UCB bonus
    for _ in range(5):
        db.credit("p1", -1.0)
    assert db.select().pid == "p0"


def test_make_child_uses_openevolve_diff_rules():
    parent = binpack.SEED_PROGRAM
    good = ("<<<<<<< SEARCH\n    return -(bins - item)\n=======\n"
            "    return -(bins - item) + 0.5 * (bins == 150)\n>>>>>>> REPLACE\nPREDICTED_DELTA: 0.1")
    code, err, _ = make_child(parent, good)
    assert code is not None and "0.5" in code and not err
    code, err, _ = make_child(parent, "<<<<<<< SEARCH\nnot in parent\n=======\nx\n>>>>>>> REPLACE")
    assert code is None and "matched" in err
    evil = good.replace("+ 0.5 * (bins == 150)", "+ __import__('os').getpid()")
    code, err, _ = make_child(parent, evil)
    assert code is None and "rejected" in err


# ------------------------------------------------------------------ end to end, offline

def _fake_script(seed: int):
    rnd = random.Random(seed)

    def script(system, user, purpose, temperature):
        if purpose == "proposal":
            m = re.search(r"# Current Program\n```python\n(.*?)\n```", user, re.DOTALL)
            code = m.group(1) if m else binpack.SEED_PROGRAM
            ret = [ln for ln in code.splitlines() if ln.strip().startswith("return")][-1]
            c, g = rnd.uniform(-3, 3), rnd.randint(1, 15)
            new = rnd.choice([
                f"    return -(bins - item) + {c:.3f} * (bins == 150)",
                f"    return -(bins - item) + {c:.3f} * ((bins - item) < {g})",
                f"    return -(bins - item) - {abs(c):.3f} * np.maximum(bins - item - {g}, 0) / 10",
            ])
            if rnd.random() < 0.15:
                return "I could not find a change."               # an invalid proposal
            return (f"<<<<<<< SEARCH\n{ret}\n=======\n{new}\n>>>>>>> REPLACE\n"
                    f"PREDICTED_DELTA: {rnd.uniform(-1, 2):.3f}")
        if purpose == "meta_analyzer":
            t = rnd.choice(["analysis", "retrieval", "allocation", "proposer", "editor"])
            return json.dumps({"target": t, "diagnosis": "few children kept", "tags": ["stagnation"]})
        if purpose == "meta_allocator":
            return json.dumps({"k_base": rnd.randint(1, 3), "k_widen": 1, "temperature": 0.8,
                               "exploration": 0.2, "exploitation": 0.6})
        if purpose == "meta_proposer":
            return "Ask for changes that avoid leaving small unusable gaps."
        if purpose == "meta_evolver":
            if "Component: retrieval" in user:
                return '<component>{"num_top": 2, "num_diverse": 1} Use the best programs.</component>'
            return "<component>Prefer placements that leave either no gap or a large gap.</component>"
        if purpose == "prompt_mutation":
            return "<instructions>Improve the bin-packing priority function. Use SEARCH/REPLACE.</instructions>"
        return ""
    return script


def _run(arm, tmp_path, gens, seed=0):
    cfg = RunConfig(arm=arm, seed=seed, out=str(tmp_path / f"arm{arm}"), gens=gens, model="fake")
    run = ArmRun(cfg, llm=FakeLLM(_fake_script(seed + 10 * arm)))
    return asyncio.run(run.run()), Path(cfg.out)


@pytest.mark.parametrize("arm", [1, 2, 3])
def test_arm_runs_offline_with_equal_calls(arm, tmp_path):
    summary, out = _run(arm, tmp_path, gens=2)
    calls = summary["usage"]["calls"]
    assert calls == 2 * 24, summary["usage"]                     # equal compute per generation
    rows = [json.loads(ln) for ln in (out / "children.jsonl").read_text().splitlines()]
    assert len(rows) == (2 * 23 if arm == 1 else 2 * 20)
    assert any(r["valid"] for r in rows)
    snap = json.loads((out / "snapshots" / "gen_002.json").read_text())
    assert snap["champion"]["hash"]
    assert (out / "programs" / f"{snap['champion']['hash']}.py").exists()
    if arm == 3:
        led = [json.loads(ln) for ln in (out / "ledger.jsonl").read_text().splitlines()]
        draws = [r for r in led if r["event"] == "draw"]
        spans = sorted((r["ids"][0], r["ids"][1]) for r in draws)
        assert all(b[0] > a[1] for a, b in zip(spans, spans[1:]))  # fresh ids never reused
        gate = [json.loads(ln) for ln in (out / "gate.jsonl").read_text().splitlines()]
        assert any(g["kind"] == "improver" for g in gate)          # gen 2 tested gen 1's edit
        assert all(r["k"] <= r["k_cap"] for r in rows if r["k_cap"])


def test_resume_continues_from_last_generation(tmp_path):
    _run(2, tmp_path, gens=1)
    summary, out = _run(2, tmp_path, gens=2)
    assert [h["gen"] for h in summary["history"]] == [1, 2]
    rows = [json.loads(ln) for ln in (out / "children.jsonl").read_text().splitlines()]
    assert len(rows) == 40


def test_measurement_pipeline_offline(tmp_path, monkeypatch):
    """Runs -> successor test -> holdout scoring -> pre-registered analysis, all offline."""
    from rsi_oe import analyze, measure, successor
    monkeypatch.setattr(measure, "HOLDOUT_N", 12)
    root = tmp_path / "runs"
    for arm in (1, 2, 3):
        for seed in (0, 1):
            cfg = RunConfig(arm=arm, seed=seed, out=str(root / f"arm{arm}_s{seed}"), gens=2, model="fake")
            asyncio.run(ArmRun(cfg, llm=FakeLLM(_fake_script(seed + 10 * arm))).run())
            res = asyncio.run(successor.run_successor(Path(cfg.out), [1, 2],
                                                      FakeLLM(_fake_script(99 + seed))))
            assert res["rows"] > 0
    binpack.FORBIDDEN_STREAMS.discard("holdout")   # measurement may read the holdout
    m = measure.measure(root, workers=2)
    assert m["runs"] == 6 and m["measured_now"] > 0
    rc = analyze.main([str(root)])
    assert rc == 0
    res = json.loads((root / "results.json").read_text())
    for r in res["runs"]:
        assert r["final_holdout"] is not None
        assert all(p["holdout"] is not None for p in r["per_gen"])
        assert any(k.endswith(":ref_v_g") for k in r["successor"])
    assert "kill" in res["tests"] and "H1_arm2_gap_grows" in res["tests"]
    assert (root / "results.md").read_text().startswith("| Measure")


def test_breaker_stops_after_a_run_of_failed_calls():
    from rsi_oe.llm import ProviderUnavailable
    replies = iter([None] * 7 + ["ok"] + [None] * 8)
    llm = FakeLLM(lambda s, u, p, t: next(replies))
    for _ in range(15):                 # seven failures, a success resets the count, seven more
        asyncio.run(llm.chat("s", "u", "proposal"))
    with pytest.raises(ProviderUnavailable):
        asyncio.run(llm.chat("s", "u", "proposal"))


def test_successor_records_nothing_for_a_failed_call(tmp_path):
    """A failed call is not an invalid child: its group is left for the next pass."""
    from rsi_oe import successor
    _, out = _run(1, tmp_path, gens=1)
    healthy = _fake_script(5)

    def as_proposal(s, u, p, t):
        return healthy(s, u, "proposal", t)

    n = {"calls": 0}

    def fails_second_call(s, u, p, t):
        n["calls"] += 1
        return None if n["calls"] == 2 else as_proposal(s, u, p, t)

    with pytest.raises(successor.CallFailed):
        asyncio.run(successor.run_successor(out, [1], FakeLLM(fails_second_call)))
    path = out / "successor.jsonl"
    assert not path.exists() or not path.read_text().strip()
    res = asyncio.run(successor.run_successor(out, [1], FakeLLM(as_proposal)))
    rows = [json.loads(ln) for ln in path.read_text().splitlines()]
    assert res["rows"] == len(rows) > 0
    sizes = {}
    for r in rows:
        sizes[r["variant"]] = sizes.get(r["variant"], 0) + 1
    assert sizes["ref_v_g"] == sizes["ref_v_0"] == 8
    assert sizes["own_v_g"] == sizes["own_v_0"] >= 2


def test_kill_without_successor_data():
    """With no successor test, H3 is "not measured"; the kill is settled only when its
    holdout half is unmatched, because it fires only if both halves match."""
    from rsi_oe import analyze

    def runs(arm3_auc):
        out = []
        for arm, aucs in ((2, [0.0, 0.01, 0.02, 0.03, 0.04]), (3, arm3_auc)):
            for i, auc in enumerate(aucs):
                out.append({"arm": arm, "gap_slope": 0.01 * i, "gap_early": 0.0, "gap_late": 0.1,
                            "auc_holdout": auc, "succ_ref_q_per_1k_late": None,
                            "succ_ref_q_per_1k_all": None, "successor": {}})
        return out

    unmatched = analyze.tests(runs([-1.0, 1.6, -0.5, 1.2, 0.2]))   # +0.28 pp, not significant
    assert unmatched["H3_arm3_better_successors_late"]["status"] == "not measured"
    assert unmatched["kill"]["holdout_auc"]["verdict"] == "inconclusive"
    assert unmatched["kill"]["fires"] is False
    matched = analyze.tests(runs([0.0, 0.02, 0.04, 0.01, 0.03]))   # same mean as arm 2
    assert matched["kill"]["holdout_auc"]["verdict"] == "match"
    assert matched["kill"]["fires"] is None


def _rows(out: Path):
    drop = {"llm_seconds", "eval_seconds"}
    return [{k: v for k, v in json.loads(ln).items() if k not in drop}
            for ln in (out / "children.jsonl").read_text().splitlines()]


def _strip_ids(rows):
    # program ids are uuid4 (fresh per process run); compare everything else
    return [{k: v for k, v in r.items() if k not in ("child_id", "parent_id")} for r in rows]


def test_concurrent_runs_keep_their_own_random_streams(tmp_path):
    """Runs sharing one process and one sandbox pool give the same logs as runs alone."""
    def cfgs(root):
        return [RunConfig(arm=a, seed=0, out=str(root / f"arm{a}"), gens=2, model="fake") for a in (1, 2, 3)]

    async def together(root):
        p = sandbox.SandboxPool(2)
        try:
            runs = [ArmRun(c, llm=FakeLLM(_fake_script(10 * c.arm)), pool=p) for c in cfgs(root)]
            await asyncio.gather(*(r.run() for r in runs))
        finally:
            p.close()

    asyncio.run(together(tmp_path / "a"))
    asyncio.run(together(tmp_path / "b"))
    for c in cfgs(tmp_path / "alone"):
        asyncio.run(ArmRun(c, llm=FakeLLM(_fake_script(10 * c.arm))).run())
    for arm in (1, 2, 3):
        a = _strip_ids(_rows(tmp_path / "a" / f"arm{arm}"))
        b = _strip_ids(_rows(tmp_path / "b" / f"arm{arm}"))
        alone = _strip_ids(_rows(tmp_path / "alone" / f"arm{arm}"))
        assert a == b == alone, f"arm {arm} diverged"
