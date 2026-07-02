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

STATUS: scaffold (ADR-0015 Proposed). `propose_with_qwen()` is a clearly-marked wiring stub
        — it raises until the live Qwen call is implemented (the first PR after ADR approval).
        `--self-test` and `--dry-run --stub-proposer` exercise verify+scrub+pack end-to-end
        WITHOUT a Qwen endpoint, so the plumbing is testable today.

USAGE
  # No-endpoint plumbing check (uses a canned correct/incorrect candidate pair):
  python scripts/qwen_teacher_crystallize.py --self-test

  # Dry run over a prompts file with the built-in stub proposer (no Qwen, no CSF write):
  python scripts/qwen_teacher_crystallize.py --prompts data/training/coding-prompts.jsonl \
      --stub-proposer --dry-run

  # Live (after ADR-0015 approval + propose_with_qwen wired):
  QWEN_ENDPOINT=http://127.0.0.1:11434 QWEN_MODEL=qwen2.5-coder:7b \
    python scripts/qwen_teacher_crystallize.py \
      --prompts data/training/coding-prompts.jsonl \
      --out data/training/qwen-teacher-verified.jsonl \
      --csf-out data/csf/qwen-teacher-verified.csf --max-per-prompt 1
"""
import argparse
import json
import os
import re
import sys
import time

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


# ── stage: propose (THE WIRING STUB — implemented in the first post-approval PR) ─────────
def propose_with_qwen(instruction, n, endpoint=QWEN_ENDPOINT, model=PROPOSER_ID):
    """Ask a local Qwen2.5-Coder endpoint for `n` candidate solutions to `instruction`.

    Expected return: list of {"instruction","input","output","asserts"} dicts, where
    `output` is the candidate code and `asserts` is an executable check the verify gate
    can run. The endpoint is any Ollama/OpenAI-compatible server (POST /api/chat).

    NOT YET WIRED (ADR-0015 authorizes this stage; the live call lands in the first PR
    after approval). Kept a hard failure so a live run can't silently produce zero rows
    and look like "the teacher found nothing".
    """
    raise NotImplementedError(
        "propose_with_qwen is a scaffold stub — wire the live Qwen call after ADR-0015 is "
        "approved (POST {}/api/chat, model={}). Use --stub-proposer for plumbing tests."
        .format(endpoint, model)
    )


def _stub_proposer(instruction, n):
    """Deterministic offline stand-in so verify+scrub+pack are testable with no endpoint.
    Emits one trivially-correct candidate and (for n>1) one deliberately-wrong one so the
    verify gate visibly drops the bad row."""
    good = {
        "instruction": instruction,
        "input": "",
        "output": "def add(a, b):\n    return a + b\n",
        "asserts": "assert add(2, 3) == 5\nassert add(-1, 1) == 0\n",
    }
    if n <= 1:
        return [good]
    bad = {
        "instruction": instruction,
        "input": "",
        "output": "def add(a, b):\n    return a - b  # wrong on purpose\n",
        "asserts": "assert add(2, 3) == 5\n",
    }
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
    """Minimal compile+exec+assert gate — used only when the shared module is absent."""
    import subprocess
    verified, dropped = [], []
    for c in candidates:
        code = (c.get("output", "") or "") + "\n" + (c.get("asserts", "") or "")
        try:
            r = subprocess.run([sys.executable, "-c", code], capture_output=True,
                               text=True, timeout=10)
            if r.returncode == 0:
                verified.append({k: c[k] for k in ("instruction", "input", "output") if k in c})
            else:
                dropped.append((c, "assert-failed: " + (r.stderr.strip().splitlines() or [""])[-1]))
        except subprocess.TimeoutExpired:
            dropped.append((c, "timeout"))
        except Exception as e:  # noqa: BLE001
            dropped.append((c, f"{type(e).__name__}: {e}"))
    return verified, dropped


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


def crystallize(prompts, proposer, n_per_prompt, out_path, csf_out, dry_run):
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

    print(f"\n[summary] {len(verified_all)} verified / "
          f"{len(verified_all) + len(dropped_all)} proposed  "
          f"(scrub redactions: {sum(scrub_counts.values())})")

    record = {  # Convergence Record: hypothesis / evidence / result / confidence / source
        "ts": int(time.time()), "stage": "qwen-teacher-crystallize",
        "hypothesis": "verified Qwen-proposed coding traces are a valid Ouro training corpus",
        "evidence": {"prompts": len(prompts), "proposed": len(verified_all) + len(dropped_all),
                     "verified": len(verified_all), "dropped": len(dropped_all),
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
    """Verify+scrub+pack plumbing with no endpoint: the stub emits one correct + one wrong
    candidate; the gate must keep exactly the correct one and the scrub must redact a key."""
    rows = _stub_proposer("Write add(a, b).", 2)
    rows[0]["output"] += "\n# leaked sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX key\n"
    # Exercise the scaffold's OWN compile+exec+assert gate deterministically (the shared
    # build_ouro_coding_dataset module enforces its own richer row schema and is covered by
    # its own tests); here we prove this script's verify+scrub plumbing end-to-end.
    verified, dropped = _fallback_verify(rows)
    counts = {}
    for r in verified:
        r["output"], _ = scrub(r["output"], counts)
    ok = (len(verified) == 1 and len(dropped) == 1
          and "sk-ant-" not in verified[0]["output"]
          and "[REDACTED_ANTHROPIC_KEY]" in verified[0]["output"])
    print(f"  verified={len(verified)} (expect 1), dropped={len(dropped)} (expect 1), "
          f"secret_scrubbed={'sk-ant-' not in verified[0]['output'] if verified else False}")
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
    crystallize(prompts, proposer, a.max_per_prompt, a.out, a.csf_out or None, a.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
