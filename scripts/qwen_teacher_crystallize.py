#!/usr/bin/env python3
"""
Qwen-teacher → Ouro-student crystallization — the PROPOSER + VERIFY front half [ADR-0015].

    prompts -> QWEN PROPOSE -> execution-verify -> scrub -> decontaminate -> CSF pack

Qwen is a PROPOSER, never an oracle. It generates candidate coding solutions; a
compile+exec+assert green-subprocess gate — the SAME gate that governs
`continual_ouro_pipeline.py` — is the *teacher of record*. A Qwen output that does not run
green is DISCARDED, not trained on. There is no soft-label / logit / KL distillation here:
only Qwen's *verified behavior* becomes an Ouro training row.

  ┌─ propose ───────────┐  a local Qwen2.5-Coder endpoint (Ollama/OpenAI-compatible)
  │ {instruction} ->     │  emits candidate {code, asserts}
  │ candidate solution   │
  ├─ verify ────────────┤  build_ouro_coding_dataset.load_extra_candidates
  │ compile+exec+assert  │  THE Σ₀ GROUND-TRUTH GATE — only a green subprocess counts
  ├─ scrub ─────────────┤  redact secrets + home paths + emails (mirrors pr_crystallize.py)
  ├─ decontaminate ─────┤  scripts/decontaminate_training.py (13-gram vs HumanEval+MBPP)
  └─ pack ──────────────┘  csf.pack -> data/csf/qwen-teacher-verified.csf (per-row SHA256)

The verified JSONL this writes is a drop-in `--source-jsonl` for
`continual_ouro_pipeline.py --train --eval --promote` (Stages C+D, ADR-0015). This script is
the no-GPU front half; it never trains, evals, or promotes.

──────────────────────────────────────────────────────────────────────────────────────
ARCHITECTURAL BOUNDARY (docs/CONVERGANCE-SIGMA0-BRIEFING.md + ADR-0010 + ADR-0015):
  Distillation is a verify-gated LAST RESORT. This front half is OFFLINE and OPT-IN: a
  script you run, NOT wired into the live Observe->Reason->Act->Verify->Converge path.
  Every row carries provenance (meta.proposer, meta.verification) so a bad teacher is
  auditable and revocable. The base is never retrained by the live loop.
──────────────────────────────────────────────────────────────────────────────────────

STATUS: front half RUNNABLE (ADR-0015 still Proposed). `propose_with_qwen()` is wired to a live
        local Qwen2.5-Coder endpoint and the 13-gram decontamination stage is now part of the
        flow. It remains a script you run — OFFLINE and OPT-IN, never in the live loop, and it
        still never trains/evals/promotes (that is `continual_ouro_pipeline.py`, on the GPU box,
        operator-gated). `--self-test` and `--stub-proposer` exercise propose→verify→scrub→
        decontaminate end-to-end WITHOUT a Qwen endpoint or GPU. Covered by
        tests/test_qwen_teacher_crystallize.py (11 tests).

USAGE
  # No-endpoint end-to-end plumbing check (real verify gate + scrub + decontam):
  python scripts/qwen_teacher_crystallize.py --self-test

  # Dry run over a prompts file with the built-in stub proposer (no Qwen, no CSF write):
  python scripts/qwen_teacher_crystallize.py --prompts data/training/coding-prompts.jsonl \
      --stub-proposer --dry-run --no-decontaminate

  # Live (needs a local Qwen; --no-decontaminate only if the HF datasets are unavailable):
  QWEN_ENDPOINT=http://127.0.0.1:11434 QWEN_MODEL=qwen2.5-coder:7b \
    python scripts/qwen_teacher_crystallize.py \
      --prompts data/training/coding-prompts.jsonl \
      --out data/training/qwen-teacher-verified.jsonl \
      --csf-out data/csf/qwen-teacher-verified.csf --max-per-prompt 3

  # Then (Stages C+D — GPU box, operator-gated; NOT this script):
  python scripts/continual_ouro_pipeline.py \
      --source-jsonl data/training/qwen-teacher-verified.jsonl --train --eval --promote
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)

DEFAULT_OUT = os.path.join(ROOT, "data", "training", "qwen-teacher-verified.jsonl")
DEFAULT_CSF = os.path.join(ROOT, "data", "csf", "qwen-teacher-verified.csf")
CONVERGENCE_LOG = os.path.join(ROOT, "data", "convergence", "qwen-teacher-crystallize.jsonl")

PROPOSER_ID = os.environ.get("QWEN_MODEL", "qwen2.5-coder:7b")
QWEN_ENDPOINT = os.environ.get("QWEN_ENDPOINT", "http://127.0.0.1:11434")

# Secret / PII scrub — mirrors scripts/pr_crystallize.py:75-85. A verified row must never
# carry a live key, a home path, or an email into the training corpus / CSF archive.
SCRUB_PATTERNS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "[REDACTED_ANTHROPIC_KEY]"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "[REDACTED_OPENAI_KEY]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED_GH_TOKEN]"),
    (re.compile(r"xai-[A-Za-z0-9]{20,}"), "[REDACTED_XAI_KEY]"),
    (re.compile(r"AIza[A-Za-z0-9_\-]{20,}"), "[REDACTED_GOOGLE_KEY]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED_AWS_KEY]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), "[REDACTED_SLACK_TOKEN]"),
    (re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
    (re.compile(r"[Cc]:[\\/]Users[\\/][^\\/\s\"']+"), r"C:/Users/[USER]"),
    (re.compile(r"/home/[^/\s\"']+"), "/home/[USER]"),
]


def scrub(text, counters):
    """Redact secrets/paths/emails in a string; bump `counters` per pattern hit."""
    if not text:
        return text, 0
    n = 0
    for pat, repl in SCRUB_PATTERNS:
        text, k = pat.subn(repl, text)
        if k:
            counters[repl] = counters.get(repl, 0) + k
            n += k
    return text, n


# ── stage: propose (live Qwen2.5-Coder over an Ollama/OpenAI-compatible endpoint) ─────────
# The candidate schema is what the verify gate (build_ouro_coding_dataset.load_extra_candidates)
# consumes: {fn, instruction, code, asserts:[list]}. asserts are run SEPARATELY from code, so the
# function body must be pure stdlib (no imports/I/O) — the gate rejects forbidden tokens.
PROPOSE_SYSTEM = (
    "You are a Python coding assistant. Given a task, respond with ONE self-contained PURE "
    "Python function plus 2-4 assert statements that test it. Hard constraints: no imports, no "
    "I/O, no randomness, no file/network/time access — a deterministic pure function only. "
    "Respond with ONLY a JSON object and nothing else: "
    '{"fn": "<function name>", "code": "<def ...>", "asserts": ["assert ...", "assert ..."]}'
)

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.S)
_CODE_FENCE_RE = re.compile(r"```(?:python|py)?\s*(.*?)```", re.S)
_DEF_RE = re.compile(r"def\s+([A-Za-z_]\w*)\s*\(")


def _qwen_chat(instruction, endpoint, model, timeout, temperature):
    """One POST to an Ollama/OpenAI-compatible /api/chat; returns the assistant text.
    Mirrors the established client in scripts/eval_coding_ouro.py (urllib, stream=False)."""
    payload = json.dumps({
        "model": model, "stream": False,
        "messages": [
            {"role": "system", "content": PROPOSE_SYSTEM},
            {"role": "user", "content": instruction},
        ],
        "options": {"num_predict": 640, "temperature": temperature},
    }).encode()
    req = urllib.request.Request(endpoint.rstrip("/") + "/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    return ((body.get("message") or {}).get("content") or body.get("response") or "").strip()


def _parse_candidate(text, instruction):
    """Parse a Qwen reply into a {fn, instruction, code, asserts:list} candidate, or None.

    Accepts a JSON object, a fenced ```python block, or bare code; derives the fn name from the
    first top-level `def`, and lifts top-level `assert` lines out of the code (the gate runs them
    separately). Returns None when there is no function or no asserts — the verify gate is the
    real filter, so a loose parse is fine; a bad candidate simply gets dropped downstream.
    """
    code, asserts = None, []
    m = _JSON_OBJ_RE.search(text)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict) and obj.get("code"):
                code = str(obj["code"])
                a = obj.get("asserts") or []
                asserts = a if isinstance(a, list) else [s for s in str(a).splitlines() if s.strip()]
        except Exception:  # noqa: BLE001 — fall through to fenced/bare parsing
            pass
    if not code:
        fences = _CODE_FENCE_RE.findall(text)
        code = fences[0] if fences else text
    # Top-level assert lines are tests, not part of the function body.
    if not asserts:
        asserts = [ln.strip() for ln in code.splitlines() if ln.startswith("assert")]
    code = "\n".join(ln for ln in code.splitlines() if not ln.startswith("assert")).strip()
    fn_m = _DEF_RE.search(code)
    if not code or not fn_m or not asserts:
        return None
    asserts = [a if a.strip().startswith("assert") else "assert " + a.strip() for a in asserts if a.strip()]
    return {"fn": fn_m.group(1), "instruction": instruction, "code": code, "asserts": asserts}


def propose_with_qwen(instruction, n, endpoint=QWEN_ENDPOINT, model=PROPOSER_ID, timeout=None):
    """Ask a local Qwen2.5-Coder for up to `n` verified-shape candidates for `instruction`.

    Returns a list of {fn, instruction, code, asserts}. Endpoint/parse errors yield FEWER
    candidates rather than crashing mid-corpus — Qwen is a proposer, and the green-subprocess
    gate downstream is the teacher of record (ADR-0015). Offline & opt-in: this is a script you
    run, never wired into the live loop.
    """
    timeout = timeout or int(os.environ.get("QWEN_TIMEOUT", "120"))
    out = []
    for i in range(max(1, n)):
        try:
            text = _qwen_chat(instruction, endpoint, model, timeout, temperature=0.2 + 0.2 * i)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:  # noqa: BLE001
            print(f"    [propose] endpoint error ({type(e).__name__}: {e}); skipped draw {i + 1}")
            continue
        cand = _parse_candidate(text, instruction)
        if cand:
            out.append(cand)
        else:
            print(f"    [propose] draw {i + 1} unparseable ({len(text)} chars); skipped")
    return out


def _stub_proposer(instruction, n):
    """Deterministic offline stand-in (verify gate schema) so verify+scrub+decontam+pack are
    testable with no endpoint. Emits one correct candidate and (for n>1) one deliberately-wrong
    one — a distinct fn name so the gate drops it on assert-failure, not on dedup."""
    good = {"fn": "add", "instruction": instruction, "code": "def add(a, b):\n    return a + b",
            "asserts": ["assert add(2, 3) == 5", "assert add(-1, 1) == 0"]}
    if n <= 1:
        return [good]
    bad = {"fn": "add_wrong", "instruction": instruction, "code": "def add_wrong(a, b):\n    return a - b",
           "asserts": ["assert add_wrong(2, 3) == 5"]}
    return [good, bad]


# ── stage: verify (reuse the Σ₀ ground-truth gate) ───────────────────────────────────────
def verify_candidates(candidates):
    """Run each candidate through the SAME green-subprocess gate the continual pipeline uses.

    Returns (verified_rows, dropped) where dropped is [(row, reason), ...]. Falls back to a
    local minimal exec gate only if build_ouro_coding_dataset is unavailable (keeps the
    scaffold self-testable), but the production path is the shared module.
    """
    try:
        from build_ouro_coding_dataset import load_extra_candidates
    except Exception:  # noqa: BLE001 — scaffold fallback so --self-test runs anywhere
        return _fallback_verify(candidates)

    # load_extra_candidates reads a JSONL path; write candidates to a temp file it can eat.
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as tf:
        for c in candidates:
            tf.write(json.dumps(c, ensure_ascii=False) + "\n")
        tmp = tf.name
    try:
        verified, dropped = load_extra_candidates(tmp, seed_fns=set())
    finally:
        os.unlink(tmp)
    return verified, dropped


def _fallback_verify(candidates):
    """Minimal compile+exec+assert gate on the {fn, code, asserts:[list]} candidate schema —
    used only when the shared build_ouro_coding_dataset module is absent (keeps --self-test
    runnable anywhere). Verified rows use the same {instruction, input, output} schema."""
    import subprocess
    verified, dropped = [], []
    for c in candidates:
        code = (c.get("code") or "")
        asserts = c.get("asserts") or []
        program = code.rstrip() + "\n\n" + "\n".join(asserts) + "\n"
        try:
            r = subprocess.run([sys.executable, "-c", program], capture_output=True,
                               text=True, timeout=10)
            if r.returncode == 0:
                verified.append({"instruction": c.get("instruction", ""), "input": "", "output": code})
            else:
                dropped.append((c.get("fn", "?"), "assert-failed: " + (r.stderr.strip().splitlines() or [""])[-1]))
        except subprocess.TimeoutExpired:
            dropped.append((c.get("fn", "?"), "timeout"))
        except Exception as e:  # noqa: BLE001
            dropped.append((c.get("fn", "?"), f"{type(e).__name__}: {e}"))
    return verified, dropped


# ── stage: decontaminate (13-gram overlap vs HumanEval + MBPP) ───────────────────────────
def decontaminate_rows(rows, bad_grams=None, min_overlap=1):
    """Drop verified rows that share >= `min_overlap` normalized 13-grams with HumanEval/MBPP,
    so a memorized benchmark answer can never enter the training corpus (benchmark-never-the-
    target, ADR-0010). Reuses scripts/decontaminate_training.py's index + n-gram functions.

    Returns (kept, dropped[(row, reason)]). If the decontaminator or its HF datasets are
    unavailable, returns (rows, []) with a LOUD warning — the offline front half still runs, but
    a skipped decontam pass is never silently mistaken for a clean one.
    """
    try:
        from decontaminate_training import (
            normalize, ngrams, row_text, build_contamination_index, NGRAM,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[decontam] decontaminate_training unavailable ({e}); SKIPPED — rows NOT decontaminated")
        return rows, []
    if bad_grams is None:
        try:
            bad_grams = build_contamination_index()
        except Exception as e:  # noqa: BLE001
            print(f"[decontam] contamination index unavailable ({e}); SKIPPED — rows NOT decontaminated")
            return rows, []
    kept, dropped = [], []
    for rec in rows:
        hits = len(ngrams(normalize(row_text(rec)), NGRAM) & bad_grams)
        (dropped.append((rec, f"benchmark-overlap:{hits}")) if hits >= min_overlap else kept.append(rec))
    print(f"[decontam] kept {len(kept)} / dropped {len(dropped)} (>= {min_overlap} benchmark 13-gram hit)")
    return kept, dropped


# ── stage: pack (CSF, per-row SHA256 — the one canonical archive) ────────────────────────
def pack_csf(jsonl_path, csf_out):
    """Pack the verified JSONL into an integrity-checked CSF archive (ADR-0003/0004)."""
    try:
        import csf
    except Exception as e:  # noqa: BLE001
        print(f"[pack] csf module unavailable ({e}); skipping CSF pack (JSONL still written)")
        return None
    os.makedirs(os.path.dirname(csf_out), exist_ok=True)
    csf.pack(
        {os.path.basename(jsonl_path): open(jsonl_path, "rb").read()},
        csf_out,
        metadata={"purpose": "qwen-teacher verified crystallization corpus (ADR-0015)",
                  "loop_stage": "Converge", "proposer": PROPOSER_ID,
                  "verification": "green-subprocess"},
    )
    print(f"[pack] CSF archive -> {csf_out}")
    return csf_out


def _log_convergence(record):
    os.makedirs(os.path.dirname(CONVERGENCE_LOG), exist_ok=True)
    with open(CONVERGENCE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_prompts(path):
    """Read a JSONL of {instruction[, input]} prompts (decontaminated upstream)."""
    prompts = []
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            row = json.loads(ln)
            instr = row.get("instruction") or row.get("prompt")
            if instr:
                prompts.append({"instruction": instr, "input": row.get("input", "")})
    return prompts


def crystallize(prompts, proposer, n_per_prompt, out_path, csf_out, dry_run,
                decontaminate=True, min_overlap=1, bad_grams=None):
    verified_all, dropped_all, scrub_counts = [], [], {}
    for i, p in enumerate(prompts):
        cands = proposer(p["instruction"], n_per_prompt)
        verified, dropped = verify_candidates(cands)
        dropped_all += dropped
        for row in verified:
            row["output"], _ = scrub(row.get("output", ""), scrub_counts)
            row["instruction"], _ = scrub(row.get("instruction", ""), scrub_counts)
            row["meta"] = {
                "source": "qwen-teacher-crystallize",
                "proposer": PROPOSER_ID,
                "verified": True,
                "verification": "green-subprocess",
                "adr": "ADR-0015",
            }
            verified_all.append(row)
        print(f"  [{i + 1}/{len(prompts)}] proposed {len(cands)} -> "
              f"verified {len(verified)}, dropped {len(dropped)}")

    # Decontaminate BEFORE anything is written: a verified row that memorized a HumanEval/MBPP
    # answer must never enter the corpus (benchmark-never-the-target, ADR-0010). Loud-skips if
    # the datasets are unavailable so an offline run is never mistaken for decontaminated.
    contam_dropped = []
    if decontaminate:
        verified_all, contam_dropped = decontaminate_rows(verified_all, bad_grams=bad_grams,
                                                          min_overlap=min_overlap)
    else:
        print("[decontam] disabled (--no-decontaminate) — corpus NOT checked against benchmarks")

    print(f"\n[summary] {len(verified_all)} kept / "
          f"{len(verified_all) + len(dropped_all) + len(contam_dropped)} proposed  "
          f"(verify-dropped {len(dropped_all)}, benchmark-dropped {len(contam_dropped)}, "
          f"scrub redactions {sum(scrub_counts.values())})")

    record = {  # Convergence Record: hypothesis / evidence / result / confidence / source
        "ts": int(time.time()), "stage": "qwen-teacher-crystallize",
        "hypothesis": "verified Qwen-proposed coding traces are a valid Ouro training corpus",
        "evidence": {"prompts": len(prompts),
                     "proposed": len(verified_all) + len(dropped_all) + len(contam_dropped),
                     "verified": len(verified_all) + len(contam_dropped),
                     "verify_dropped": len(dropped_all),
                     "benchmark_dropped": len(contam_dropped),
                     "decontaminated": bool(decontaminate),
                     "kept": len(verified_all),
                     "redactions": sum(scrub_counts.values())},
        "result": "verified-corpus" if verified_all else "empty",
        "confidence": {"observable": 1.0, "source": "green-subprocess-exec"},
        "proposer": PROPOSER_ID, "dry_run": dry_run,
    }
    if dry_run:
        print("[dry-run] no JSONL / CSF written; no convergence record logged.")
        return record

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for row in verified_all:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[write] {len(verified_all)} verified rows -> {out_path}")
    if csf_out and verified_all:
        pack_csf(out_path, csf_out)
    _log_convergence(record)
    print(f"[log] convergence record -> {CONVERGENCE_LOG}")
    print("\nNext: feed to the flywheel (Stages C+D, ADR-0015):")
    print(f"  python scripts/continual_ouro_pipeline.py --source-jsonl {out_path} "
          f"--train --eval --promote   # GPU box, operator-gated")
    return record


def _self_test():
    """End-to-end front-half plumbing with no endpoint / no GPU:
      1. propose (stub) -> the REAL verify gate keeps the correct candidate, drops the wrong one;
      2. scrub redacts a leaked key from a verified row;
      3. decontaminate drops a row against an injected benchmark n-gram (no HF datasets needed)."""
    cands = _stub_proposer("Write add(a, b).", 2)
    cands[0]["code"] += "\n# leaked sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX key"
    verified, dropped = verify_candidates(cands)  # production gate when available, else fallback
    counts = {}
    for r in verified:
        r["output"], _ = scrub(r["output"], counts)
    scrub_ok = bool(verified) and "sk-ant-" not in verified[0]["output"] \
        and "[REDACTED_ANTHROPIC_KEY]" in verified[0]["output"]

    # Decontamination: build a bad-gram set FROM the verified row so it MUST be flagged. This
    # proves the filter end-to-end without loading HumanEval/MBPP.
    decon_ok = True
    try:
        from decontaminate_training import normalize, ngrams, row_text, NGRAM
        inj = ngrams(normalize(row_text(verified[0])), NGRAM) if verified else set()
        if inj:
            kept, dcon = decontaminate_rows(list(verified), bad_grams=inj, min_overlap=1)
            decon_ok = (len(kept) == 0 and len(dcon) == len(verified))
    except Exception as e:  # noqa: BLE001 — decontaminator optional
        print(f"  [decontam] module unavailable ({e}); decontam check skipped")

    ok = len(verified) == 1 and len(dropped) == 1 and scrub_ok and decon_ok
    print(f"  verified={len(verified)} (expect 1), dropped={len(dropped)} (expect 1), "
          f"secret_scrubbed={scrub_ok}, decontam_drops_injected={decon_ok}")
    print("\nself-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="Qwen-teacher verified crystallization (ADR-0015 front half)")
    ap.add_argument("--self-test", action="store_true", help="verify+scrub+pack plumbing, no endpoint (no GPU)")
    ap.add_argument("--prompts", help="JSONL of {instruction[, input]} coding prompts (decontaminated upstream)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="verified-rows JSONL output")
    ap.add_argument("--csf-out", default=DEFAULT_CSF, help="CSF archive output (set '' to skip)")
    ap.add_argument("--max-per-prompt", type=int, default=1, help="candidates Qwen proposes per prompt")
    ap.add_argument("--stub-proposer", action="store_true", help="use the offline stub instead of live Qwen")
    ap.add_argument("--dry-run", action="store_true", help="run stages but write nothing")
    ap.add_argument("--no-decontaminate", dest="decontaminate", action="store_false",
                    help="skip the HumanEval/MBPP 13-gram decontamination stage (NOT recommended)")
    ap.add_argument("--min-overlap", type=int, default=1,
                    help="drop a verified row sharing >= this many benchmark 13-grams (default 1)")
    a = ap.parse_args()

    if a.self_test:
        return _self_test()
    if not a.prompts:
        ap.error("--prompts is required (or use --self-test)")
    if not os.path.exists(a.prompts):
        ap.error(f"prompts file not found: {a.prompts}")

    proposer = _stub_proposer if a.stub_proposer else propose_with_qwen
    prompts = load_prompts(a.prompts)
    print(f"[load] {len(prompts)} prompt(s) from {a.prompts}; "
          f"proposer={'stub' if a.stub_proposer else PROPOSER_ID}")
    crystallize(prompts, proposer, a.max_per_prompt, a.out, a.csf_out or None, a.dry_run,
                decontaminate=a.decontaminate, min_overlap=a.min_overlap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
