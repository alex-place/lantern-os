"""
Σ₀ trilogy hardening (2/3, #2030) — cross-domain truth-probe generalization (CPU-verifiable half).

`sigma0_hidden_probe.py` found a linear probe separates true/false Ouro hidden states at
AUROC ≈0.99 — but only on ONE domain (geography capitals), and at ceiling. #2030 asks: is that
a real "truth DIRECTION" that transfers across domains, or per-fact memorization? A genuine
truth direction found on geography must still separate true/false in *science* / *history* /
*astronomy* it never trained on.

This module is the torch-free half of that test, verifiable on a CPU box:
  - MULTI_DOMAIN_FACTS: a domain-tagged, length-matched, VERIFIED fact set across 4 domains
    (24 facts → 48 labeled examples), so the run can compute per-domain and cross-domain AUROC.
  - A mean-difference "truth direction" (centroid_true − centroid_false), a numpy AUROC, and
    cross_domain_auroc() / all_pairs_transfer() — train the direction on one domain, score a
    held-out domain. Transfer ≫ 0.5 ⇒ a real, shared truth direction; ≈0.5 ⇒ per-domain only.

Deliberately numpy-only (no torch, no sklearn — sklearn isn't in the minimal venv). The one GPU
step is extracting Ouro's per-example hidden states; `sigma0_hidden_probe.py` supplies those and
then calls all_pairs_transfer(features, y, domains). Note: this set is intentionally WELL-KNOWN
(no fabricated obscure facts) — the "harder facts to break the 0.99 ceiling" sub-goal needs the
model's own uncertainty and is left to the run; this delivers the cross-domain generalization
axis + a clean multi-domain set.

Acceptance mapping (#2030): "cross-domain generalization ... a real truth direction must transfer,
not memorize per-fact features" → all_pairs_transfer(); "larger, more diverse n" → 4 domains.
"""
from __future__ import annotations

import numpy as np

# (domain, template, true_fill, false_fill) — every pair is unambiguously true/false and
# roughly length-matched (the length confound gives ~0.5 on its own, per the pilot).
MULTI_DOMAIN_FACTS = [
    ("geography", "The capital of France is {}.", "Paris", "Rome"),
    ("geography", "The capital of Japan is {}.", "Tokyo", "Seoul"),
    ("geography", "The capital of Egypt is {}.", "Cairo", "Tunis"),
    ("geography", "The capital of Canada is {}.", "Ottawa", "Toronto"),
    ("geography", "The capital of Spain is {}.", "Madrid", "Lisbon"),
    ("geography", "The capital of Germany is {}.", "Berlin", "Munich"),

    ("science", "The chemical symbol for gold is {}.", "Au", "Ag"),
    ("science", "The chemical symbol for oxygen is {}.", "O", "N"),
    ("science", "The chemical symbol for sodium is {}.", "Na", "Cl"),
    ("science", "The chemical symbol for iron is {}.", "Fe", "Pb"),
    ("science", "The Sun is a {}.", "star", "planet"),
    ("science", "The center of an atom is the {}.", "nucleus", "neutron"),

    ("history", "World War II ended in the year {}.", "1945", "1918"),
    ("history", "The United States declared independence in {}.", "1776", "1815"),
    ("history", "The Berlin Wall fell in the year {}.", "1989", "1972"),
    ("history", "The first Moon landing was in the year {}.", "1969", "1957"),
    ("history", "The Titanic sank in the year {}.", "1912", "1931"),
    ("history", "The French Revolution began in the year {}.", "1789", "1749"),

    ("astronomy", "The largest planet in the Solar System is {}.", "Jupiter", "Neptune"),
    ("astronomy", "The closest planet to the Sun is {}.", "Mercury", "Venus"),
    ("astronomy", "The red planet is {}.", "Mars", "Venus"),
    ("astronomy", "Earth orbits the {}.", "Sun", "Moon"),
    ("astronomy", "The planet with prominent rings is {}.", "Saturn", "Uranus"),
    ("astronomy", "The Moon orbits the {}.", "Earth", "Sun"),
]


def build_examples(facts=MULTI_DOMAIN_FACTS):
    """Expand each fact into a true (y=1) and false (y=0) example. The run extracts a hidden
    state per `text`; keep `domain` + `y` aligned for the cross-domain split."""
    out = []
    for domain, tpl, t, f in facts:
        out.append({"domain": domain, "text": tpl.format(t), "y": 1})
        out.append({"domain": domain, "text": tpl.format(f), "y": 0})
    return out


def domains_of(facts=MULTI_DOMAIN_FACTS):
    seen = []
    for d, *_ in facts:
        if d not in seen:
            seen.append(d)
    return seen


# ── numpy probe: mean-difference "truth direction" ───────────────────────────
def truth_direction(feats, y):
    """centroid(true) − centroid(false): the axis along which true/false separate."""
    feats = np.asarray(feats, dtype=float)
    y = np.asarray(y)
    mu_t = feats[y == 1].mean(axis=0)
    mu_f = feats[y == 0].mean(axis=0)
    return mu_t - mu_f


def auroc(scores, y):
    """Mann–Whitney AUROC (ties → 0.5). O(n²), fine for the pilot n; no sklearn dependency."""
    scores = list(map(float, scores))
    y = list(y)
    pos = [s for s, l in zip(scores, y) if l == 1]
    neg = [s for s, l in zip(scores, y) if l == 0]
    if not pos or not neg:
        return 0.5
    wins = 0.0
    for a in pos:
        for b in neg:
            wins += 1.0 if a > b else 0.5 if a == b else 0.0
    return wins / (len(pos) * len(neg))


def cross_domain_auroc(feats, y, domains, train_domain, test_domain):
    """Fit the truth direction on `train_domain`, score + AUROC on `test_domain`. Orientation-free
    (max(a, 1−a)) because the direction's sign is arbitrary. High ⇒ the direction TRANSFERS."""
    feats = np.asarray(feats, dtype=float)
    y = np.asarray(y)
    domains = np.asarray(domains)
    tr = domains == train_domain
    te = domains == test_domain
    if tr.sum() < 2 or te.sum() < 2:
        return 0.5
    d = truth_direction(feats[tr], y[tr])
    scores = feats[te] @ d
    a = auroc(scores, y[te])
    return max(a, 1.0 - a)


def all_pairs_transfer(feats, y, domains):
    """Full train→test AUROC matrix. Diagonal = within-domain (in-distribution); off-diagonal =
    cross-domain transfer. A real truth direction keeps the off-diagonal well above 0.5."""
    doms = list(dict.fromkeys(list(domains)))          # unique domains, order preserved
    mat = {tr: {te: round(cross_domain_auroc(feats, y, domains, tr, te), 4) for te in doms} for tr in doms}
    offdiag = [mat[tr][te] for tr in doms for te in doms if tr != te]
    return {
        "matrix": mat,
        "mean_cross_domain_auroc": round(sum(offdiag) / len(offdiag), 4) if offdiag else None,
        "min_cross_domain_auroc": round(min(offdiag), 4) if offdiag else None,
    }


if __name__ == "__main__":
    import json
    ex = build_examples()
    print(f"[crossdomain] {len(ex)} examples across domains: {domains_of()}")
    print("[crossdomain] (run sigma0_hidden_probe with these to get features, then all_pairs_transfer)")
    print(json.dumps({"n_examples": len(ex), "domains": domains_of()}))
