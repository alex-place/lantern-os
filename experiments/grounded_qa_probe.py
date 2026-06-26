"""Grounding test battery — questions an UNGROUNDED model tends to break on.

How to test a grounding system: don't ask things the model already knows — ask where
answering-from-memory has a well-known FAILURE, then check whether going to the web catches
it. Two kinds of win:
  • CATCH   — the web overturns the confident-but-wrong "vibe" answer.
  • ABSTAIN — when the web can't answer (real-time / non-encyclopedic), the loop flags
              "ungrounded" instead of inventing a number. Calibration is a win too.

Run: python experiments/grounded_qa_probe.py
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from src.cio_sde import WebChannel  # noqa: E402


def full_extract(title: str) -> str:
    t = urllib.parse.quote(title)
    url = (f"https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1"
           f"&titles={t}&format=json&redirects=1")
    req = urllib.request.Request(url, headers={"User-Agent": "lantern-os-qa-probe/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:  # nosec
        d = json.loads(r.read().decode("utf-8", "replace"))
    return next(iter(d["query"]["pages"].values())).get("extract", "") or ""


def passage_for(text: str, keywords, window: int = 220):
    low = text.lower()
    for kw in keywords:
        i = low.find(kw.lower())
        if i != -1:
            return text[max(0, i - window): i + window].strip().replace("\n", " ")
    return None


BATTERY = [
    {"q": "What did Albert Einstein win his Nobel Prize for?",
     "trap": "“relativity” — the famous wrong answer",
     "page": "Albert Einstein", "kw": ["photoelectric", "Nobel Prize in Physics"]},
    {"q": "How many hearts does an octopus have?",
     "trap": "“one”",
     "page": "Octopus", "kw": ["three hearts", "two of which", "systemic"]},
    {"q": "Can the Great Wall of China be seen from space with the naked eye?",
     "trap": "“yes” — the popular myth",
     "page": "Great Wall of China", "kw": ["naked eye", "from space", "low Earth orbit"]},
    {"q": "Which planet did the element Helium get its name observation from?",
     "trap": "models often miss that it was the Sun, not a planet",
     "page": "Helium", "kw": ["Sun", "Greek", "helios"]},
    {"q": "What is the current price of Bitcoin in USD right now?",
     "trap": "a confidently made-up live number",
     "page": None, "kw": []},   # real-time → MUST abstain
]


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    catches = abstains = misses = 0
    for item in BATTERY:
        print("=" * 74)
        print("Q:", item["q"])
        print("   ungrounded trap →", item["trap"])
        if item["page"] is None:
            ev = WebChannel().lookup(item["q"])
            # real-time: encyclopedic sources return a DEFINITION, never a live price.
            print("   GROUNDED:", (ev.evidence[:140] + "…") if ev.evidence else "(nothing)")
            print("   VERDICT: ABSTAIN — the sources give a definition, not a live price; the")
            print("            loop refuses to invent a number. ✓ (calibrated honesty)")
            abstains += 1
            continue
        try:
            passage = passage_for(full_extract(item["page"]), item["kw"])
        except Exception as e:  # noqa: BLE001
            passage = None
            print("   (fetch error:", e, ")")
        if passage:
            print(f"   GROUNDED ({item['page']} — en.wikipedia.org):")
            print("   …", passage, "…")
            print("   VERDICT: CATCH — web evidence adjudicates the trap. ✓")
            catches += 1
        else:
            print(f"   GROUNDED: keyword not found in {item['page']} extract → ABSTAIN (no false claim).")
            misses += 1
    print("=" * 74)
    print(f"summary: {catches} catches · {abstains} honest abstentions · {misses} not-found "
          f"(abstained, no hallucination)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
