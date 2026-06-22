"""
Rebalance the Σ₀ Ouro FC training corpus per the 2026-06-21 retraining handoff (P0).

Root cause of the FC adapter's unreliability is *data composition*, not architecture
(docs/research/2026-06-21-sigma0-coder-retraining-handoff.md). This script rebuilds the
corpus to fix it, doing six things:

  1. PARITY FIX — re-render the canonical (repo-trace) positives through the bridge's
     EXACT `_render_tools` preamble. The harvested rows store only the bare user query
     (harvest_tool_traces.py:155), but the live server always prepends the preamble, so
     the trigger examples were train/serve-mismatched -> under-triggering. Every row this
     script emits is built through `_render_tools` (the same serializer the server uses).
  2. TOOL REBALANCE — downsample Bash (~45% of canonical positives) and floor the rare
     tools (Glob/Write/LS) so no canonical tool dominates the gradient.
  3. DEGENERATE-BASH CLEANUP + cat/find/grep REWRITE — drop empty/single-token shell
     commands; rewrite `cat`->Read, `find`->Glob, `grep`/`rg`->Grep as paired examples so
     the model learns the dedicated-tool boundary (and it upsamples Read/Glob/Grep).
  4. HAMMER FUNCTION-MASKING (arXiv:2410.04587) — for ~50% of canonical positives, alias
     every tool NAME and PARAM name to random tokens (keeping the human-readable
     description) and relabel the gold call. Forces description-grounded selection and
     kills the "Bash" token bias. Public-FC positives are already name-diverse (1,289 +
     8,363 distinct names) so they don't need masking.
  5. NEGATIVES — downsample to ~11% of the corpus and DIVERSIFY (the source has only 3
     refusal strings -> template-generate hundreds), plus synthesize missing-param
     clarifications (tool exists, required arg absent -> ask, don't fabricate).
  6. POSITIVE-PROSE class (~9%) — normal helpful answers with NO tool and NO refusal
     template, so the model relearns the {answer normally} mode it lost.

Privacy: the repo-trace corpus is known to carry real key patterns that the original
harvest redaction missed (hyphenated keys). This script RE-REDACTS every trace-derived
string with a broader pattern, never prints row bodies, and writes only to a gitignored
training-data*.jsonl path. Do not commit the output.

Usage:
  python scripts/rebalance_fc_corpus.py \
      --src   models/lantern-sigma0-coder \
      --out   models/lantern-sigma0-coder/training-data-rebalanced.jsonl
"""
import argparse
import json
import os
import random
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ouro_anthropic_bridge import _render_tools, parse_tool_call  # exact server preamble + parser

SEED = 1729
MAX_CHARS = 6000  # match convert_fc_dataset: drop rows whose instruction+output exceeds this

# ── canonical tool defs (Anthropic shape) — transcribed from tool-runner.js REGISTRY ──
CANONICAL_TOOLS = [
    {"name": "Read", "description": "Read a file from the filesystem (repo-relative).",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["file_path"]}},
    {"name": "LS", "description": "List the entries of a directory (repo-relative).",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "Glob", "description": "Find files matching a glob pattern (e.g. **/*.js).",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}},
    {"name": "Grep", "description": "Search file contents for a regular expression.",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}},
    {"name": "Bash", "description": "Run an allowlisted shell command (git/tests/file-reads). Operator only.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
    {"name": "PowerShell", "description": "Run an allowlisted command (same allowlist as Bash). Operator only.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
    {"name": "Write", "description": "Write a file (repo-relative), overwriting it. Operator only.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "content": {"type": "string"}}, "required": ["file_path", "content"]}},
    {"name": "Edit", "description": "Replace an exact unique string in a file (repo-relative). Operator only.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}, "required": ["file_path", "old_string", "new_string"]}},
]
CANON_BY_NAME = {t["name"]: t for t in CANONICAL_TOOLS}
CANON_NAMES = list(CANON_BY_NAME)

# per-tool target counts among canonical positives (Bash a plurality but not dominant;
# rare tools floored). Sum ~5,400 -> each tool 7-17%, satisfying "no tool >25%, none <12%"
# of the canonical 6 (LS/PowerShell are genuinely rarer in real use).
TARGETS = {"Bash": 900, "Read": 800, "Edit": 700, "Grep": 700,
           "Write": 650, "Glob": 650, "PowerShell": 600, "LS": 400}

# broader than harvest_tool_traces.SECRET_RE — also catches hyphenated/prefixed keys
SECRET_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9\-_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9\-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9\-]{10,}"
    r"|AIza[0-9A-Za-z_\-]{30,}|[A-Fa-f0-9]{40,})")


def redact(s):
    return SECRET_RE.sub("[REDACTED]", s) if isinstance(s, str) else s


def redact_input(inp):
    return {k: (redact(v) if isinstance(v, str) else v) for k, v in (inp or {}).items()}


def render_call(name, args):
    return "<tool_call>" + json.dumps({"name": name, "input": args or {}}, ensure_ascii=False) + "</tool_call>"


def row(instruction, output):
    return {"instruction": instruction, "input": "", "output": output}


def pos_row(tools, query, name, args):
    """A positive row, serializer-parity by construction (preamble via _render_tools)."""
    return row(_render_tools(tools) + "\n\n" + query, render_call(name, args))


def read_jsonl(fp):
    out = []
    if not os.path.exists(fp):
        return out
    with open(fp, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def first_call(output):
    """Extract the FIRST (name, input) from a harvested output (may have lead text / multi-call)."""
    m = re.search(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", output, re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(1))
    except Exception:
        return None
    name = obj.get("name")
    inp = obj.get("input")
    if not isinstance(inp, dict):
        inp = {}
    return (name, inp) if isinstance(name, str) else None


# ── degenerate-shell + cat/find/grep -> typed-tool rewrites ───────────────────────────
def is_degenerate_shell(cmd):
    c = (cmd or "").strip()
    if not c:
        return True
    toks = c.split()
    # single bare token with no arguments (e.g. "ls", "pwd") teaches nothing useful
    return len(toks) <= 1


_CAT_RE = re.compile(r"^cat\s+([^\s|;&><]+)\s*$")
_FIND_RE = re.compile(r"^find\s+([^\s]+)\s+-name\s+['\"]?([^\s'\"]+)['\"]?\s*$")
_GREP_RE = re.compile(r"^(?:grep|rg)\s+(?:-[A-Za-z]+\s+)*['\"]?([^\s'\"]+)['\"]?\s+([^\s|;&><]+)\s*$")


def rewrite_shell_to_typed(cmd):
    """cat<file>->Read, find<dir>-name<glob>->Glob, grep/rg<pat><path>->Grep. Else None."""
    c = (cmd or "").strip()
    m = _CAT_RE.match(c)
    if m:
        return ("Read", {"file_path": m.group(1)})
    m = _FIND_RE.match(c)
    if m:
        return ("Glob", {"pattern": m.group(2), "path": m.group(1)})
    m = _GREP_RE.match(c)
    if m:
        return ("Grep", {"pattern": m.group(1), "path": m.group(2)})
    return None


# ── Hammer function-masking ───────────────────────────────────────────────────────────
def _alias(rng, n):
    return "".join(rng.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(n))


def hammer_mask(query, name, args, rng):
    """Alias every canonical tool NAME + PARAM name to random tokens (keep descriptions),
    relabel the gold call. Returns (masked_tools, masked_name, masked_args)."""
    name_map = {tn: "fn_" + _alias(rng, 4) for tn in CANON_NAMES}
    masked_tools = []
    param_maps = {}
    for t in CANONICAL_TOOLS:
        props = t["input_schema"].get("properties", {})
        pmap = {p: "p_" + _alias(rng, 3) for p in props}
        param_maps[t["name"]] = pmap
        masked_tools.append({
            "name": name_map[t["name"]],
            "description": t["description"],  # description kept -> grounding signal
            "input_schema": {
                "type": "object",
                "properties": {pmap[p]: v for p, v in props.items()},
                "required": [pmap[p] for p in t["input_schema"].get("required", []) if p in pmap],
            },
        })
    pm = param_maps.get(name, {})
    masked_args = {pm.get(k, k): v for k, v in (args or {}).items()}
    return masked_tools, name_map.get(name, name), masked_args


# ── synthesis (varied params) to floor under-represented tools without dup-memorization ──
EXTS = ["js", "py", "ts", "json", "md", "jsonl", "html", "css", "sh", "ps1", "yml", "txt"]
DIRS = ["src", "scripts", "apps/lantern-garage/lib", "apps/lantern-garage/public", "docs",
        "tests", "data", "models", "src/csf", "src/sigma0", "apps/lantern-garage/routes"]
FILES = ["README.md", "package.json", "server.js", "CHANGELOG.MD", "requirements.txt",
         "scripts/ouro_serve.py", "docs/SIGMA0-COLLAPSE-CERTIFICATE.md", "AGENTS.md",
         "apps/lantern-garage/lib/tool-runner.js", "CLAUDE.md", ".gitignore"]
PATTERNS = ["TODO", "FIXME", "import", "def ", "function", "require\\(", "class ", "async ",
            "ANTHROPIC", "convergence", "tool_call", "Σ₀"]


def synth_positive(tool, rng):
    """One varied (query, name, args) for the given canonical tool."""
    if tool == "LS":
        d = rng.choice(DIRS)
        q = rng.choice([f"List the files in {d}", f"What's in the {d} directory?",
                        f"Show me the contents of {d}/"])
        return q, "LS", {"path": d}
    if tool == "Glob":
        e = rng.choice(EXTS); d = rng.choice(DIRS + ["."])
        scope = "" if d == "." else f" under {d}"
        q = rng.choice([f"Find all {e} files{scope}", f"Locate every *.{e} file{scope}",
                        f"Which {e} files exist{scope}?"])
        args = {"pattern": f"**/*.{e}"}
        if d != ".":
            args["path"] = d
        return q, "Glob", args
    if tool == "Grep":
        p = rng.choice(PATTERNS); d = rng.choice(DIRS + ["."])
        scope = "" if d == "." else f" in {d}"
        q = rng.choice([f"Search for {p!r}{scope}", f"Where is {p!r} used{scope}?",
                        f"Grep for {p}{scope}"])
        args = {"pattern": p}
        if d != ".":
            args["path"] = d
        return q, "Grep", args
    if tool == "Read":
        f = rng.choice(FILES)
        q = rng.choice([f"Read {f}", f"Show me {f}", f"Open {f} and show its contents",
                        f"What's in {f}?"])
        return q, "Read", {"file_path": f}
    if tool == "Write":
        f = rng.choice(["notes.md", "scratch.txt", "out/result.json", "tmp/plan.md", "TODO.txt"])
        q = rng.choice([f"Create {f} with a short header", f"Write a placeholder {f}"])
        return q, "Write", {"file_path": f, "content": rng.choice(["# Notes\n", "placeholder\n", "{}\n", "TODO\n"])}
    if tool == "Edit":
        f = rng.choice(FILES)
        old = rng.choice(["version", "TODO", "0.1.0", "draft", "placeholder"])
        q = rng.choice([f"In {f}, change {old!r} to its replacement", f"Update the {old!r} string in {f}"])
        return q, "Edit", {"file_path": f, "old_string": old, "new_string": old + "-updated"}
    if tool in ("Bash", "PowerShell"):
        cmd = rng.choice(["git status", "git log --oneline -5", "npm test",
                          "python -m pytest tests/ -q", "git diff --stat", "node --check server.js"])
        q = rng.choice([f"Run `{cmd}`", f"Execute {cmd}", f"Can you run {cmd}?"])
        return q, tool, {"command": cmd}
    raise ValueError(tool)


# ── negatives: diverse refusals + missing-param clarifications ────────────────────────
_OPEN = ["None of the available tools can do that.", "I don't have a tool that fits this.",
         "There's no applicable tool here.", "That's outside what these tools cover.",
         "No tool in this set matches that request.", "I can't do that with the tools I have.",
         "That isn't something the available tools support.", "None of these tools apply here."]
_FOLLOW = ["Could you clarify what you need?", "Want me to help another way?",
           "Can you give more detail about the goal?", "Is there a file or command involved?",
           "Let me know how you'd like to proceed.", "Happy to help if you can rephrase it.",
           "What outcome are you after?", "Tell me more and I'll point you in the right direction."]
_MISSING = {  # tool -> (query template, which required arg is omitted, clarifying ask)
    "Read": ("Read the config file for me.", "file_path", "Which file should I read? Give me the path."),
    "Grep": ("Search the codebase for that pattern.", "pattern", "What pattern should I search for?"),
    "Glob": ("Find the matching files.", "pattern", "What glob pattern should I match (e.g. **/*.py)?"),
    "Edit": ("Update that string in the file.", "old_string", "Which file, and what exact text should I replace?"),
    "Write": ("Create the file we discussed.", "content", "What path and contents should the file have?"),
    "Bash": ("Run the build.", "command", "Which command should I run?"),
}


def diverse_refusals(rng, n):
    pool = []
    for o in _OPEN:
        for f in _FOLLOW:
            pool.append(o + " " + f)
    rng.shuffle(pool)
    return pool[:n]


def build_negatives(neg_src, rng, target):
    """Reassign downsampled irrelevance rows to diverse refusals + add missing-param asks."""
    rng.shuffle(neg_src)
    keep = neg_src[:max(0, target - target // 4)]  # ~3/4 irrelevance, ~1/4 missing-param
    refusals = diverse_refusals(rng, max(len(keep), 1))
    out = []
    for i, r in enumerate(keep):
        instr = r.get("instruction", "")
        if "Available tools:" not in instr:  # ensure preamble present (parity)
            continue
        out.append(row(instr, refusals[i % len(refusals)]))
    # missing-param clarifications (tool exists, required arg absent -> ask)
    need = max(0, target - len(out))
    items = list(_MISSING.items())
    for i in range(need):
        tool, (q, _arg, ask) = items[i % len(items)]
        out.append(row(_render_tools(CANONICAL_TOOLS) + "\n\n" + q, ask))
    rng.shuffle(out)
    return out[:target]


# ── positive-prose: answer-normally (no tool, no refusal) ─────────────────────────────
PROSE_QA = [
    ("What's the difference between Glob and Grep?",
     "Glob matches files by name pattern (e.g. **/*.py finds Python files); Grep searches the text *inside* files for a regex. Use Glob to locate files, Grep to find content."),
    ("When should I use a tool versus just answering?",
     "Call a tool only when you need live information from the system — reading a file, listing a directory, running a check. For explanations, definitions, or reasoning you already know, just answer in plain text."),
    ("What does QLoRA do?",
     "QLoRA fine-tunes a model by quantizing the frozen base to 4-bit and training small low-rank adapter matrices on top, so a large model fits and trains on a single consumer GPU."),
    ("Explain what a recurrent/looped transformer is in one line.",
     "It reuses the same weight-tied block for several passes over the hidden state, trading extra compute (depth in time) for parameters — more 'thinking steps' without more weights."),
    ("Why mask the prompt during fine-tuning?",
     "Completion-only loss masks the prompt tokens so gradients land only on the tokens you want the model to learn to produce, not on copying back the instruction."),
    ("What's a good commit message style?",
     "A short imperative summary under ~72 chars (e.g. 'fix: handle empty body'), optionally followed by a blank line and a body explaining the why."),
    ("How do I list files versus read one?",
     "Listing a directory's entries and reading a single file are different actions — one enumerates names, the other returns contents. Pick the tool whose description matches the action you need."),
    ("What is train/serve parity and why does it matter?",
     "It means the prompt format used in training is byte-for-byte what the server sends at inference. If they differ, the model sees an unfamiliar distribution at serve time and behaves unreliably."),
]


def build_prose(codegen_rows, rng, target):
    out = []
    # hand-written conceptual Q&A (rendered WITH the preamble for parity)
    for q, a in PROSE_QA:
        out.append(row(_render_tools(CANONICAL_TOOLS) + "\n\n" + q, a))
    # codegen seeds: no-tool answers; wrap their query with the preamble for parity
    for r in codegen_rows:
        instr, outp = r.get("instruction", ""), r.get("output", "")
        if not instr or not outp or parse_tool_call(outp):
            continue
        if "Available tools:" not in instr:
            instr = _render_tools(CANONICAL_TOOLS) + "\n\n" + instr
        out.append(row(instr, outp))
    rng.shuffle(out)
    return out[:target]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="models/lantern-sigma0-coder")
    ap.add_argument("--out", default="models/lantern-sigma0-coder/training-data-rebalanced.jsonl")
    ap.add_argument("--public", type=int, default=4000, help="public-FC positives to keep (hermes+toolace)")
    ap.add_argument("--mask-frac", type=float, default=0.5, help="fraction of canonical positives to Hammer-mask")
    ap.add_argument("--neg-frac", type=float, default=0.11)
    ap.add_argument("--prose-frac", type=float, default=0.09)
    a = ap.parse_args()
    rng = random.Random(SEED)
    src = a.src

    # ── 1. canonical positives: clean + rewrite + bucket by tool ──────────────────────
    by_tool = {n: [] for n in CANON_NAMES}
    rewrites = Counter()
    dropped_degenerate = 0
    for r in read_jsonl(os.path.join(src, "tool-trace-pairs.jsonl")):
        fc = first_call(r.get("output", ""))
        if not fc:
            continue
        name, inp = fc
        name = "Bash" if name == "bash" else name
        if name not in CANON_BY_NAME:
            continue
        query = redact((r.get("instruction") or "").strip())
        if not query or len(query) < 8:
            continue
        inp = redact_input(inp)
        if name in ("Bash", "PowerShell"):
            cmd = inp.get("command", "")
            if is_degenerate_shell(cmd):
                dropped_degenerate += 1
                continue
            rw = rewrite_shell_to_typed(cmd)
            if rw:
                name, inp = rw  # cat/find/grep -> typed tool
                rewrites[name] += 1
        by_tool[name].append((query, name, inp))

    # ── 2. resample to TARGETS (draw real first, synth-fill the rest) ─────────────────
    canonical = []
    synth_added = Counter()
    for tool, target in TARGETS.items():
        real = by_tool[tool][:]
        rng.shuffle(real)
        take = real[:target]
        canonical.extend(take)
        for _ in range(max(0, target - len(take))):
            canonical.append(synth_positive(tool, rng))
            synth_added[tool] += 1
    rng.shuffle(canonical)

    # ── 3. render canonical positives through the preamble (PARITY) + Hammer-mask ~50% ─
    n_mask = int(len(canonical) * a.mask_frac)
    canon_rows, masked = [], 0
    for i, (query, name, args) in enumerate(canonical):
        if i < n_mask:
            mt, mname, margs = hammer_mask(query, name, args, rng)
            canon_rows.append(pos_row(mt, query, mname, margs)); masked += 1
        else:
            canon_rows.append(pos_row(CANONICAL_TOOLS, query, name, args))

    # ── 4. public-FC positives (already name-diverse + preamble'd): sample passthrough ─
    public = read_jsonl(os.path.join(src, "fc-hermes.jsonl")) + read_jsonl(os.path.join(src, "fc-toolace.jsonl"))
    public = [r for r in public if parse_tool_call(r.get("output", ""))]
    rng.shuffle(public)
    public = public[:a.public]

    positives = canon_rows + public

    # ── 5/6. size negatives + prose as fractions of the FINAL corpus ──────────────────
    # total = pos + neg + prose ; neg = neg_frac*total ; prose = prose_frac*total
    denom = 1.0 - a.neg_frac - a.prose_frac
    total = int(len(positives) / denom) if denom > 0 else len(positives)
    n_neg = int(total * a.neg_frac)
    n_prose = int(total * a.prose_frac)
    negatives = build_negatives(read_jsonl(os.path.join(src, "fc-negatives.jsonl")), rng, n_neg)
    codegen = (read_jsonl(os.path.join(src, "training-data.harvested.jsonl"))
               + read_jsonl(os.path.join(src, "coding-seed.jsonl"))
               + read_jsonl(os.path.join(src, "coding-extra.jsonl")))
    prose = build_prose(codegen, rng, n_prose)

    rows = positives + negatives + prose
    rng.shuffle(rows)

    # ── validate (parity + label correctness) + size cap ──────────────────────────────
    final, bad_pos, bad_neg, oversize = [], 0, 0, 0
    pos_set = {id(r) for r in positives}
    nonpos_set = {id(r) for r in negatives} | {id(r) for r in prose}
    for r in rows:
        instr, outp = r["instruction"], r["output"]
        if len(instr) + len(outp) > MAX_CHARS:
            oversize += 1; continue
        is_call = bool(parse_tool_call(outp))
        if id(r) in pos_set and not is_call:
            bad_pos += 1; continue
        if id(r) in nonpos_set and is_call:
            bad_neg += 1; continue   # a "no-tool" row that accidentally parses as a call
        if "Available tools:" not in instr:
            continue                 # enforce preamble parity on every row
        # final belt-and-suspenders redaction over EVERY row (public-FC + prose included,
        # not just trace-derived) so no key pattern can survive from any source. [REDACTED]
        # has no quotes, so a redacted tool-call value stays valid JSON / still parses.
        final.append({"instruction": redact(instr), "input": "", "output": redact(outp)})

    # ── write (gitignored) + report ───────────────────────────────────────────────────
    outp_path = Path(a.out)
    outp_path.parent.mkdir(parents=True, exist_ok=True)
    with open(outp_path, "w", encoding="utf-8") as f:
        for r in final:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    n = len(final)
    n_pos = sum(1 for r in final if parse_tool_call(r["output"]))
    n_non = n - n_pos
    # canonical-tool distribution among UNMASKED canonical positives (masked names are aliased)
    canon_dist = Counter()
    for r in final:
        tc = parse_tool_call(r["output"])
        if tc and tc["name"] in CANON_BY_NAME:
            canon_dist[tc["name"]] += 1
    print("=" * 64)
    print(f"REBALANCED CORPUS -> {outp_path}  ({outp_path.stat().st_size/1024/1024:.1f} MB)")
    print("=" * 64)
    print(f"rows={n}  positives={n_pos} ({100*n_pos/n:.1f}%)  non-call={n_non} ({100*n_non/n:.1f}%)")
    print(f"  negatives target={n_neg}  prose target={n_prose}")
    print(f"canonical positives={len(canon_rows)}  (Hammer-masked={masked}, {100*masked/max(len(canon_rows),1):.0f}%)")
    print(f"public-FC positives={len(public)}")
    print(f"shell cleanup: dropped degenerate={dropped_degenerate}  rewrites cat/find/grep->typed={dict(rewrites)}")
    print(f"synth-filled per tool: {dict(synth_added)}")
    print(f"validation: dropped bad-positive={bad_pos} bad-negative(parsed-as-call)={bad_neg} oversize={oversize}")
    print("real-name canonical-tool counts (unmasked; masked rows use aliases):")
    for t in CANON_NAMES:
        print(f"   {t:<11} {canon_dist.get(t,0)}")
    print("NOTE: output carries key patterns from traces -> gitignored; do not commit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
