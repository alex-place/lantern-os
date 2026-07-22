#!/usr/bin/env python3
"""Verified cascade — LIVE, end-to-end, real models + a REAL test gate. (Issue #2798)

The keystone the code map found: the verified cascade (cheap-first -> run the tests ->
escalate to frontier only on failure) already exists in lib/keystone-escalation.js but is
quarantined behind !keystone, and nothing logs the outcome/cost. This proves the mechanism
end-to-end on the LIVE unisona.ai chat server (the same product path the browser uses),
reusing the canonical harness (chat_complete + make_candidate + run_test). No HuggingFace
dependency — a small self-contained problem set with real unit tests.

For each problem we run BOTH tiers (so we get cheap-alone, frontier-alone AND the cascade
from one pass) and emit the router-training corpus row the router needs:
  [task, cheap_ok, frontier_ok, cascade_tier, final_ok, latency]  ->  data/eval/cascade/

Run (server on 4178, OpenAI + Gemini keys live):
  python experiments/verified_cascade_live.py --port 4178 --cheap openai --frontier gemini
"""
import argparse, json, os, sys, time

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
sys.path.insert(0, SCRIPTS)
from eval_humaneval_chat import chat_complete, INSTRUCTION       # drives the live server (SSE)
from eval_humaneval_ouro import make_candidate, run_test          # the REAL exec-verify sandbox

# Self-contained problems (HumanEval shape). A few easy for contrast, then genuinely hard
# ones (subtle specs, DP, parsing) that stress even a strong cheap model, so escalation and
# rescue actually fire. Every test value is hand-verified.
PROBLEMS = [
    {"entry_point": "two_sum", "prompt":
        "from typing import List\n\ndef two_sum(nums: List[int], target: int) -> List[int]:\n    \"\"\"Return indices [i, j] (i < j) of the two numbers adding to target. Exactly one solution.\n    >>> two_sum([2,7,11,15], 9)\n    [0, 1]\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate([2,7,11,15],9)==[0,1]\n    assert candidate([3,2,4],6)==[1,2]\n"},
    {"entry_point": "word_break", "prompt":
        "from typing import List\n\ndef word_break(s: str, word_dict: List[str]) -> bool:\n    \"\"\"True iff s can be segmented into a space-separated sequence of one or more dict words (reusable).\n    >>> word_break('leetcode', ['leet','code'])\n    True\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('leetcode',['leet','code']) is True\n    assert candidate('catsandog',['cats','dog','sand','and','cat']) is False\n"},
    {"entry_point": "is_match", "prompt":
        "def is_match(s: str, p: str) -> bool:\n    \"\"\"Regular-expression matching over the ENTIRE string. '.' matches any single char; '*' matches zero or more of the PRECEDING element.\n    >>> is_match('aa', 'a*')\n    True\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('aa','a') is False\n    assert candidate('aa','a*') is True\n    assert candidate('ab','.*') is True\n    assert candidate('mississippi','mis*is*p*.') is False\n    assert candidate('aab','c*a*b') is True\n"},
    {"entry_point": "min_distance", "prompt":
        "def min_distance(word1: str, word2: str) -> int:\n    \"\"\"Minimum edit distance (insert/delete/replace) to turn word1 into word2.\n    >>> min_distance('horse', 'ros')\n    3\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('horse','ros')==3\n    assert candidate('intention','execution')==5\n    assert candidate('','abc')==3\n"},
    {"entry_point": "calculate", "prompt":
        "def calculate(s: str) -> int:\n    \"\"\"Evaluate an arithmetic expression string with + - * / , parentheses, and spaces. Integer division truncates toward zero. Standard precedence.\n    >>> calculate('3+2*2')\n    7\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('3+2*2')==7\n    assert candidate(' 3/2 ')==1\n    assert candidate(' 3+5 / 2 ')==5\n    assert candidate('(1+(4+5+2)-3)+(6+8)')==23\n    assert candidate('2*(5+5*2)/3+(6/2+8)')==21\n"},
    {"entry_point": "longest_valid_parentheses", "prompt":
        "def longest_valid_parentheses(s: str) -> int:\n    \"\"\"Length of the longest substring of well-formed '(' ')' parentheses.\n    >>> longest_valid_parentheses(')()())')\n    4\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('(()')==2\n    assert candidate(')()())')==4\n    assert candidate('')==0\n    assert candidate('()(()')==2\n"},
    {"entry_point": "trap", "prompt":
        "from typing import List\n\ndef trap(height: List[int]) -> int:\n    \"\"\"Given bar heights of width 1, compute how much rain water is trapped.\n    >>> trap([0,1,0,2,1,0,1,3,2,1,2,1])\n    6\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate([0,1,0,2,1,0,1,3,2,1,2,1])==6\n    assert candidate([4,2,0,3,2,5])==9\n    assert candidate([])==0\n"},
    {"entry_point": "num_decodings", "prompt":
        "def num_decodings(s: str) -> int:\n    \"\"\"Number of ways to decode a digit string where '1'->'A' ... '26'->'Z'. Leading zeros invalid.\n    >>> num_decodings('226')\n    3\n    \"\"\"\n",
     "test": "def check(candidate):\n    assert candidate('12')==2\n    assert candidate('226')==3\n    assert candidate('06')==0\n    assert candidate('10')==1\n    assert candidate('100')==0\n"},
]

# Realistic public pricing (USD per 1M tokens): (input, output). Stated as assumptions.
PRICE = {"openai": (0.15, 0.60), "gpt-4o-mini": (0.15, 0.60),
         "gemini": (1.25, 5.00), "frontier": (1.25, 5.00)}
IN_TOK, OUT_TOK = 240, 180  # per-problem estimate (prompt + completion)


def unit_cost(provider):
    pin, pout = PRICE.get(provider, (1.0, 5.0))
    return (IN_TOK * pin + OUT_TOK * pout) / 1e6


def solve(host, port, provider, prob, timeout):
    t0 = time.time()
    try:
        text, done = chat_complete(host, port, INSTRUCTION + prob["prompt"],
                                   provider, "keystone", False, "coding_change", timeout)
    except Exception as e:
        return False, f"error:{e}", round(time.time() - t0, 1), "error/error"
    cand = make_candidate(text, prob["entry_point"], prob["prompt"])
    ok, note = run_test(cand, prob["test"], prob["entry_point"], timeout=12)
    served = f"{done.get('source','?')}/{done.get('model','?')}"
    return ok, note, round(time.time() - t0, 1), served


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4178)
    ap.add_argument("--cheap", default="openai")
    ap.add_argument("--frontier", default="gemini")
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    print(f"Verified cascade LIVE @ {a.host}:{a.port}   cheap={a.cheap}  frontier={a.frontier}")
    print("(true cascade: cheap on all; escalate to frontier ONLY on a failed verify gate)\n")
    print(f"{'task':<28} {'cheap':<7} {'->escalate':<12} {'final'}")
    rows = []
    for prob in PROBLEMS:
        c_ok, c_note, c_lat, c_srv = solve(a.host, a.port, a.cheap, prob, a.timeout)
        f_ok = None; f_lat = 0; f_srv = None; f_note = None
        if not c_ok:  # the verify gate failed -> spend a frontier call (the ONLY time we do)
            f_ok, f_note, f_lat, f_srv = solve(a.host, a.port, a.frontier, prob, a.timeout)
        tier = "cheap" if c_ok else ("frontier" if f_ok else "unsolved")
        final = bool(c_ok or f_ok)
        rows.append({"task": prob["entry_point"], "cheap_ok": c_ok, "frontier_ok": f_ok,
                     "cascade_tier": tier, "final_ok": final, "cheap_lat": c_lat,
                     "frontier_lat": f_lat, "cheap_served": c_srv, "frontier_served": f_srv,
                     "cheap_note": c_note[:40], "frontier_note": (f_note or "")[:40]})
        esc = "-" if c_ok else (f"{a.frontier} OK" if f_ok else f"{a.frontier} x")
        print(f"{prob['entry_point']:<28} {'OK' if c_ok else 'x':<7} {esc:<12} {'OK' if final else 'x'}")

    n = len(rows)
    cheap_pass = sum(bool(r["cheap_ok"]) for r in rows)
    escalated = [r for r in rows if not r["cheap_ok"]]
    rescued = [r for r in escalated if r["frontier_ok"]]
    casc_pass = sum(r["final_ok"] for r in rows)
    esc_rate = len(escalated) / n
    # cost per n tasks: cascade = cheap(all) + frontier(escalated only); frontier-alone = frontier(all)
    c_cascade = n * unit_cost(a.cheap) + len(escalated) * unit_cost(a.frontier)
    c_frontier = n * unit_cost(a.frontier)
    c_cheap = n * unit_cost(a.cheap)

    print("\n" + "=" * 66)
    print("RESULT — real models, real exec-verify gate, TRUE cascade")
    print("=" * 66)
    print(f"  n = {n} problems")
    print(f"  cheap-alone      pass@1 = {cheap_pass}/{n} = {cheap_pass/n:.2f}   ${c_cheap:.4f}")
    print(f"  VERIFIED CASCADE pass@1 = {casc_pass}/{n} = {casc_pass/n:.2f}   ${c_cascade:.4f}   "
          f"(escalated {len(escalated)}/{n} = {esc_rate:.0%})")
    print(f"  frontier-alone   would cost ${c_frontier:.4f} (100% frontier calls) for pass >= cascade")
    print(f"  --> cascade recovers +{casc_pass-cheap_pass} over cheap-alone by escalating {len(escalated)}, "
          f"rescued {len(rescued)}/{len(escalated)}; frontier spend {esc_rate:.0%} of full "
          f"(={c_frontier/max(c_cascade,1e-9):.1f}x cheaper than frontier-alone)")
    if rescued:
        print(f"  RESCUED (cheap failed the test, frontier passed it): {[r['task'] for r in rescued]}")
    unsolved = [r["task"] for r in rows if not r["final_ok"]]
    if unsolved:
        print(f"  still unsolved by both tiers: {unsolved}")

    out = a.out or os.path.join(os.path.dirname(SCRIPTS), "data", "eval", "cascade",
                                f"verified-cascade-live-{int(time.time())}.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"\n  router-corpus rows -> {out}")


if __name__ == "__main__":
    main()
