"""Tests for the NAP Sanctions Oracle — grounds 'denial overrides capability' in the
consolidated deny-list. Deterministic (in-memory fixture, no network).

See src/convergence_io/sanctions_oracle.py and docs/research/regulatory-oracle-grounding.md.
"""
from src.convergence_io import SanctionsOracle, denial_overrides_capability


# A tiny stand-in for OpenSanctions `targets.simple.csv` rows.
ROWS = [
    {"id": "NK-1", "schema": "Person",
     "name": "Vladimir Vladimirovich Putin",
     "aliases": "Putin, Vladimir;Владимир Путин",
     "dataset": "us_ofac_sdn;eu_fsf;gb_hmt_sanctions", "countries": "ru"},
    {"id": "NK-2", "schema": "Organization",
     "name": "Acme Front Company LLC",
     "aliases": "", "dataset": "us_ofac_sdn", "countries": "ir"},
]


def _oracle():
    return SanctionsOracle(rows=ROWS)


def test_listed_entity_is_denied():
    r = _oracle().screen("Vladimir Vladimirovich Putin")
    assert r.denied
    assert r.matches and r.matches[0]["dataset"].startswith("us_ofac_sdn")
    assert r.list_size == 2


def test_clean_entity_is_clear():
    r = _oracle().screen("Jane Q. Public")
    assert not r.denied
    assert r.matches == []


def test_match_is_normalization_robust():
    o = _oracle()
    # case, punctuation, and alias forms all resolve to the same listed entity
    assert o.screen("vladimir  vladimirovich PUTIN").denied        # case + whitespace
    assert o.screen("Putin, Vladimir").denied                      # alias, punctuation
    assert o.screen("Владимир Путин").denied                       # non-Latin alias
    assert o.screen("acme front company llc").denied               # punctuation stripped


def test_denial_overrides_capability():
    o = _oracle()
    # listed entity: a granted capability does NOT permit the action — denial wins
    v = denial_overrides_capability(o, "Vladimir Vladimirovich Putin", capability_allowed=True)
    assert v["sanctions_denied"] is True
    assert v["permitted"] is False
    # clean entity with capability: permitted
    ok = denial_overrides_capability(o, "Jane Q. Public", capability_allowed=True)
    assert ok["permitted"] is True
    # listed entity is never permitted, with or without capability
    no_cap = denial_overrides_capability(o, "Vladimir Vladimirovich Putin", capability_allowed=False)
    assert no_cap["permitted"] is False
