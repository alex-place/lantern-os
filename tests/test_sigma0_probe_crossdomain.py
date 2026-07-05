"""
Torch-free, sklearn-free unit tests for experiments/sigma0_probe_crossdomain.py (#2030).

We can't run the model on this box, so we validate the cross-domain harness with SYNTHETIC
embeddings whose structure we control:
  - a SHARED truth direction across domains ⇒ a probe fit on one domain must transfer (AUROC ≫ 0.5),
  - domain-SPECIFIC (mutually orthogonal) truth axes ⇒ the same probe must NOT transfer (~0.5).
This proves the harness distinguishes a real truth direction from per-domain memorization — the
exact question #2030 poses — independent of the GPU hidden-state extraction step.

Run: python tests/test_sigma0_probe_crossdomain.py    (also pytest-compatible)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiments"))
import sigma0_probe_crossdomain as X  # noqa: E402


def _synth_shared(seed=0, dim=16, per_domain=200):
    """3 domains; truth always moves along dim 0; each domain has a big nuisance offset on a
    different dim. A direction fit on one domain must still separate the others."""
    rng = np.random.RandomState(seed)
    v = np.zeros(dim); v[0] = 1.0
    feats, y, doms = [], [], []
    for dom, nuis_dim, nuis in [("A", 1, 5.0), ("B", 2, -4.0), ("C", 3, 8.0)]:
        for _ in range(per_domain):
            label = rng.randint(0, 2)
            f = rng.randn(dim) * 0.3
            f += label * 2.0 * v          # truth signal, shared axis
            f[nuis_dim] += nuis           # domain nuisance, orthogonal to v
            feats.append(f); y.append(label); doms.append(dom)
    return np.array(feats), np.array(y), doms


def _synth_domain_specific(seed=1, dim=16, per_domain=200):
    """3 domains; each domain's truth moves along a DIFFERENT (orthogonal) dim. A direction fit
    on one domain is noise w.r.t. another's labels ⇒ transfer ~0.5."""
    rng = np.random.RandomState(seed)
    feats, y, doms = [], [], []
    for dom, axis in [("A", 0), ("B", 5), ("C", 10)]:
        for _ in range(per_domain):
            label = rng.randint(0, 2)
            f = rng.randn(dim) * 0.3
            f[axis] += label * 3.0        # truth on a domain-specific axis
            feats.append(f); y.append(label); doms.append(dom)
    return np.array(feats), np.array(y), doms


# ── auroc primitive ──────────────────────────────────────────────────────────
def test_auroc_perfect_and_reversed():
    assert X.auroc([3, 4, 5], [0, 0, 0]) == 0.5          # one class → undefined → 0.5
    assert X.auroc([5, 6, 7, 1, 2, 3], [1, 1, 1, 0, 0, 0]) == 1.0   # perfectly separable
    assert X.auroc([1, 2, 3, 5, 6, 7], [1, 1, 1, 0, 0, 0]) == 0.0   # perfectly reversed
    assert X.auroc([1, 1, 2, 2], [1, 0, 1, 0]) == 0.5              # ties → 0.5


def test_truth_direction_points_from_false_to_true():
    feats = np.array([[2.0, 0.0], [2.2, 0.1], [-2.0, 0.0], [-2.1, -0.1]])
    y = np.array([1, 1, 0, 0])
    d = X.truth_direction(feats, y)
    assert d[0] > 0 and abs(d[1]) < abs(d[0])   # separation is along dim 0


# ── the #2030 question: does a truth direction TRANSFER across domains? ───────
def test_shared_direction_transfers():
    feats, y, doms = _synth_shared()
    out = X.all_pairs_transfer(feats, y, doms)
    # every off-diagonal (train-on-A, test-on-B) pair must clear chance by a wide margin
    assert out["min_cross_domain_auroc"] > 0.9, out
    assert out["mean_cross_domain_auroc"] > 0.95, out


def test_domain_specific_signal_does_not_transfer():
    feats, y, doms = _synth_domain_specific()
    out = X.all_pairs_transfer(feats, y, doms)
    # a probe fit on one domain's private axis can't read another's → near chance.
    # (orientation-free AUROC floors at 0.5, so "no transfer" = close to 0.5 from above;
    # residual >0.5 is finite-sample leakage of the fitted direction onto other axes.)
    assert out["mean_cross_domain_auroc"] < 0.6, out
    # and it must be far below the shared-direction regime — that's the real signal
    assert out["mean_cross_domain_auroc"] < X.all_pairs_transfer(*_synth_shared())["mean_cross_domain_auroc"] - 0.3, out


def test_within_domain_separates_in_both_regimes():
    for feats, y, doms in (_synth_shared(), _synth_domain_specific()):
        for dom in X.domains_of([(d,) for d in dict.fromkeys(doms)]):
            a = X.cross_domain_auroc(feats, y, doms, dom, dom)   # train==test = in-distribution
            assert a > 0.9, (dom, a)


def test_cross_domain_auroc_guards_tiny_splits():
    feats = np.array([[1.0], [0.0]]); y = np.array([1, 0]); doms = ["A", "B"]
    assert X.cross_domain_auroc(feats, y, doms, "A", "B") == 0.5   # <2 per side → guard → 0.5


# ── the verified multi-domain fact set ───────────────────────────────────────
def test_fact_set_is_multidomain_and_wellformed():
    doms = X.domains_of()
    assert len(doms) >= 3, doms
    for domain, tpl, t, f in X.MULTI_DOMAIN_FACTS:
        assert "{}" in tpl, tpl
        assert t and f and t != f, (tpl, t, f)


def test_build_examples_balanced_and_aligned():
    ex = X.build_examples()
    assert len(ex) == 2 * len(X.MULTI_DOMAIN_FACTS)
    assert sum(e["y"] for e in ex) == len(X.MULTI_DOMAIN_FACTS)   # exactly half true
    # every domain contributes an equal number of true and false examples
    for dom in X.domains_of():
        rows = [e for e in ex if e["domain"] == dom]
        assert sum(e["y"] for e in rows) == len(rows) // 2, dom


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
