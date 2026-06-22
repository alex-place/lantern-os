"""
In-domain function-calling eval for the Σ₀ Ouro coder — the release GATE and the
measurement instrument for the LoopTool-style retrain loop (arXiv:2511.09148).

BFCL tests generic FC; it does NOT test OUR exact 8-tool schema, and the retraining
handoff (docs/research/2026-06-21-sigma0-coder-retraining-handoff.md §5) calls for a
small in-domain eval of gold tool-calls + gold refusals. This is that eval. It measures
the four failure modes the FC adapter actually exhibits:

  1. under-trigger / false-refusal   (answers in prose where a tool was needed)
  2. Bash over-bias                   (reaches for Bash where a typed tool fits)
  3. over-refusal                     (memorised refusal templates)
  4. malformed / missing args         (empty Bash, missing required params)

Every prompt is built through the bridge's EXACT `_render_tools` preamble (train/serve
parity), so the score reflects what the live server actually elicits.

Usage:
  # score the served adapter (ollama on :11434; model from --model or $OLLAMA_MODEL):
  python scripts/eval_fc_indomain.py --model ouro:latest --out data/eval/fc-indomain.json
  # validate the harness + gold set WITHOUT a model (CI / no-GPU):
  python scripts/eval_fc_indomain.py --self-test

Release gate (handoff §5): irrelevance >= 70 AND relevance >= 88 AND per-tool trigger
within 2x across the 6 core tools AND malformed-Bash < 2%.
"""
import argparse
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rebalance_fc_corpus import CANONICAL_TOOLS, CANON_BY_NAME  # noqa: E402
from ouro_anthropic_bridge import _render_tools, parse_tool_call  # exact preamble + parser

OLLAMA = os.environ.get("OURO_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
STOPS = ["### Instruction:", "### Response:", "\n\nUser:", "\n\nHuman:",
         "<|im_end|>", "<|endoftext|>", "<|eot_id|>"]

# ── gold set: hand-written + deliberately diverse (templated synth overfits — 2601.17829).
# expect: "call" -> must call `tool` with `required` args present (and != Bash if no_bash);
#         "refuse" -> irrelevance, must NOT call; "clarify" -> missing-param, must NOT call.
GOLD = [
    # positives — Read
    {"q": "Open package.json and show me the dependencies.", "expect": "call", "tool": "Read", "required": ["file_path"]},
    {"q": "I want to see what's inside docs/RESEARCH-CANON.md.", "expect": "call", "tool": "Read", "required": ["file_path"]},
    {"q": "Pull up the first 50 lines of server.js.", "expect": "call", "tool": "Read", "required": ["file_path"], "no_bash": True},
    # LS
    {"q": "What files live in the scripts directory?", "expect": "call", "tool": "LS", "required": ["path"]},
    {"q": "Give me a listing of apps/lantern-garage/lib.", "expect": "call", "tool": "LS", "required": ["path"]},
    # Glob
    {"q": "Find every Python file under the scripts folder.", "expect": "call", "tool": "Glob", "required": ["pattern"], "no_bash": True},
    {"q": "Which .jsonl files exist in the data tree?", "expect": "call", "tool": "Glob", "required": ["pattern"]},
    {"q": "Locate all the markdown docs in the repo.", "expect": "call", "tool": "Glob", "required": ["pattern"]},
    # Grep
    {"q": "Where in the codebase is the string ANTHROPIC_API_KEY referenced?", "expect": "call", "tool": "Grep", "required": ["pattern"], "no_bash": True},
    {"q": "Search the source for any leftover TODO comments.", "expect": "call", "tool": "Grep", "required": ["pattern"]},
    {"q": "Hunt down everywhere parse_tool_call is called.", "expect": "call", "tool": "Grep", "required": ["pattern"]},
    # Bash / PowerShell (genuinely shell-shaped)
    {"q": "Run the test suite with pytest.", "expect": "call", "tool": "Bash", "required": ["command"]},
    {"q": "Show me the current git status.", "expect": "call", "tool": "Bash", "required": ["command"]},
    {"q": "Check out the last five commits in one line each.", "expect": "call", "tool": "Bash", "required": ["command"]},
    {"q": "Use PowerShell to print the working directory.", "expect": "call", "tool": "PowerShell", "required": ["command"]},
    # Write
    {"q": "Create a file notes.md with a short heading.", "expect": "call", "tool": "Write", "required": ["file_path", "content"]},
    {"q": "Write out a scratch.txt containing the word placeholder.", "expect": "call", "tool": "Write", "required": ["file_path", "content"]},
    # Edit
    {"q": "In CHANGELOG.MD, replace the text 0.1.0 with 0.2.0.", "expect": "call", "tool": "Edit", "required": ["file_path", "old_string", "new_string"]},
    {"q": "Change the word draft to final inside docs/RESEARCH-CANON.md.", "expect": "call", "tool": "Edit", "required": ["file_path", "old_string", "new_string"]},
    # irrelevance — no tool fits (must refuse, not call)
    {"q": "What's the weather going to be in Tokyo tomorrow?", "expect": "refuse", "tool": None},
    {"q": "Translate 'good morning' into Japanese.", "expect": "refuse", "tool": None},
    {"q": "What's 17 times 23?", "expect": "refuse", "tool": None},
    {"q": "Book me a table for two at 7pm.", "expect": "refuse", "tool": None},
    {"q": "Tell me a joke about cats.", "expect": "refuse", "tool": None},
    {"q": "Who won the 2022 World Cup?", "expect": "refuse", "tool": None},
    # missing-param — tool implied but required arg absent (must ask, not fabricate)
    {"q": "Read the config file for me.", "expect": "clarify", "tool": None},
    {"q": "Search the repo for that pattern we discussed.", "expect": "clarify", "tool": None},
    {"q": "Go ahead and run the command.", "expect": "clarify", "tool": None},
    {"q": "Edit that file and fix the typo.", "expect": "clarify", "tool": None},
]

CORE6 = ["Read", "Glob", "Grep", "Bash", "Write", "Edit"]  # handoff's per-tool-balance set


def build_prompt(query):
    """Training-format prompt, parity with ouro_serve / the bridge raw path."""
    return f"### Instruction:\n{_render_tools(CANONICAL_TOOLS)}\n\n{query}\n\n### Response:\n"


def call_ollama(prompt, model):
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False,
                          "options": {"num_predict": 256, "temperature": 0.2, "stop": STOPS}}).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/generate", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read().decode()).get("response", "")


def classify(case, text):
    """Return a per-case verdict dict from the model's raw reply."""
    tc = parse_tool_call(text)
    called = tc["name"] if tc else None
    inp = tc["input"] if tc else {}
    v = {"expect": case["expect"], "called": called, "tool": case.get("tool")}
    if case["expect"] == "call":
        v["triggered"] = tc is not None                         # relevance: did it act?
        v["correct_tool"] = called == case["tool"]              # per-tool trigger
        v["args_ok"] = bool(tc) and all(str(inp.get(k, "")).strip() for k in case["required"])
        # bash-bias = a TYPED tool was expected but the model reached for a shell tool
        # (the #1 Bash-over-bias failure). The gold `no_bash` flags are just documentation.
        v["bash_violation"] = case.get("tool") not in ("Bash", "PowerShell") and called in ("Bash", "PowerShell")
        v["false_refusal"] = tc is None
    else:  # refuse / clarify -> must NOT call
        v["correct_abstain"] = tc is None
        v["over_trigger"] = tc is not None
    return v


def score(verdicts):
    pos = [v for v in verdicts if v["expect"] == "call"]
    neg = [v for v in verdicts if v["expect"] in ("refuse", "clarify")]
    n_pos, n_neg = len(pos), len(neg)
    relevance = 100 * sum(v["correct_tool"] for v in pos) / n_pos if n_pos else 0.0
    irrelevance = 100 * sum(v["correct_abstain"] for v in neg) / n_neg if n_neg else 0.0
    false_refusal = 100 * sum(v["false_refusal"] for v in pos) / n_pos if n_pos else 0.0
    malformed = 100 * sum(v["triggered"] and not v["args_ok"] for v in pos) / n_pos if n_pos else 0.0
    bash_bias = 100 * sum(v["bash_violation"] for v in pos) / max(1, sum(1 for v in pos if v.get("tool") not in ("Bash", "PowerShell")))
    # malformed specifically on shell calls
    shell = [v for v in pos if v["called"] in ("Bash", "PowerShell")]
    malformed_bash = 100 * sum(not v["args_ok"] for v in shell) / len(shell) if shell else 0.0
    # per-tool trigger rate (correct-tool / cases-for-that-tool)
    per_tool = {}
    by_tool = defaultdict(list)
    for v in pos:
        by_tool[v["tool"]].append(v)
    for t, vs in by_tool.items():
        per_tool[t] = 100 * sum(x["correct_tool"] for x in vs) / len(vs)
    core_rates = [per_tool[t] for t in CORE6 if t in per_tool]
    balanced = bool(core_rates) and min(core_rates) > 0 and (max(core_rates) <= 2 * min(core_rates))
    gate = (irrelevance >= 70) and (relevance >= 88) and balanced and (malformed_bash < 2)
    return {
        "n_pos": n_pos, "n_neg": n_neg,
        "relevance": round(relevance, 1), "irrelevance": round(irrelevance, 1),
        "false_refusal": round(false_refusal, 1), "malformed_args": round(malformed, 1),
        "malformed_bash": round(malformed_bash, 1), "bash_bias": round(bash_bias, 1),
        "per_tool_trigger": {t: round(r, 1) for t, r in sorted(per_tool.items())},
        "per_tool_balanced_2x": balanced, "RELEASE_GATE": "PASS" if gate else "FAIL",
    }


def run(model, verbose=False):
    verdicts = []
    for case in GOLD:
        text = call_ollama(build_prompt(case["q"]), model)
        v = classify(case, text)
        verdicts.append(v)
        if verbose:
            mark = "OK" if (v.get("correct_tool") or v.get("correct_abstain")) else "XX"
            print(f"  [{mark}] {case['expect']:7} want={case.get('tool') or '-':10} got={v['called'] or 'PROSE'}")
    return score(verdicts), verdicts


# ── self-test: prove the scoring logic with mock models, no real model needed ─────────
def _mock_oracle(case):
    if case["expect"] == "call":
        args = {k: ("**/*.py" if k == "pattern" else "git status" if k == "command" else "x") for k in case["required"]}
        return "<tool_call>" + json.dumps({"name": case["tool"], "input": args}) + "</tool_call>"
    return "None of the available tools can do that. Could you clarify?"


def _mock_always_bash(case):
    return '<tool_call>{"name": "Bash", "input": {"command": "ls"}}</tool_call>'


def self_test():
    ok = True
    oracle = score([classify(c, _mock_oracle(c)) for c in GOLD])
    print("oracle  ->", json.dumps({k: oracle[k] for k in ("relevance", "irrelevance", "malformed_bash", "RELEASE_GATE")}))
    assert oracle["relevance"] == 100.0 and oracle["irrelevance"] == 100.0, "oracle should be perfect"
    assert oracle["RELEASE_GATE"] == "PASS", "oracle should pass the gate"
    badbash = score([classify(c, _mock_always_bash(c)) for c in GOLD])
    print("allBash ->", json.dumps({k: badbash[k] for k in ("relevance", "irrelevance", "bash_bias", "RELEASE_GATE")}))
    assert badbash["bash_bias"] > 50, "all-Bash should show high bash bias"
    assert badbash["irrelevance"] == 0.0, "all-Bash should fail every abstention"
    assert badbash["RELEASE_GATE"] == "FAIL", "all-Bash must fail the gate"
    # gold-set sanity
    assert len({c["q"] for c in GOLD}) == len(GOLD), "duplicate gold queries"
    for c in GOLD:
        if c["expect"] == "call":
            assert c["tool"] in CANON_BY_NAME, f"unknown tool {c['tool']}"
    print(f"gold set: {len(GOLD)} cases, {sum(c['expect']=='call' for c in GOLD)} positive / "
          f"{sum(c['expect']!='call' for c in GOLD)} negative; all preamble-parity by construction.")
    print("SELF-TEST: PASS (oracle perfect, all-Bash correctly fails the gate)" if ok else "SELF-TEST: FAIL")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("OLLAMA_MODEL", "ouro:latest"))
    ap.add_argument("--out", default="")
    ap.add_argument("--self-test", action="store_true", help="validate harness + gold set, no model")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    print(f"eval model={a.model} via {OLLAMA}  ({len(GOLD)} gold cases)")
    report, verdicts = run(a.model, verbose=a.verbose)
    print(json.dumps(report, indent=2))
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps({"model": a.model, "report": report}, indent=2), encoding="utf-8")
        print(f"wrote {a.out}")
    return 0 if report["RELEASE_GATE"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
