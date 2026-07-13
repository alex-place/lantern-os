r"""
distill_from_teacher.py — build a VERIFIED coding SFT corpus by distilling the strong local
teacher (Qwen2.5-Coder-14B via Ollama) on MBPP tasks, execution-graded against MBPP's own tests.

WHY: the served student (Ouro-1.4B coding adapter) tops out ~35% HumanEval; more data of the
SAME quality overfits (peaks <3 epochs). The lever is HIGHER-quality targets. This generates
teacher solutions on MBPP (disjoint from HumanEval), keeps ONLY solutions whose code passes the
task's real assertions (the Σ₀ green-subprocess gate), and writes {instruction,input,output}
rows ready to concatenate before scripts/train-qlora-ouro.py. Nothing unverified enters the set.

Ollama teacher endpoint: POST 127.0.0.1:11434/api/generate.

Run: .venv-train/Scripts/python.exe scripts/distill_from_teacher.py --limit 600 --out data/distill/mbpp-teacher-verified.jsonl
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import http.client
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
ROOT = Path(__file__).resolve().parents[1]
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def ollama_gen(prompt, model, timeout=120):
    c = http.client.HTTPConnection("127.0.0.1", 11434, timeout=timeout)
    body = json.dumps({"model": model, "prompt": prompt, "stream": False,
                       "options": {"temperature": 0.2, "num_predict": 512}})
    c.request("POST", "/api/generate", body, {"Content-Type": "application/json"})
    return json.loads(c.getresponse().read()).get("response", "").strip()


def extract_code(text):
    """Prefer a fenced python block; else the whole text. Return compilable code or None."""
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    for b in blocks:
        try:
            compile(b, "<c>", "exec"); return b.strip()
        except SyntaxError:
            continue
    try:
        compile(text, "<c>", "exec"); return text.strip()
    except SyntaxError:
        return None


def verify(code, test_list, timeout=10):
    """Green-subprocess gate: code + its MBPP asserts must run clean."""
    if not code:
        return False
    program = code + "\n\n" + "\n".join(test_list) + "\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(program); path = f.name
    try:
        r = subprocess.run([sys.executable, path], capture_output=True, timeout=timeout, text=True)
        return r.returncode == 0
    except Exception:
        return False
    finally:
        try: os.unlink(path)
        except OSError: pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen2.5-coder:14b-instruct-q5_k_m")
    ap.add_argument("--limit", type=int, default=600)
    ap.add_argument("--out", default="data/distill/mbpp-teacher-verified.jsonl")
    a = ap.parse_args()

    from datasets import load_dataset, concatenate_datasets
    # MBPP: use the full (train+validation+test+prompt) — disjoint from HumanEval.
    parts = []
    for split in ("train", "validation", "test", "prompt"):
        try:
            parts.append(load_dataset("mbpp", split=split))
        except Exception:
            pass
    ds = concatenate_datasets(parts) if parts else load_dataset("mbpp", split="test")
    tasks = [ds[i] for i in range(min(a.limit, len(ds)))]
    print(f"[distill] {len(tasks)} MBPP tasks; teacher={a.model}", flush=True)

    out_path = ROOT / a.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # resume: skip task_ids already written
    done = set()
    if out_path.exists():
        for l in open(out_path, encoding="utf-8"):
            try: done.add(json.loads(l).get("meta", {}).get("task_id"))
            except Exception: pass

    kept, tried, t0 = 0, 0, time.time()
    with open(out_path, "a", encoding="utf-8") as w:
        for t in tasks:
            tid = t.get("task_id")
            if tid in done:
                continue
            tried += 1
            prompt = (f"Write a single self-contained Python function that solves this task. "
                      f"Return ONLY the function in a ```python code block, no explanation.\n\n"
                      f"Task: {t['text']}\n\nIt must satisfy:\n" + "\n".join(t["test_list"][:3]))
            try:
                reply = ollama_gen(prompt, a.model)
            except Exception as e:
                print(f"  gen-fail {tid}: {e}", flush=True); continue
            code = extract_code(reply)
            if verify(code, t["test_list"]):
                w.write(json.dumps({
                    "instruction": t["text"].strip(),
                    "input": "",
                    "output": code,
                    "meta": {"task_id": tid, "source": "mbpp-distill-qwen14b", "verified": True},
                }, ensure_ascii=False) + "\n")
                w.flush()
                kept += 1
            if tried % 20 == 0:
                rate = kept / tried if tried else 0
                print(f"  [{tried}] kept {kept} ({rate:.0%} pass) {time.time()-t0:.0f}s", flush=True)

    print(f"[distill] DONE: kept {kept}/{tried} verified rows -> {out_path} "
          f"({time.time()-t0:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
