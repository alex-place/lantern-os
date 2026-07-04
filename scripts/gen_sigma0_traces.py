#!/usr/bin/env python3
"""
gen_sigma0_traces.py — verification-gated Σ₀ trace distillation (#1207 / Σ₀ adapter).

A TEACHER solves each task under the Σ₀ system prompt; the produced code is EXECUTED
against the task's asserts in a sandboxed subprocess, and ONLY green traces are written as
training rows. This is the iron rule from docs/SIGMA0-CONVERGENCE-ADAPTER.md: unverified
traces train hallucination, so nothing unverified is kept.

The teacher is pluggable. Two backends (auto-selected by --teacher, or forced with
--teacher-backend):
  • cloud  — the Anthropic Messages API (a frontier model, e.g. claude-opus-4-8).
  • local  — any Ollama/OpenAI-compatible server (default http://127.0.0.1:11434), so a
             LOCAL capability model (e.g. qwen2.5-coder:7b) can crystallize its skill into a
             smaller looped student (Ouro) with NO cloud dependency. A teacher id that looks
             local (contains ':' or is on the local-teacher allowlist) routes here.

Output rows match training-data.jsonl ({instruction,input,output}) so train-qlora-ouro.py
ingests them directly. Append-only; safe to re-run to grow the corpus.

Usage:
  # cloud teacher
  ANTHROPIC_API_KEY=... python scripts/gen_sigma0_traces.py \
      --tasks models/lantern-sigma0-coder/coding-seed.jsonl --teacher claude-opus-4-8 --limit 50
  # LOCAL Qwen teacher → Ouro student (fully local crystallization)
  python scripts/gen_sigma0_traces.py \
      --tasks data/distill/crystallize-tasks.jsonl --teacher qwen2.5-coder:7b --limit 50
Task rows: {fn|entry_point, instruction, asserts}  (asserts may be a list; gold `code`, if
present, is NOT shown to the teacher — we want the teacher's own verified solution).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

# Windows consoles default to cp1252 and choke on the ✓/✗/— status glyphs; force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

SIGMA0_SYS = (
    "You are a Σ₀ coding assistant. Solve the task with correct, minimal code grounded "
    "ONLY in what is given — never invent APIs or behavior you cannot justify. Output the "
    "complete solution in a single ```python fenced block, then exactly one final line:\n"
    "self-check: <the concrete property you verified, and your confidence 0-1>\n"
    "If the task is underspecified, choose the simplest correct standard-library solution."
)
API = "https://api.anthropic.com/v1/messages"
CODE_RE = re.compile(r"```(?:python)?\s*(.*?)```", re.S)
LOCAL_ENDPOINT = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")


def is_local_teacher(model):
    """A teacher id routes to the LOCAL Ollama backend when it looks like an
    ollama tag (has a ':' e.g. 'qwen2.5-coder:7b') or is an explicit local name.
    Anthropic model ids (e.g. 'claude-opus-4-8') have no ':' → cloud."""
    m = (model or "").lower()
    return (":" in m) or m.startswith(("qwen", "ouro", "keystone", "llama", "deepseek", "codellama"))


def teacher_solve_cloud(instruction, model, max_tokens=1200, timeout=120):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit("ANTHROPIC_API_KEY not set")
    import requests
    r = requests.post(
        API,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": model, "max_tokens": max_tokens, "system": SIGMA0_SYS,
              "messages": [{"role": "user", "content": instruction}]},
        timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def teacher_solve_local(instruction, model, endpoint=LOCAL_ENDPOINT, max_tokens=1200, timeout=180):
    """Solve via a local Ollama-compatible /api/chat server (greedy, non-streaming)."""
    import requests
    r = requests.post(
        endpoint.rstrip("/") + "/api/chat",
        json={"model": model, "stream": False,
              "options": {"temperature": 0, "num_predict": max_tokens},
              "messages": [{"role": "system", "content": SIGMA0_SYS},
                           {"role": "user", "content": instruction}]},
        timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return ((data.get("message") or {}).get("content")) or data.get("response") or ""


def teacher_solve(instruction, model, backend="auto", endpoint=LOCAL_ENDPOINT,
                  max_tokens=1200, timeout=180):
    use_local = backend == "local" or (backend == "auto" and is_local_teacher(model))
    if use_local:
        return teacher_solve_local(instruction, model, endpoint, max_tokens, timeout)
    return teacher_solve_cloud(instruction, model, max_tokens, min(timeout, 120))


def extract_code(text):
    m = CODE_RE.search(text or "")
    code = (m.group(1) if m else (text or "")).strip()
    # The Σ₀ prompt asks for a trailing `self-check:` line; some teachers (Qwen) emit it
    # INSIDE the code fence, where it is a syntax error. Drop the self-check line and any
    # trailing prose after it so only executable code reaches the verifier.
    lines = code.splitlines()
    for i, ln in enumerate(lines):
        if ln.lstrip().lower().startswith("self-check:"):
            lines = lines[:i]
            break
    return "\n".join(lines).strip()


def verify(code, asserts, timeout=12):
    """Run code + asserts in a subprocess; green (exit 0) = verified."""
    src = code + "\n\n" + asserts + "\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(src)
        path = f.name
    try:
        p = subprocess.run([sys.executable, path], capture_output=True, timeout=timeout, text=True)
        return p.returncode == 0, (p.stderr or "")[-300:]
    except subprocess.TimeoutExpired:
        return False, "timeout"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def load_tasks(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            instr = (d.get("instruction") or "").strip()
            raw_asserts = d.get("asserts") or d.get("test") or ""
            # asserts may be a list (ouro-corpus-raw shape) or a pre-joined string.
            asserts = ("\n".join(raw_asserts) if isinstance(raw_asserts, list)
                       else str(raw_asserts)).strip()
            entry = d.get("fn") or d.get("entry_point") or ""
            if instr and asserts:
                rows.append({"instruction": instr, "asserts": asserts, "entry": entry})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, help="jsonl of {instruction, asserts, fn?}")
    ap.add_argument("--out", default=os.path.join("data", "distill", "sigma0-traces.jsonl"))
    ap.add_argument("--teacher", default="claude-opus-4-8")
    ap.add_argument("--teacher-backend", choices=("auto", "cloud", "local"), default="auto",
                    help="force the teacher backend; 'auto' picks local for ollama-style ids")
    ap.add_argument("--teacher-endpoint", default=LOCAL_ENDPOINT,
                    help="Ollama-compatible base URL for the local teacher")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--timeout", type=int, default=12)
    a = ap.parse_args()

    use_local = a.teacher_backend == "local" or (a.teacher_backend == "auto"
                                                 and is_local_teacher(a.teacher))
    teacher_label = f"{'local' if use_local else 'anthropic'}/{a.teacher}"
    print(f"teacher: {teacher_label}"
          f"{' @ ' + a.teacher_endpoint if use_local else ''}", flush=True)

    tasks = load_tasks(a.tasks)[: a.limit]
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    kept = dropped = 0
    with open(a.out, "a", encoding="utf-8") as out:
        for i, t in enumerate(tasks):
            instruction = t["instruction"]
            if t["entry"]:
                instruction += f"\n\nName the entry function exactly `{t['entry']}`."
            try:
                resp = teacher_solve(instruction, a.teacher, backend=a.teacher_backend,
                                     endpoint=a.teacher_endpoint)
            except Exception as e:
                print(f"[{i}] teacher error: {str(e)[:120]}", flush=True)
                dropped += 1
                continue
            code = extract_code(resp)
            ok, why = verify(code, t["asserts"], a.timeout)
            if not ok:
                dropped += 1
                print(f"[{i}] ✗ unverified ({why[:60]}) — dropped", flush=True)
                continue
            row = {
                "instruction": t["instruction"], "input": "",
                "output": resp.strip(),
                "meta": {"source": "sigma0-distill", "teacher": teacher_label,
                         "verified": True, "verify": "asserts-green",
                         "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            }
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            kept += 1
            print(f"[{i}] ✓ verified — kept ({kept})", flush=True)
    print(json.dumps({"kept": kept, "dropped": dropped, "out": a.out,
                      "verified_rate": round(kept / max(1, kept + dropped), 3)}))


if __name__ == "__main__":
    main()
