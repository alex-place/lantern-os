"""
Convert public function-calling datasets into the Σ₀ Ouro training format.

Turns HuggingFace FC datasets into {instruction, input, output} rows that
scripts/train-qlora-ouro.py consumes, where:
  - instruction = the bridge's EXACT injected tool preamble (_render_tools) + the user query
                  (train/serve format parity — the #1 rule for tiny-model FC), and
  - output      = a single-line  <tool_call>{"name":...,"input":{...}}</tool_call>  (positive)
                  or a plain no-call refusal (NEGATIVE / irrelevance — stops over-triggering).

Sources (permissive, ungated):
  hermes      NousResearch/hermes-function-calling-v1  (Apache-2.0)  -> positives
  irrelevance MadeAgents/xlam-irrelevance-7.5k         (CC-BY-4.0)   -> negatives

Research basis: Hammer (arXiv:2410.04587) — irrelevance negatives + format parity are
what fix sub-3B over-triggering; Hermes <tool_call> tags map 1:1 onto our wire format.

Usage:
  python scripts/convert_fc_dataset.py --source hermes      --out models/lantern-sigma0-coder/fc-hermes.jsonl
  python scripts/convert_fc_dataset.py --source irrelevance --out models/lantern-sigma0-coder/fc-negatives.jsonl
"""
import argparse
import ast
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ouro_anthropic_bridge import _render_tools, parse_tool_call  # exact inference preamble + parser

REFUSALS = [
    "None of the available tools can do that. Could you clarify what you need, or rephrase the request?",
    "I don't have a tool that fits this request. Let me know if you'd like me to help another way.",
    "There's no applicable tool here for that. Can you give more detail about what you're trying to do?",
]


def _loads(x):
    if isinstance(x, (dict, list)):
        return x
    if not isinstance(x, str):
        return None
    try:
        return json.loads(x)
    except Exception:
        return None


def _norm_tool(t):
    """Normalize one tool def from various shapes -> {name, description, input_schema}."""
    if not isinstance(t, dict):
        return None
    if t.get("type") == "function" and isinstance(t.get("function"), dict):
        t = t["function"]
    name = t.get("name")
    if not name:
        return None
    return {"name": name, "description": t.get("description", ""),
            "input_schema": t.get("parameters") or t.get("input_schema") or {"type": "object", "properties": {}}}


def _tools_from_system(system_text):
    """Pull the <tools>…</tools> block (newline-delimited JSON objects) from a Hermes system turn."""
    if not system_text:
        return []
    m = re.search(r"<tools>(.*?)</tools>", system_text, re.DOTALL | re.IGNORECASE)
    blob = m.group(1) if m else system_text
    tools = []
    # try a JSON array first, else parse each brace-balanced object
    arr = _loads(blob.strip())
    cand = arr if isinstance(arr, list) else _iter_objs(blob)
    for obj in cand:
        o = obj if isinstance(obj, dict) else _loads(obj)
        nt = _norm_tool(o)
        if nt:
            tools.append(nt)
    return tools


def _iter_objs(s):
    depth = 0; start = None
    for i, c in enumerate(s):
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and start is not None:
                yield s[start:i + 1]; start = None


def _render_call(name, args):
    return '<tool_call>' + json.dumps({"name": name, "input": args or {}}, ensure_ascii=False) + '</tool_call>'


def _calls_from_assistant(value):
    """Extract (name, input) from a Hermes gpt turn's <tool_call> blocks (arguments->input)."""
    out = []
    for m in re.finditer(r"<tool_call>\s*(.*?)\s*</tool_call>", value, re.DOTALL | re.IGNORECASE):
        obj = _loads(m.group(1))
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        args = obj.get("arguments")
        if isinstance(args, str):
            args = _loads(args) or {}
        if not isinstance(args, dict):
            args = obj.get("input") if isinstance(obj.get("input"), dict) else {}
        if name:
            out.append((name, args))
    return out


def convert_hermes(limit, max_chars):
    from datasets import load_dataset
    try:
        from datasets import get_dataset_config_names
        configs = get_dataset_config_names("NousResearch/hermes-function-calling-v1")
    except Exception:
        configs = ["func_calling_singleturn", "func_calling", "glaive_func_calling"]
    repo = "NousResearch/hermes-function-calling-v1"
    # only configs that actually carry tool calls (skip pure json-mode)
    configs = [c for c in configs if "func_calling" in c] or configs
    rows = []
    for cfg in configs:
        try:
            ds = load_dataset(repo, cfg, split="train")
        except Exception as e:
            print(f"  [skip {cfg}: {e}]"); continue
        n0 = len(rows)
        for ex in ds:
            convs = ex.get("conversations") or ex.get("messages")
            if not isinstance(convs, list):
                continue
            # prefer the top-level `tools` field (a JSON string); the system message
            # also says "within <tools> </tools> XML tags", so regex-parsing it grabs
            # that empty mention. Fall back to system parsing only if absent.
            tools = [t for t in (_norm_tool(t) for t in (_loads(ex.get("tools")) or [])) if t]
            last_user = ""
            for turn in convs:
                role = turn.get("from") or turn.get("role")
                val = turn.get("value") or turn.get("content") or ""
                if role == "system" and not tools:
                    tools = _tools_from_system(val)
                elif role in ("human", "user"):
                    last_user = val.strip()
                elif role in ("gpt", "assistant"):
                    calls = _calls_from_assistant(val)
                    if calls and tools and last_user:
                        name, args = calls[0]  # single-call: first call
                        instr = _render_tools(tools) + "\n\n" + last_user
                        output = _render_call(name, args)
                        if len(instr) + len(output) <= max_chars:
                            rows.append({"instruction": instr, "input": "", "output": output})
            if limit and len(rows) >= limit:
                break
        print(f"  {cfg}: +{len(rows)-n0} rows")
        if limit and len(rows) >= limit:
            break
    return rows[:limit] if limit else rows


def _balanced_span(s, start, open_c, close_c):
    """Return end index (inclusive) of the open_c at `start` matched with close_c, string-aware."""
    depth = 0; instr = False; esc = False; q = ""
    for j in range(start, len(s)):
        c = s[j]
        if instr:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == q: instr = False
            continue
        if c in ('"', "'"): instr = True; q = c
        elif c == open_c: depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j
    return -1


def _tools_from_toolace_system(system_text):
    """Pull the JSON tool array that follows 'invoke:' in a ToolACE system prompt."""
    i = system_text.find("[", system_text.find("invoke:") if "invoke:" in system_text else 0)
    if i == -1:
        return []
    end = _balanced_span(system_text, i, "[", "]")
    arr = _loads(system_text[i:end + 1]) if end != -1 else None
    return [t for t in (_norm_tool(x) for x in (arr or [])) if t] if isinstance(arr, list) else []


def _split_top_calls(inner):
    calls = []; depth = 0; instr = False; esc = False; q = ""; start = 0
    for i, c in enumerate(inner):
        if instr:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == q: instr = False
            continue
        if c in ('"', "'"): instr = True; q = c
        elif c in "([{": depth += 1
        elif c in ")]}": depth -= 1
        elif c == "," and depth == 0:
            calls.append(inner[start:i]); start = i + 1
    if inner[start:].strip():
        calls.append(inner[start:])
    return [c.strip() for c in calls if c.strip()]


def _parse_toolace_calls(value):
    """ToolACE assistant DSL  [Name(k=v, ...), ...]  -> list of (name, input dict)."""
    v = (value or "").strip()
    if not (v.startswith("[") and v.endswith("]")):
        return []
    out = []
    for cs in _split_top_calls(v[1:-1]):
        i = cs.find("(")
        if i == -1:
            continue
        name = cs[:i].strip()
        end = _balanced_span(cs, i, "(", ")")
        if not name or end == -1:
            continue
        try:
            node = ast.parse(f"_f({cs[i + 1:end]})", mode="eval").body
        except Exception:
            out.append((name, {})); continue
        inp = {}
        for kw in node.keywords:
            try:
                inp[kw.arg] = ast.literal_eval(kw.value)
            except Exception:
                try:
                    inp[kw.arg] = ast.unparse(kw.value)
                except Exception:
                    inp[kw.arg] = None
        for idx, arg in enumerate(node.args):
            try:
                inp[f"arg{idx}"] = ast.literal_eval(arg)
            except Exception:
                pass
        out.append((name, inp))
    return out


def convert_toolace(limit, max_chars):
    from datasets import load_dataset
    ds = load_dataset("Team-ACE/ToolACE", split="train")
    rows = []
    for ex in ds:
        convs = ex.get("conversations")
        if not isinstance(convs, list):
            continue
        tools = _tools_from_toolace_system(ex.get("system", ""))
        if not tools:
            continue
        last_user = ""
        for turn in convs:
            role, val = turn.get("from"), turn.get("value") or ""
            if role == "user":
                last_user = val.strip()
            elif role == "assistant":
                calls = _parse_toolace_calls(val)
                if calls and last_user:
                    name, args = calls[0]
                    instr = _render_tools(tools) + "\n\n" + last_user
                    output = _render_call(name, args)
                    if len(instr) + len(output) <= max_chars:
                        rows.append({"instruction": instr, "input": "", "output": output})
        if limit and len(rows) >= limit:
            break
    return rows[:limit] if limit else rows


def convert_irrelevance(limit, max_chars):
    from datasets import load_dataset
    ds = load_dataset("MadeAgents/xlam-irrelevance-7.5k", split="train")
    rows = []
    for i, ex in enumerate(ds):
        query = (ex.get("query") or "").strip()
        tools = _loads(ex.get("tools")) or []
        tools = [t for t in (_norm_tool(t) for t in tools) if t]
        if not query or not tools:
            continue
        instr = _render_tools(tools) + "\n\n" + query
        output = REFUSALS[i % len(REFUSALS)]  # NEGATIVE: no tool call
        if len(instr) + len(output) <= max_chars:
            rows.append({"instruction": instr, "input": "", "output": output})
        if limit and len(rows) >= limit:
            break
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, choices=["hermes", "toolace", "irrelevance"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-chars", type=int, default=6000, help="drop rows whose instruction+output exceeds this")
    a = ap.parse_args()

    rows = {"hermes": convert_hermes, "toolace": convert_toolace,
            "irrelevance": convert_irrelevance}[a.source](a.limit, a.max_chars)

    # validate: positives must parse as a tool call; negatives must NOT
    pos = sum(1 for r in rows if parse_tool_call(r["output"]))
    neg = len(rows) - pos
    print(f"\n{a.source}: {len(rows)} rows  (parse-as-toolcall: {pos}, plain/negative: {neg})")
    if rows:
        ex = rows[0]
        print("--- sample ---")
        print("INSTR:", ex["instruction"][:200].replace("\n", " "))
        print("OUT  :", ex["output"][:200].replace("\n", " "))

    outp = Path(a.out); outp.parent.mkdir(parents=True, exist_ok=True)
    with open(outp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} rows -> {outp} ({outp.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
