"""
Σ₀ Ouro coder — standalone tool-using agent loop (forced ReAct).

The local Σ₀ coder (Ouro-1.4B) has no tool-use training, so it will not
*spontaneously* call tools. But it reliably COMPLETES a tool call when handed the
`<tool_call>` scaffold (see docs/SIGMA0-OURO-CODER.md + the bridge). This loop
exploits that: every step it FORCES a tool call (Anthropic tool_choice:{type:"any"})
through scripts/ouro_anthropic_bridge.py, executes the chosen tool locally, feeds the
result back, and repeats until the model calls `finish` or the step budget is hit.

This is the Convergence loop on a looped brain:
  Observe (task) -> Reason (pick a tool) -> Act (run it) -> Verify (read result) -> Converge (finish)

Tools are pure-Python and sandboxed to the repo root (no shell — robust + safe).

Prereqs: ouro_serve.py on :11434 (OURO_NO_STOP=1) and ouro_anthropic_bridge.py on :8788.

Usage:
  python scripts/sigma0_coder_agent.py "How many Python files are in the scripts/ directory?"
"""
import fnmatch
import json
import os
import sys
import urllib.request

BRIDGE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8788/v1/messages")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "6"))

TOOLS = [
    {"name": "list_dir", "description": "List the entries in a directory (relative to the repo root).",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string", "description": "Directory path, e.g. 'scripts'"}}, "required": ["path"]}},
    {"name": "find_files", "description": "Find files matching a glob pattern under a directory (recursive).",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string", "description": "Glob, e.g. '*.py'"}, "dir": {"type": "string", "description": "Start directory, e.g. 'scripts'"}}, "required": ["pattern"]}},
    {"name": "read_file", "description": "Read the first lines of a text file (relative to the repo root).",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "max_lines": {"type": "integer"}}, "required": ["path"]}},
    {"name": "finish", "description": "Call this when you have the answer. Put the final answer to the user in 'answer'.",
     "input_schema": {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}},
]
TOOL_NAMES = {t["name"] for t in TOOLS}


# ----------------------------------------------------------------- safe tools
def _safe(path):
    """Resolve a user path under REPO; raise if it escapes."""
    p = os.path.realpath(os.path.join(REPO, path or "."))
    if os.path.commonpath([p, REPO]) != REPO:
        raise ValueError(f"path escapes repo: {path!r}")
    return p


def tool_list_dir(inp):
    p = _safe(inp.get("path", "."))
    if not os.path.isdir(p):
        return f"[not a directory: {inp.get('path')!r}]"
    entries = sorted(os.listdir(p))
    return f"{len(entries)} entries:\n" + "\n".join(entries[:60])


def tool_find_files(inp):
    pat = (inp.get("pattern", "*") or "*").replace("\\", "")  # weak models regex-escape globs
    base = _safe(inp.get("dir", "."))
    hits = []
    for root, _dirs, files in os.walk(base):
        if ".git" in root:
            continue
        for f in files:
            if fnmatch.fnmatch(f, pat):
                hits.append(os.path.relpath(os.path.join(root, f), REPO))
        if len(hits) > 500:
            break
    return f"{len(hits)} match(es) for {pat!r}:\n" + "\n".join(sorted(hits)[:60])


def tool_read_file(inp):
    p = _safe(inp.get("path", ""))
    n = int(inp.get("max_lines", 40) or 40)
    if not os.path.isfile(p):
        return f"[not a file: {inp.get('path')!r}]"
    with open(p, encoding="utf-8", errors="replace") as f:
        lines = [next(f, None) for _ in range(n)]
    return "".join(l for l in lines if l)[:2000]


EXECUTORS = {"list_dir": tool_list_dir, "find_files": tool_find_files, "read_file": tool_read_file}


# ----------------------------------------------------------------- bridge call
def call_bridge(messages, force=True):
    body = {
        "model": "ouro", "max_tokens": 160, "tools": TOOLS,
        "tool_choice": {"type": "any"} if force else {"type": "auto"},
        "messages": messages,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(BRIDGE, data=data, headers={
        "Content-Type": "application/json", "x-api-key": "local", "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read().decode())


def s(x):
    return str(x).encode("ascii", "replace").decode()


def run(task):
    print("=" * 72)
    print("OBSERVE  task:", s(task))
    print("=" * 72)
    messages = [{"role": "user", "content": task}]
    for step in range(1, MAX_STEPS + 1):
        resp = call_bridge(messages, force=True)
        tu = next((b for b in resp.get("content", []) if b.get("type") == "tool_use"), None)
        if not tu:
            txt = " ".join(b.get("text", "") for b in resp.get("content", []))
            print(f"[step {step}] REASON  no tool call; model said: {s(txt)[:200]}")
            break
        name, inp = tu["name"], tu.get("input", {})
        print(f"[step {step}] REASON/ACT  -> {name}({s(json.dumps(inp))[:160]})")

        if name == "finish":
            print("-" * 72)
            print("CONVERGE  final answer:")
            print(" ", s(inp.get("answer", "(no answer field)")))
            return
        if name not in EXECUTORS:
            result = f"[unknown tool {name!r}; valid: {sorted(TOOL_NAMES)}]"
        else:
            try:
                result = EXECUTORS[name](inp)
            except Exception as e:
                result = f"[tool error: {e}]"
        print(f"           VERIFY  result: {s(result)[:200].splitlines()[0] if result else '(empty)'}")
        nudge = ("\n\nBased on this result, either call another tool from "
                 f"[{', '.join(sorted(TOOL_NAMES))}], or call finish(answer) with the final answer. "
                 "Use ONLY the result above — do not guess.")
        messages.append({"role": "assistant", "content": [tu]})
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tu["id"], "content": result + nudge}]})
    else:
        print("-" * 72)
        print("CONVERGE  step budget exhausted without finish(); asking model to summarize…")
        messages.append({"role": "user", "content": "Give your final answer now in plain text."})
        resp = call_bridge(messages, force=False)
        txt = " ".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
        print(" ", s(txt)[:400])


if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) or "How many Python files are in the scripts/ directory? Use find_files then finish."
    run(task)
