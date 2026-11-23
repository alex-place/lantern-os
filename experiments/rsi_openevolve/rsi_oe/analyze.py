"""Pre-registered analysis (PREREGISTRATION.md §6): per-generation measures, per-arm
summaries over seeds with intervals, the three hypothesis tests and the kill condition.

Units: every score is bins saved against best fit, in percent of the L1 lower bound
("pp"); higher is better and best fit is 0. Seeds are the independent units.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from scipy import stats

from .measure import HoldoutCache, _sampled, holdout_instances, holdout_scores

EARLY_MAX, LATE_MIN = 10, 21          # generations 1-10 vs 21-30
SESOI_HOLDOUT = 0.10                  # pp: smallest holdout difference that matters
SESOI_SUCCESSOR_REL = 0.20            # 20% of arm 2's successor quality per 1k tokens
ALPHA = 0.05


def _jsonl(path: Path) -> List[dict]:
    if not path.exists():
        return []
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def t_ci(x, conf=0.95):
    x = np.asarray([v for v in x if v is not None and np.isfinite(v)], dtype=float)
    if len(x) == 0:
        return {"n": 0, "mean": None, "lo": None, "hi": None, "sd": None}
    m = float(x.mean())
    if len(x) == 1:
        return {"n": 1, "mean": m, "lo": None, "hi": None, "sd": None}
    sd = float(x.std(ddof=1))
    h = float(stats.t.ppf(0.5 + conf / 2, len(x) - 1) * sd / math.sqrt(len(x)))
    return {"n": len(x), "mean": m, "lo": m - h, "hi": m + h, "sd": sd}


def one_sided_greater(a, b=None):
    a = [v for v in a if v is not None and np.isfinite(v)]
    if b is None:
        if len(a) < 2:
            return None
        return float(stats.ttest_1samp(a, 0.0, alternative="greater").pvalue)
    b = [v for v in b if v is not None and np.isfinite(v)]
    if len(a) < 2 or len(b) < 2:
        return None
    return float(stats.ttest_ind(a, b, equal_var=False, alternative="greater").pvalue)


def _frac(xs):
    return float(np.mean(xs)) if xs else None


def descriptives(d: Path, H, children: List[dict]) -> dict:
    """Counts behind the pre-registered measures, pooled over the run's generations.

    Rejected children are the fixed 15% hash sample that measure.py scores, so the share of
    them that were truly better estimates what each arm's test threw away.
    """
    def true_delta(r):
        c, p = H(r["child_hash"]), H(r["parent_hash"])
        return c - p if c is not None and p is not None else None

    acc = [r for r in children if r.get("accepted") and r.get("child_hash")]
    acc_d = [x for x in map(true_delta, acc) if x is not None]
    rej = [r for r in children if r.get("valid") and r.get("child_hash") and not r.get("accepted")
           and _sampled(r["child_hash"])]
    rej_d = [x for x in map(true_delta, rej) if x is not None]
    out = {"proposals": len(children), "valid": sum(bool(r.get("valid")) for r in children),
           "accepted": len(acc), "accepted_measured": len(acc_d),
           "precision_pooled": _frac([x > 0 for x in acc_d]),
           "harm_pooled": _frac([x < 0 for x in acc_d]),
           "accepted_true_delta_mean": _frac(acc_d),
           "rejected_sampled": len(rej_d),
           "rejected_truly_better": _frac([x > 0 for x in rej_d]),
           "rejected_true_delta_mean": _frac(rej_d),
           "improver_versions": len(_jsonl(d / "improvers.jsonl"))}
    # Post hoc, not pre-registered (RESULTS.md, Exploratory): the share of valid children
    # far worse than their parent on the arm's own test, early and late.
    for thr in (10, 50):
        for tag, lo, hi in (("early", 1, EARLY_MAX), ("late", LATE_MIN, 10 ** 6)):
            m = [r["measured"] for r in children if lo <= r["gen"] <= hi and r.get("valid")
                 and r.get("measured") is not None]
            out[f"worse_by_{thr}pp_{tag}"] = _frac([x < -thr for x in m])
    gate = _jsonl(d / "gate.jsonl")
    if gate:
        pro = [g for g in gate if g["kind"] == "promotion"]
        imp = [g for g in gate if g["kind"] == "improver"]
        out.update({"gate_promotions_tested": len(pro),
                    "gate_promotions_passed": sum(bool(g["accept"]) for g in pro),
                    "gate_rejected_fresh_gain": sum(g["reason"] == "fresh_gain" for g in pro),
                    "gate_rejected_retention": sum(g["reason"] == "stability" for g in pro),
                    "improver_changes_tested": len(imp),
                    "improver_changes_adopted": sum(bool(g.get("adopt")) for g in imp)})
    return out


def analyze_run(d: Path, hold: Dict[str, np.ndarray], failed: Dict[str, str]) -> dict:
    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    snaps = {}
    for p in sorted((d / "snapshots").glob("gen_*.json")):
        s = json.loads(p.read_text(encoding="utf-8"))
        snaps[s["gen"]] = s
    G = max(snaps) if snaps else 0
    H = lambda h: float(hold[h].mean()) if h in hold else None  # noqa: E731

    per_gen = []
    children = _jsonl(d / "children.jsonl")
    by_gen = defaultdict(list)
    for r in children:
        by_gen[r["gen"]].append(r)
    for g in range(1, G + 1):
        s = snaps.get(g)
        if s is None:
            continue
        ch = s["champion"]
        hc = H(ch["hash"])
        rows = by_gen.get(g, [])
        acc = [r for r in rows if r.get("accepted") and r.get("child_hash")]
        true_d = [H(r["child_hash"]) - H(r["parent_hash"]) for r in acc
                  if H(r["child_hash"]) is not None and H(r["parent_hash"]) is not None]
        valid = [r for r in rows if r.get("valid") and r.get("measured") is not None]
        pe_own = [abs((r["predicted"] or 0.0) - r["measured"]) for r in valid]
        pe_true = []
        for r in valid:
            if r.get("child_hash") and H(r["child_hash"]) is not None and H(r["parent_hash"]) is not None:
                pe_true.append(abs((r["predicted"] or 0.0) - (H(r["child_hash"]) - H(r["parent_hash"]))))
        per_gen.append({
            "gen": g, "champion": ch["hash"], "believed": ch["believed"], "holdout": hc,
            "champion_n": ch.get("n_est"),
            "gap": (ch["believed"] - hc) if hc is not None else None,
            "champion_failed_holdout": ch["hash"] in failed,
            "n_children": len(rows), "n_valid": len(valid), "n_accepted": len(acc),
            "precision": (float(np.mean([x > 0 for x in true_d])) if true_d else None),
            "harm_rate": (float(np.mean([x < 0 for x in true_d])) if true_d else None),
            "accepted_true_delta": (float(np.mean(true_d)) if true_d else None),
            "n_accepted_measured": len(true_d),
            "pred_mae_own": float(np.mean(pe_own)) if pe_own else None,
            "pred_mae_true": float(np.mean(pe_true)) if pe_true else None,
            "missing_predictions": sum(r.get("predicted") is None for r in rows),
            "k_mean": float(np.mean([r["k"] for r in rows])) if rows else None,
            "k_cap": s.get("k_cap"), "calib_skill": s.get("calib_skill"),
            "improver": s.get("improver"), "prompt_choice": s.get("prompt_choice"),
            "usd": s["usage"]["usd"], "tokens": s["usage"]["prompt_tokens"] + s["usage"]["completion_tokens"],
            "calls": s["usage"]["calls"], "elapsed": s["elapsed_seconds"],
            "instance_evals": s["evaluator"]["instance_evals"], "fresh_issued": s.get("fresh_issued", 0),
        })

    def window(key, lo, hi):
        v = [r[key] for r in per_gen if lo <= r["gen"] <= hi and r[key] is not None]
        return float(np.mean(v)) if v else None

    gaps = [(r["gen"], r["gap"]) for r in per_gen if r["gap"] is not None]
    slope = float(np.polyfit([g for g, _ in gaps], [x for _, x in gaps], 1)[0]) if len(gaps) >= 3 else None
    hold_curve = [r["holdout"] for r in per_gen if r["holdout"] is not None]

    # successor tests
    succ = defaultdict(list)
    for r in _jsonl(d / "successor.jsonl"):
        succ[(r["gen"], r["variant"])].append(r)
    succ_out = {}
    for (g, v), rows in sorted(succ.items()):
        vals, toks = [], []
        for r in rows:
            toks.append(r["prompt_tokens"] + r["completion_tokens"])
            if r.get("child_hash") and H(r["child_hash"]) is not None and H(r["parent_hash"]) is not None:
                vals.append(max(0.0, H(r["child_hash"]) - H(r["parent_hash"])))
            else:
                vals.append(0.0)
        q = float(np.mean(vals)) if vals else None
        tpp = float(np.mean(toks)) if toks else None
        succ_out[f"{g}:{v}"] = {"gen": g, "variant": v, "n": len(rows), "q": q,
                                "valid": float(np.mean([bool(r.get("child_hash")) for r in rows])),
                                "tokens_per_proposal": tpp,
                                "q_per_1k_tokens": (1000.0 * q / tpp) if q is not None and tpp else None,
                                "improver": rows[0]["improver"]}
    gens_t = sorted({s["gen"] for s in succ_out.values()})
    ref_q = {g: succ_out.get(f"{g}:ref_v_g", {}).get("q_per_1k_tokens") for g in gens_t}
    late_ref = [ref_q[g] for g in gens_t if g >= 15 and ref_q[g] is not None]
    all_ref = [ref_q[g] for g in gens_t if ref_q[g] is not None]
    corr = []
    for g in gens_t:
        a, b = succ_out.get(f"{g}:own_v_g"), succ_out.get(f"{g}:own_v_0")
        if a and b and a["q"] is not None and b["q"] is not None:
            corr.append(a["q"] - b["q"])
    step = []
    for g in gens_t:
        a, b = succ_out.get(f"{g}:own_v_g"), succ_out.get(f"{g}:own_v_prev")
        if a and b and a["q"] is not None and b["q"] is not None:
            step.append(a["q"] - b["q"])

    last = per_gen[-1] if per_gen else {}
    hours = (last.get("elapsed") or 0) / 3600.0
    succ_tokens = sum(r["prompt_tokens"] + r["completion_tokens"] for rows in succ.values() for r in rows)
    return {
        "arm": cfg["arm"], "seed": cfg["seed"], "gens": G, "per_gen": per_gen,
        "final_holdout": per_gen[-1]["holdout"] if per_gen else None,
        "auc_holdout": float(np.mean(hold_curve)) if hold_curve else None,
        "gap_slope": slope,
        "gap_early": window("gap", 1, EARLY_MAX), "gap_late": window("gap", LATE_MIN, 10 ** 6),
        "precision_early": window("precision", 1, EARLY_MAX),
        "precision_late": window("precision", LATE_MIN, 10 ** 6),
        "pred_mae_own_early": window("pred_mae_own", 1, EARLY_MAX),
        "pred_mae_own_late": window("pred_mae_own", LATE_MIN, 10 ** 6),
        "pred_mae_true_early": window("pred_mae_true", 1, EARLY_MAX),
        "pred_mae_true_late": window("pred_mae_true", LATE_MIN, 10 ** 6),
        "successor": succ_out,
        "succ_ref_q_per_1k_late": float(np.mean(late_ref)) if late_ref else None,
        "succ_ref_q_per_1k_all": float(np.mean(all_ref)) if all_ref else None,
        "corruption_index": float(np.mean(corr)) if corr else None,
        "step_index": float(np.mean(step)) if step else None,
        "usd_loop": last.get("usd"), "tokens_loop": last.get("tokens"), "calls_loop": last.get("calls"),
        "successor_tokens": succ_tokens,
        "hours": hours,
        "instance_evals_per_hour": (last.get("instance_evals", 0) / hours) if hours else None,
        "fresh_tasks_per_hour": (last.get("fresh_issued", 0) / hours) if hours else None,
        "fresh_tasks_total": last.get("fresh_issued", 0),
        "descriptives": descriptives(d, H, children),
    }


def summarize(runs: List[dict]) -> dict:
    arms = defaultdict(list)
    for r in runs:
        arms[r["arm"]].append(r)
    keys = ("final_holdout", "auc_holdout", "gap_slope", "gap_early", "gap_late", "precision_early",
            "precision_late", "pred_mae_own_early", "pred_mae_own_late", "pred_mae_true_early",
            "pred_mae_true_late", "succ_ref_q_per_1k_late", "succ_ref_q_per_1k_all",
            "corruption_index", "step_index", "usd_loop", "tokens_loop", "calls_loop", "hours",
            "instance_evals_per_hour", "fresh_tasks_per_hour")
    out = {a: {k: t_ci([r[k] for r in rs]) for k in keys} for a, rs in sorted(arms.items())}
    # mean per-generation curves
    for a, rs in arms.items():
        G = max(r["gens"] for r in rs)
        curve = []
        for g in range(1, G + 1):
            hv = [p["holdout"] for r in rs for p in r["per_gen"] if p["gen"] == g and p["holdout"] is not None]
            gv = [p["gap"] for r in rs for p in r["per_gen"] if p["gen"] == g and p["gap"] is not None]
            curve.append({"gen": g, "holdout": t_ci(hv), "gap": t_ci(gv)})
        out[a]["curve"] = curve
    return out


def tests(runs: List[dict]) -> dict:
    by = defaultdict(list)
    for r in runs:
        by[r["arm"]].append(r)
    col = lambda a, k: [r[k] for r in by.get(a, [])]  # noqa: E731
    res = {}
    for a in (1, 2):
        p = one_sided_greater(col(a, "gap_slope"))
        early, late = t_ci(col(a, "gap_early"))["mean"], t_ci(col(a, "gap_late"))["mean"]
        res[f"H1_arm{a}_gap_grows"] = {
            "slope_p": p, "early_gap": early, "late_gap": late,
            "holds": bool(p is not None and p < ALPHA and early is not None and late is not None and late > early)}
    p3 = one_sided_greater(col(3, "gap_slope"))
    p32 = one_sided_greater(col(2, "gap_slope"), col(3, "gap_slope"))
    res["H2_arm3_gap_flat"] = {"arm3_slope_p": p3, "arm2_gt_arm3_p": p32,
                               "holds": bool(p3 is not None and p3 >= ALPHA and p32 is not None and p32 < ALPHA)}
    succ_measured = any(r["successor"] for r in runs)
    p_succ = one_sided_greater(col(3, "succ_ref_q_per_1k_late"), col(2, "succ_ref_q_per_1k_late"))
    res["H3_arm3_better_successors_late"] = (
        {"p": p_succ, "holds": bool(p_succ is not None and p_succ < ALPHA)} if succ_measured
        else {"p": None, "holds": None, "status": "not measured"})

    def match(key, sesoi_abs=None, sesoi_rel=None):
        a3, a2 = col(3, key), col(2, key)
        p = one_sided_greater(a3, a2)
        m3, m2 = t_ci(a3)["mean"], t_ci(a2)["mean"]
        if m3 is None or m2 is None:
            return {"p": p, "diff": None, "verdict": "missing"}
        diff = m3 - m2
        sesoi = sesoi_abs if sesoi_abs is not None else abs(m2) * sesoi_rel
        if p is not None and p < ALPHA:
            verdict = "arm3_better"
        elif diff < sesoi:
            verdict = "match"
        else:
            verdict = "inconclusive"
        return {"p": p, "diff": diff, "sesoi": sesoi, "verdict": verdict}

    hold = match("auc_holdout", sesoi_abs=SESOI_HOLDOUT)
    if not succ_measured:
        # The kill fires only if both measures match (§6), so a holdout half that does not
        # match decides it alone; a matched holdout half would leave it open.
        settled = hold["verdict"] != "match"
        res["kill"] = {"holdout_auc": hold, "successor_per_compute": {"verdict": "not measured"},
                       "fires": False if settled else None,
                       "status": ("does not fire: the holdout half is not matched" if settled
                                  else "undecided: successor half not measured")}
        return res
    succ = match("succ_ref_q_per_1k_all", sesoi_rel=SESOI_SUCCESSOR_REL)
    res["kill"] = {"holdout_auc": hold, "successor_per_compute": succ,
                   "fires": hold["verdict"] == "match" and succ["verdict"] == "match"}
    return res


def diff_ci(a, b, conf=0.95) -> Optional[dict]:
    """Welch interval for mean(a) - mean(b): a descriptive contrast, two-sided."""
    a = np.asarray([v for v in a if v is not None and np.isfinite(v)], dtype=float)
    b = np.asarray([v for v in b if v is not None and np.isfinite(v)], dtype=float)
    if len(a) < 2 or len(b) < 2:
        return None
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    se = math.sqrt(va + vb)
    if se == 0:
        d = float(a.mean() - b.mean())
        return {"diff": d, "lo": d, "hi": d, "df": None}
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    h = float(stats.t.ppf(0.5 + conf / 2, df) * se)
    d = float(a.mean() - b.mean())
    return {"diff": d, "lo": d - h, "hi": d + h, "df": float(df)}


def contrasts(runs: List[dict]) -> dict:
    by = defaultdict(list)
    for r in runs:
        by[r["arm"]].append(r)
    out = {}
    for k in ("final_holdout", "auc_holdout", "gap_late", "gap_slope"):
        for x, y in ((3, 2), (3, 1), (1, 2)):
            out[f"{k}: arm{x} - arm{y}"] = diff_ci([r[k] for r in by.get(x, [])],
                                                  [r[k] for r in by.get(y, [])])
    return out


def fmt(ci, digits=3):
    if not ci or ci.get("mean") is None:
        return "—"
    if ci.get("lo") is None:
        return f"{ci['mean']:.{digits}f}"
    return f"{ci['mean']:.{digits}f} [{ci['lo']:.{digits}f}, {ci['hi']:.{digits}f}]"


def table(summary: dict) -> str:
    names = {1: "1 AlphaEvolve-style", 2: "2 MetaSkill-style", 3: "3 Fresh-gated (ours)"}
    rows = [
        ("Final champion, holdout (pp vs best fit)", "final_holdout", 3),
        ("Mean champion holdout over generations", "auc_holdout", 3),
        ("Gap: believed − holdout, gens 1–10", "gap_early", 3),
        ("Gap: believed − holdout, gens 21–30", "gap_late", 3),
        ("Gap slope per generation", "gap_slope", 4),
        ("Acceptance precision, gens 1–10", "precision_early", 2),
        ("Acceptance precision, gens 21–30", "precision_late", 2),
        ("Prediction MAE vs own measure, gens 1–10", "pred_mae_own_early", 3),
        ("Prediction MAE vs own measure, gens 21–30", "pred_mae_own_late", 3),
        ("Successor quality per 1k tokens, ref parents, gens ≥15", "succ_ref_q_per_1k_late", 4),
        ("Successor quality per 1k tokens, ref parents, all", "succ_ref_q_per_1k_all", 4),
        ("Corruption index: Q(v_g) − Q(v_0), own parents", "corruption_index", 4),
        ("Instance evaluations per hour", "instance_evals_per_hour", 0),
        ("Fresh tasks consumed per hour", "fresh_tasks_per_hour", 0),
        ("Loop cost, USD per run", "usd_loop", 3),
        ("Loop tokens per run", "tokens_loop", 0),
    ]
    arms = sorted(a for a in summary if isinstance(a, int))
    head = "| Measure (mean [95% CI over seeds]) | " + " | ".join(names[a] for a in arms) + " |"
    sep = "|---|" + "---|" * len(arms)
    body = [f"| {label} | " + " | ".join(fmt(summary[a][k], dg) for a in arms) + " |"
            for label, k, dg in rows if any(summary[a][k]["mean"] is not None for a in arms)]
    return "\n".join([head, sep] + body)


DESCRIPTIVE_ROWS = [
    ("Proposals per run", "proposals", 0),
    ("Valid proposals per run", "valid", 0),
    ("Accepted on the arm's own test", "accepted", 1),
    ("Accepted that were truly better on the holdout (pooled)", "precision_pooled", 2),
    ("Accepted that were truly worse on the holdout (pooled)", "harm_pooled", 2),
    ("Mean true change of an accepted child (pp)", "accepted_true_delta_mean", 3),
    ("Rejected (15% sample) that were truly better", "rejected_truly_better", 2),
    ("Mean true change of a rejected child (pp)", "rejected_true_delta_mean", 3),
    ("Improver versions written", "improver_versions", 1),
    ("Gate: promotions tested", "gate_promotions_tested", 0),
    ("Gate: promotions passed", "gate_promotions_passed", 1),
    ("Gate: rejected, fresh gain too small", "gate_rejected_fresh_gain", 0),
    ("Gate: rejected by the retention veto", "gate_rejected_retention", 1),
    ("Gate: improver changes tested", "improver_changes_tested", 0),
    ("Gate: improver changes adopted", "improver_changes_adopted", 1),
    ("Post hoc: children worse than parent by >10 pp, gens 21–30", "worse_by_10pp_late", 2),
    ("Post hoc: children worse than parent by >50 pp, gens 21–30", "worse_by_50pp_late", 2),
]


def descriptive_table(runs: List[dict]) -> str:
    names = {1: "1 AlphaEvolve-style", 2: "2 MetaSkill-style", 3: "3 Fresh-gated (ours)"}
    arms = sorted({r["arm"] for r in runs})
    head = "| Count per run (mean [95% CI over seeds]) | " + " | ".join(names[a] for a in arms) + " |"
    sep = "|---|" + "---|" * len(arms)
    body = []
    for label, k, dg in DESCRIPTIVE_ROWS:
        cells = [fmt(t_ci([r["descriptives"].get(k) for r in runs if r["arm"] == a]), dg) for a in arms]
        if any(c != "—" for c in cells):
            body.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join([head, sep] + body)


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Pre-registered analysis of the three-arm run")
    ap.add_argument("root")
    a = ap.parse_args(argv)
    root = Path(a.root)
    cache = HoldoutCache(root / "holdout_cache.jsonl")
    hold = holdout_scores(cache, holdout_instances())
    runs = [analyze_run(p.parent, hold, cache.errors) for p in sorted(root.glob("*/config.json"))]
    summary = summarize(runs)
    res = {"runs": runs, "summary": {str(k): v for k, v in summary.items()}, "tests": tests(runs),
           "contrasts": contrasts(runs)}
    (root / "results.json").write_text(json.dumps(res, indent=2, default=float), encoding="utf-8")
    md = table(summary) + "\n\n" + descriptive_table(runs)
    (root / "results.md").write_text(md + "\n\n```json\n" + json.dumps(res["tests"], indent=2) + "\n```\n",
                                     encoding="utf-8")
    print(md)
    print(json.dumps(res["tests"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
