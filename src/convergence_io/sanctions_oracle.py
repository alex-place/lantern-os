"""
Sanctions Oracle — grounds the NAP primitive (P2) in the live, cross-border deny-list.

The Convergence IO **NAP** rule (`nap.py`) is: *a denial overrides any capability claim.*
The deep-research validation ([docs/research/regulatory-oracle-grounding.md]) found this is
the most solidly-grounded primitive of the stack — it is **near-literally** how US sanctions
law works: dealing in blocked property is barred "**except as authorized by … licenses or
otherwise**" (31 CFR `.201`), under **civil strict liability** (intent/capability do not
excuse the violation). `nap.py`'s own docstring anticipated this: *"external deny lists
(OFAC SDN, BIS Entity List, …) can be loaded as NAP entries and refreshed on a schedule."*

This module is that external grounding — the **M1 dynamic external predicate**. It screens an
entity name against the **OpenSanctions consolidated list** (OFAC + EU + UN + UK + UN Security
Council + more), a free, keyless, daily-updated feed of ~79k sanctioned targets, and returns a
hard-denial verdict that, by the NAP rule, a capability claim cannot override.

Honest scope: this does **normalized exact** matching on names + aliases. Production sanctions
screening needs fuzzy/phonetic matching and false-positive review (the research's open
question #2). This is a faithful, grounded oracle — not a compliance-grade screening engine.
"""

from __future__ import annotations

import csv
import io
import os
import time
import unicodedata
import urllib.request
from dataclasses import dataclass, field
from typing import Dict, List, Optional

OPENSANCTIONS_TARGETS = "https://data.opensanctions.org/datasets/latest/sanctions/targets.simple.csv"
_DEFAULT_CACHE = os.environ.get(
    "SANCTIONS_CACHE", os.path.join("data", "sanctions", "opensanctions-targets.csv"))


def _norm(s: str) -> str:
    """Normalize a name for matching: strip diacritics, lowercase, collapse non-alphanumerics."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())


@dataclass
class ScreeningResult:
    """A grounded denial verdict from the consolidated deny-list."""
    query: str
    denied: bool
    matches: List[Dict] = field(default_factory=list)
    list_size: int = 0
    dataset: str = "opensanctions:sanctions (OFAC + EU + UN + UK + …)"
    source: str = OPENSANCTIONS_TARGETS
    as_of: Optional[str] = None

    def to_dict(self) -> Dict:
        return {
            "query": self.query, "denied": self.denied, "matches": self.matches,
            "list_size": self.list_size, "dataset": self.dataset, "source": self.source,
            "as_of": self.as_of,
        }


class SanctionsOracle:
    """Screens a name against the live consolidated sanctions deny-list (the NAP oracle).

    Pass `rows` (a list of dict records) to seed it deterministically (tests); otherwise it
    fetches + caches `targets.simple.csv` from OpenSanctions with a TTL.
    """

    def __init__(self, cache_path: str = _DEFAULT_CACHE, ttl_hours: float = 24.0,
                 rows: Optional[List[Dict]] = None, timeout: float = 60.0) -> None:
        self.cache_path = cache_path
        self.ttl = ttl_hours * 3600
        self.timeout = timeout
        self._index: Optional[Dict[str, List[Dict]]] = None
        self._size = 0
        self._as_of: Optional[str] = None
        if rows is not None:
            self._build_index(rows)
            self._as_of = "in-memory"

    # ── data loading ─────────────────────────────────────────────────────────
    def _fetch_csv(self) -> str:
        fresh = (os.path.exists(self.cache_path)
                 and (time.time() - os.path.getmtime(self.cache_path)) < self.ttl)
        if fresh:
            with open(self.cache_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        req = urllib.request.Request(OPENSANCTIONS_TARGETS,
                                     headers={"User-Agent": "LanternOS-NAP-Oracle/1.0"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:  # nosec - public CC-BY data
            text = r.read().decode("utf-8", "replace")
        os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            f.write(text)
        return text

    def _build_index(self, rows: List[Dict]) -> None:
        idx: Dict[str, List[Dict]] = {}
        for r in rows:
            names = [r.get("name", "")]
            names += [a for a in (r.get("aliases", "") or "").split(";") if a.strip()]
            entity = {"name": r.get("name"), "dataset": r.get("dataset"),
                      "schema": r.get("schema"), "sanctions": r.get("sanctions"),
                      "id": r.get("id"), "countries": r.get("countries")}
            for n in names:
                k = _norm(n)
                if k:
                    idx.setdefault(k, []).append(entity)
        self._index = idx
        self._size = len(rows)

    def _ensure_loaded(self) -> None:
        if self._index is not None:
            return
        rows = list(csv.DictReader(io.StringIO(self._fetch_csv())))
        self._build_index(rows)
        if os.path.exists(self.cache_path):
            self._as_of = time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(self.cache_path)))

    # ── the screen ────────────────────────────────────────────────────────────
    def screen(self, name: str) -> ScreeningResult:
        """Is this entity on the consolidated deny-list? A hard denial if so."""
        self._ensure_loaded()
        hits = self._index.get(_norm(name), []) if self._index else []
        seen, uniq = set(), []
        for h in hits:
            if h.get("id") not in seen:
                seen.add(h.get("id"))
                uniq.append(h)
        return ScreeningResult(query=name, denied=bool(uniq), matches=uniq[:5],
                               list_size=self._size, as_of=self._as_of)


def denial_overrides_capability(oracle: SanctionsOracle, name: str,
                                capability_allowed: bool) -> Dict:
    """The NAP load-bearing rule, grounded in the live deny-list.

    A sanctions denial is a hard floor: even with capability_allowed=True, a listed entity is
    NOT permitted. This is the validated NAP↔OFAC mapping — strict liability, no override
    short of an explicit license. Returns the verdict + the grounding matches.
    """
    res = oracle.screen(name)
    return {
        "name": name,
        "capability_allowed": capability_allowed,
        "sanctions_denied": res.denied,
        "permitted": capability_allowed and not res.denied,   # denial overrides capability
        "rule": "NAP: a denial overrides any capability claim (OFAC strict liability, 31 CFR .201)",
        "matches": res.matches,
        "source": res.source,
    }


# CLI probe: `python -m convergence_io.sanctions_oracle "Vladimir Putin"`
if __name__ == "__main__":
    import sys
    try:  # keep Windows cp1252 consoles from crashing on → / ·
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    o = SanctionsOracle()
    queries = sys.argv[1:] or ["Vladimir Putin", "Jane Q Public (not sanctioned)"]
    for q in queries:
        r = o.screen(q)
        print(f"[{'DENIED' if r.denied else 'clear '}] {q!r}  "
              f"({len(r.matches)} match, list={r.list_size}, as_of={r.as_of})")
        for m in r.matches:
            print(f"    · {m['name']}  [{m['dataset']}]  {m.get('countries','')}")
    print("\nNAP rule — denial overrides capability:")
    for q in queries:
        v = denial_overrides_capability(o, q, capability_allowed=True)
        print(f"    {q!r}: capability=allowed, sanctioned={v['sanctions_denied']} "
              f"→ permitted={v['permitted']}")
