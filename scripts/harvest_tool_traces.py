"""
Harvest TOOL-USE traces from Claude Code session transcripts into Σ₀ training data.

The opposite of scripts/extract-session-pairs.py (which *strips* tool_use). Here we
KEEP the tool calls: for every assistant turn that calls a tool, we emit a training
pair whose `output` is the assistant's tool call rendered in the bridge's exact wire
format — a single-line  <tool_call>{"name":...,"input":{...}}</tool_call> .

This teaches the Σ₀ Ouro coder the missing piece: the *trigger* — to stop and emit a
tool call instead of hallucinating the tool's output. Rows are {instruction, input,
output}, the schema scripts/train-qlora-ouro.py consumes (it uses instruction+output).

IMPORTANT — combine, don't replace: train on these tool-trace POSITIVES *together with*
the existing code-gen negatives (models/lantern-sigma0-coder/training-data.harvested.jsonl)
so the model also learns when NOT to call a tool.

Privacy: tool inputs are truncated and obvious secrets redacted; tool_result bodies are
NEVER emitted. Review the output before committing.

Usage:
  python scripts/harvest_tool_traces.py [--out models/lantern-sigma0-coder/tool-trace-pairs.jsonl]
                                        [--max-input-chars 200] [--max-output-chars 1500]
"""
import argparse
import glob
import json
import os
import re
from pathlib import Path

PROJECTS = Path.home() / ".claude" / "projects"
SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AIza[0-9A-Za-z_\-]{30,}|[A-Fa-f0-9]{40,})")
# session-bookkeeping tools that don't teach useful repo actions
SKIP_TOOLS = {"TodoWrite", "exit_plan_mode", "ExitPlanMode"}
# the file/shell/search tools a local coder agent actually has (default scope).
# The bridge passes any tool through, but training on browser/preview/compute tools
# the local model will never have just teaches it to call tools that don't exist.
CORE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "bash",
              "PowerShell", "Grep", "Glob"}


def redact(v):
    if isinstance(v, str):
        return SECRET_RE.sub("[REDACTED]", v)
    return v


def trunc_input(inp, cap):
    """Truncate long string values in a tool input + redact secrets (keeps it small,
    avoids dumping file bodies / keys into training data)."""
    if not isinstance(inp, dict):
        return {}
    out = {}
    for k, v in inp.items():
        if isinstance(v, str):
            v = redact(v)
            if len(v) > cap:
                v = v[:cap] + "…[truncated]"
        elif isinstance(v, (list, dict)):
            s = redact(json.dumps(v, ensure_ascii=False))
            v = s[:cap] + ("…[truncated]" if len(s) > cap else "")
        out[k] = v
    return out


def text_of(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(b.get("text", "").strip() for b in content
                         if isinstance(b, dict) and b.get("type") == "text").strip()
    return ""


def find_real_query(uuid, by_uuid, max_hops=25):
    cur = uuid
    for _ in range(max_hops):
        rec = by_uuid.get(cur)
        if rec is None:
            break
        if rec.get("type") == "user":
            t = text_of(rec.get("message", {}).get("content", ""))
            if t and not t.startswith("[tool_result"):
                return t
        cur = rec.get("parentUuid", "")
        if not cur:
            break
    return ""


def render_tool_call(name, inp):
    return '<tool_call>' + json.dumps({"name": name, "input": inp}, ensure_ascii=False) + '</tool_call>'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="models/lantern-sigma0-coder/tool-trace-pairs.jsonl")
    ap.add_argument("--match", default="lantern-os",
                    help="only scan project dirs whose name contains this (privacy + relevance)")
    ap.add_argument("--max-input-chars", type=int, default=200)
    ap.add_argument("--max-output-chars", type=int, default=1500)
    ap.add_argument("--max-instruction-chars", type=int, default=600)
    ap.add_argument("--all-tools", action="store_true",
                    help="harvest every tool (default: only the core file/shell/search tools)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    allow = None if a.all_tools else CORE_TOOLS

    dirs = [d for d in glob.glob(str(PROJECTS / "*")) if a.match in os.path.basename(d).lower()]
    files = []
    for d in dirs:
        files += glob.glob(os.path.join(d, "*.jsonl"))
    print(f"scanning {len(files)} session files in {len(dirs)} project dir(s) matching {a.match!r}")

    examples = []
    tool_counts = {}
    for path in files:
        records = []
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            records.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except OSError:
            continue
        by_uuid = {r["uuid"]: r for r in records if "uuid" in r}
        for r in records:
            if r.get("type") != "assistant" or r.get("isSidechain"):
                continue
            content = r.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            tool_uses = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"
                         and b.get("name") not in SKIP_TOOLS
                         and (allow is None or b.get("name") in allow)]
            if not tool_uses:
                continue
            user_q = find_real_query(r.get("parentUuid", ""), by_uuid)
            if not user_q or len(user_q) < 8:
                continue
            lead = text_of(content)
            calls = []
            for tu in tool_uses:
                tool_counts[tu["name"]] = tool_counts.get(tu["name"], 0) + 1
                calls.append(render_tool_call(tu["name"], trunc_input(tu.get("input", {}), a.max_input_chars)))
            output = ((lead + "\n") if lead else "") + "\n".join(calls)
            if len(output) > a.max_output_chars:
                continue
            examples.append({
                "instruction": redact(user_q)[:a.max_instruction_chars],
                "input": "",
                "output": output,
            })

    # dedup by (instruction, output) fingerprint
    seen, deduped = set(), []
    for e in examples:
        key = (e["instruction"][:160], e["output"][:160])
        if key not in seen:
            seen.add(key); deduped.append(e)

    print(f"tool-call turns found: {len(examples)} | after dedup: {len(deduped)}")
    print("tool distribution:", dict(sorted(tool_counts.items(), key=lambda kv: -kv[1])))
    if deduped:
        ex = deduped[0]
        print("\n--- sample ---")
        print("INSTRUCTION:", ex["instruction"][:160].replace("\n", " "))
        print("OUTPUT     :", ex["output"][:200].replace("\n", " "))

    if a.dry_run:
        return 0
    outp = Path(a.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    with open(outp, "w", encoding="utf-8") as f:
        for e in deduped:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"\nwrote {len(deduped)} rows -> {outp} ({outp.stat().st_size/1024:.1f} KB)")
    print("next (combine with code-gen negatives, then QLoRA):")
    print("  cat models/lantern-sigma0-coder/training-data.harvested.jsonl", a.out,
          "> models/lantern-sigma0-coder/training-data.jsonl")
    print("  .venv-train/Scripts/python scripts/train-qlora-ouro.py --data "
          "models/lantern-sigma0-coder/training-data.jsonl --epochs 3")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
