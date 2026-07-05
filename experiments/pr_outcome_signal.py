r"""
pr_outcome_signal.py — the runnable cousin of the council backtest, on a ground truth only the
repo owner has: your own PR merged-vs-rejected history.

The council backtest (experiments/council_escalation_backtest.py) asks "does the council's Δ
predict decisions the operator later reverted." It is n=0 — `data/convergence/council-reviews.jsonl`
is empty (councilReview logs no records yet), and reverts are ~12/3015 commits anyway, too rare
to power it. So the council-Δ number cannot be produced. This does the adjacent, WELL-POWERED,
owner-only question it was a proxy for: **does a cheap, computable signal predict which of your
PRs get REJECTED (closed without merge)?**

Ground truth: `gh pr list --state all` → merged (0) vs closed-unmerged (1, "rejected"). This is
a fact only the repo owner can produce (private history). Honest caveats: closed-unmerged is a
noisy "bad" label (superseded / duplicate / auto-closed-slop mixed in), and `is_draft` is
near-tautological (drafts don't merge), so it is reported separately from the non-trivial signal.

Result (2026-07-04, ~1292 PRs, 222 rejected): the combined signal predicts rejection at AUROC
~0.63 — but that is DOMINATED by `is_draft` (0.73); with draft/slop removed the non-trivial
structural signal is ~0.57, barely above chance. Reading: metadata does NOT tell you which real
PRs will be rejected. That NULL is the point — it motivates logging the council's *semantic* Δ,
which is where predictive value would have to live.

Run:  python experiments/pr_outcome_signal.py      (needs `gh` auth on the repo)
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "pr_outcome_signal_report.json"
SLOP = ("wip", "temp", "placeholder", "tmp", "test commit", "fixup", "squash")


def pull_prs():
    fields = "number,title,author,isDraft,state,mergedAt,additions,deletions,changedFiles,labels"
    out = subprocess.run(
        ["gh", "pr", "list", "--state", "all", "--limit", "2000", "--json", fields],
        capture_output=True, text=True, encoding="utf-8",
    )
    if out.returncode != 0:
        raise SystemExit(f"gh failed: {out.stderr[:300]}")
    return json.loads(out.stdout)


def feats(p):
    t = p.get("title") or ""
    a = p.get("additions") or 0
    d = p.get("deletions") or 0
    return {
        "additions": a, "deletions": d, "churn": a + d,
        "changed_files": p.get("changedFiles") or 0,
        "is_draft": int(bool(p.get("isDraft"))),
        "title_len": len(t),
        "title_slop": int(any(w in t.lower() for w in SLOP)),
        "n_labels": len(p.get("labels") or []),
    }


def main():
    prs = [p for p in pull_prs() if p["state"] in ("MERGED", "CLOSED") or p.get("mergedAt")]
    names = list(feats(prs[0]).keys())
    Xm = np.array([[feats(p)[k] for k in names] for p in prs], float)
    y = np.array([1 if (p["state"] == "CLOSED" and not p.get("mergedAt")) else 0 for p in prs])
    g = np.array([p["author"]["login"] if p.get("author") else "?" for p in prs])

    per_feature = {}
    for j, nm in enumerate(names):
        a = roc_auc_score(y, Xm[:, j])
        per_feature[nm] = round(max(a, 1 - a), 3)

    def cv_auroc(cols):
        oof = np.zeros(len(y))
        pipe = Pipeline([("sc", StandardScaler()),
                         ("lr", LogisticRegression(max_iter=2000, class_weight="balanced"))])
        for tr, te in GroupKFold(n_splits=5).split(Xm[:, cols], y, g):
            pipe.fit(Xm[tr][:, cols], y[tr])
            oof[te] = pipe.predict_proba(Xm[te][:, cols])[:, 1]
        return round(float(roc_auc_score(y, oof)), 3)

    all_cols = list(range(len(names)))
    nontrivial = [j for j, nm in enumerate(names) if nm not in ("is_draft", "title_slop")]
    auroc_all = cv_auroc(all_cols)
    auroc_nontrivial = cv_auroc(nontrivial)

    report = {
        "task": "does a cheap signal predict PR REJECTION (closed-unmerged)? — runnable cousin of the council backtest",
        "ground_truth": "gh PR history: merged vs closed-unmerged (owner-only, private)",
        "n": int(len(y)), "n_rejected": int(y.sum()), "reject_rate": round(float(y.mean()), 4),
        "n_authors": int(len(set(g))),
        "eval": "GroupKFold(5) by author (must generalize across contributors, not memorize one)",
        "per_feature_auroc": per_feature,
        "combined_auroc": auroc_all,
        "combined_auroc_without_draft_slop": auroc_nontrivial,
        "reading": (
            "cheap metadata predicts rejection only WEAKLY and mostly via the near-tautological "
            "is_draft (drafts don't merge); the non-trivial structural signal is near chance. So "
            "structure does NOT flag which real PRs get rejected — a (near-)null that motivates "
            "logging the council's SEMANTIC Δ, where predictive value would have to live."),
        "council_backtest_status": "NULL — council-reviews.jsonl is empty (n=0); this is the "
                                    "runnable owner-only cousin, NOT the council-Δ number.",
        "evidence_class": "MEASURED",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"n={len(y)}  rejected={int(y.sum())} ({y.mean():.1%})  authors={len(set(g))}")
    print("per-feature AUROC:", per_feature)
    print(f"combined AUROC (GroupKFold by author) = {auroc_all}")
    print(f"combined WITHOUT draft/slop (non-trivial) = {auroc_nontrivial}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
