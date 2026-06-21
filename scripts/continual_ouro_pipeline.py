#!/usr/bin/env python3
"""
Σ₀ Ouro Coder — continual-training loop (the closed flywheel) [#781].

    harvest  ->  execution-verify  ->  train  ->  eval  ->  EVAL-GATED promote

Each verified-correct coding success the system produces becomes training data; a new
QLoRA adapter is trained, evaluated on HumanEval, and PROMOTED to the live `final/`
adapter ONLY if it beats the incumbent's pass@1 by a margin. A rejected adapter changes
nothing. Every decision is logged as an append-only Convergence Record.

  ┌─ harvest ───────────┐  scripts/harvest_coding_corpus.py
  │ gather {fn,instr,    │  gathers candidates from the system's own runs
  │ code,asserts}        │
  ├─ verify ────────────┤  build_ouro_coding_dataset.load_extra_candidates
  │ compile+exec+assert  │  THE Σ₀ GROUND-TRUTH GATE — only a green subprocess counts
  │ in a subprocess      │
  ├─ train ─────────────┤  scripts/train-qlora-ouro.py   (gated by --train; ~hours)
  │ QLoRA r16/a32        │
  ├─ eval ──────────────┤  scripts/eval_humaneval_ouro.py  (candidate AND incumbent)
  │ HumanEval pass@1     │
  └─ promote ───────────┘  swap final/ iff candidate.pass@1 >= incumbent.pass@1 + margin
                           append data/eval/ouro-promotion-log.jsonl (Convergence Record)

──────────────────────────────────────────────────────────────────────────────────────
ARCHITECTURAL BOUNDARY (read docs/CONVERGANCE-SIGMA0-BRIEFING.md):
  The North Star says "PERSISTENT LEARNING, NOT WEIGHT MODIFICATION … improve via
  retrieval and reasoning, NOT retraining." QLoRA *is* weight modification, so this loop
  is deliberately kept OFFLINE and OPT-IN: it is a script you (or a cron) run, NOT wired
  into the live Observe->Reason->Act->Verify->Converge request path. The live loop never
  retrains. Promotion only swaps a drop-in adapter the model-broker already treats as one
  interchangeable local model. Keep it that way.
──────────────────────────────────────────────────────────────────────────────────────

USAGE
  # Safe default — harvest + execution-verify only; reports what WOULD train (no GPU):
  .venv-train/Scripts/python scripts/continual_ouro_pipeline.py

  # Full loop on the GPU box (trains a new adapter, evals both, eval-gated promote):
  .venv-train/Scripts/python scripts/continual_ouro_pipeline.py --train --eval --promote

  # Eval-gate a pre-trained candidate dir against the incumbent (no harvest/train):
  .venv-train/Scripts/python scripts/continual_ouro_pipeline.py \
      --candidate D:/lantern-train/ouro-sigma0-adapters/coding-v3 --eval --promote

  # Verify the promote-gate logic with no GPU/model:
  .venv-train/Scripts/python scripts/continual_ouro_pipeline.py --self-test
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)

PY = sys.executable
ADAPTER_ROOT = os.environ.get("OURO_ADAPTER_ROOT", "D:/lantern-train/ouro-sigma0-adapters")
FINAL_DIR = os.path.join(ADAPTER_ROOT, "final")
BASE_TRAIN = os.path.join(ROOT, "models", "lantern-sigma0-coder", "training-data.jsonl")
HARVEST_OUT = os.path.join(ROOT, "data", "ouro-harvest-candidates.jsonl")
TRAIN_OUT = os.path.join(ROOT, "models", "lantern-sigma0-coder", "training-data.harvested.jsonl")
PROMO_LOG = os.path.join(ROOT, "data", "eval", "ouro-promotion-log.jsonl")


def _run(cmd, **kw):
    print(f"\n$ {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run(cmd, **kw)


# ── stage: harvest ──────────────────────────────────────────────────────────────────
def stage_harvest(extra_jsonl=None):
    cmd = [PY, os.path.join(SCRIPTS, "harvest_coding_corpus.py"), "--out", HARVEST_OUT]
    for j in (extra_jsonl or []):
        cmd += ["--source-jsonl", j]
    r = _run(cmd)
    if r.returncode != 0:
        raise SystemExit("harvest failed")
    return HARVEST_OUT


# ── stage: execution-verify -> training set (THE Σ₀ GATE; non-destructive) ───────────
def stage_verify_build(candidates_path):
    """Reuse build_ouro_coding_dataset's sandboxed execution gate to verify harvested
    candidates, then write a NEW augmented training file = base + verified rows. We do
    NOT clobber the curated coding-seed/coding-extra files."""
    from build_ouro_coding_dataset import load_extra_candidates
    verified, dropped = load_extra_candidates(candidates_path, seed_fns=set())
    base_lines, base_outputs = [], set()
    if os.path.exists(BASE_TRAIN):
        with open(BASE_TRAIN, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                base_lines.append(ln)
                try:
                    base_outputs.add(json.loads(ln).get("output", "").strip())
                except json.JSONDecodeError:
                    pass
    # Don't re-append rows whose code already lives in the base set (a prior harvest was
    # merged in): identical code would otherwise be 2x-weighted in QLoRA training.
    fresh = [r for r in verified if r.get("output", "").strip() not in base_outputs]
    n_dupe_of_base = len(verified) - len(fresh)
    os.makedirs(os.path.dirname(TRAIN_OUT), exist_ok=True)
    with open(TRAIN_OUT, "w", encoding="utf-8") as f:
        for ln in base_lines:
            f.write(ln + "\n")
        for r in fresh:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\n[verify] execution-verified {len(verified)} / {len(verified) + len(dropped)} "
          f"harvested candidates (green-subprocess gate)")
    if dropped:
        from collections import Counter
        reasons = Counter(why.split(":")[0].split("(")[0] for _, why in dropped)
        for reason, c in reasons.most_common(8):
            print(f"   dropped x{c}: {reason}")
    if n_dupe_of_base:
        print(f"   skipped {n_dupe_of_base} verified row(s) already present in the base set (no double-weighting)")
    print(f"[verify] wrote {len(base_lines)} base + {len(fresh)} new verified = "
          f"{len(base_lines) + len(fresh)} rows -> {TRAIN_OUT}")
    return TRAIN_OUT, len(fresh), len(dropped)


# ── stage: train ─────────────────────────────────────────────────────────────────────
def stage_train(train_path, out_dir, epochs):
    r = _run([PY, os.path.join(SCRIPTS, "train-qlora-ouro.py"),
              "--data", train_path, "--out", out_dir, "--epochs", str(epochs)])
    if r.returncode != 0:
        raise SystemExit("train failed")
    # train-qlora-ouro.py saves the PEFT adapter to <out_dir>/final (the bare <out_dir>
    # only holds Trainer checkpoint-* dirs). Return the dir that actually holds
    # adapter_config.json so eval/promote load/copy the real adapter, not its parent.
    adapter_dir = os.path.join(out_dir, "final")
    if not os.path.exists(os.path.join(adapter_dir, "adapter_config.json")):
        raise SystemExit(f"train produced no adapter at {adapter_dir}")
    return adapter_dir


# ── stage: eval ──────────────────────────────────────────────────────────────────────
def stage_eval(adapter_dir, label, full=False, limit=20):
    """Run HumanEval on one adapter; return pass@1 (parsed from the summary JSON line)."""
    cmd = [PY, os.path.join(SCRIPTS, "eval_humaneval_ouro.py"),
           "--adapter", adapter_dir, "--label", label, "--ts", str(int(time.time()))]
    cmd += (["--full"] if full else ["--limit", str(limit)])
    # Bound the wall-clock so a wedged GPU/HF-download can't hang an unattended/cron run
    # forever. Budget ~90s/problem (>2x observed) + 15min for model load; override via env.
    n = 164 if full else limit
    budget = int(os.environ.get("OURO_EVAL_TIMEOUT_S", str(900 + 90 * n)))
    try:
        r = _run(cmd, capture_output=True, text=True, timeout=budget)
    except subprocess.TimeoutExpired:
        raise SystemExit(f"eval timed out after {budget}s for {adapter_dir}")
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        raise SystemExit(f"eval failed for {adapter_dir}")
    # last JSON line of stdout is the summary
    summary = None
    for line in reversed(r.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and '"pass@1"' in line:
            summary = json.loads(line)
            break
    if summary is None:
        raise SystemExit("could not parse pass@1 from eval output")
    return float(summary["pass@1"]), summary


# ── stage: promote (PURE decision + side-effecting swap) ─────────────────────────────
def decide_promotion(candidate_p, incumbent_p, margin):
    """Pure, unit-testable gate. Require a STRICT improvement of at least `margin`:
    promote iff candidate_p - incumbent_p >= max(margin, 1e-9). Ties and regressions
    reject. incumbent_p is None for the bootstrap case (no incumbent) -> always promote."""
    if incumbent_p is None:
        return "promote", "no incumbent adapter (bootstrap) — promoting first candidate"
    delta = round(candidate_p - incumbent_p, 6)
    threshold = max(margin, 1e-9)
    if delta >= threshold:
        return "promote", f"+{delta:.4f} pass@1 >= margin {threshold:.4f}"
    return "reject", f"delta {delta:+.4f} pass@1 < margin {threshold:.4f}"


def _log_promo(record):
    os.makedirs(os.path.dirname(PROMO_LOG), exist_ok=True)
    with open(PROMO_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _adapter_ok(d):
    return os.path.isdir(d) and os.path.exists(os.path.join(d, "adapter_config.json"))


def stage_promote(candidate_dir, candidate_p, incumbent_p, margin, dry_run=False):
    """Eval-gated, crash-safe promotion. The swap is staged so a failed/interrupted copy
    can NEVER leave the live final/ missing: we copy the candidate to a staging dir first,
    only then move the incumbent aside and os.replace the staging dir into place, with a
    try/except that restores the incumbent on any failure. The Convergence Record is
    ALWAYS written (success, reject, or failed swap) so every attempt is traceable."""
    decision, reason = decide_promotion(candidate_p, incumbent_p, margin)
    ts = int(time.time())
    record = {  # Convergence Record: hypothesis / evidence / result / confidence
        "ts": ts, "stage": "ouro-promote",
        "hypothesis": "the newly trained Σ₀ adapter improves HumanEval pass@1 over the incumbent",
        "evidence": {"candidate_dir": candidate_dir, "candidate_pass@1": candidate_p,
                     "incumbent_dir": FINAL_DIR, "incumbent_pass@1": incumbent_p, "margin": margin},
        "result": decision, "reason": reason,
        "confidence": {"observable": 1.0, "source": "humaneval-sandboxed-exec"},
        "dry_run": dry_run,
    }

    if decision != "promote" or dry_run:
        _log_promo(record)
        print(f"\n[promote] {decision.upper()}: {reason}" + ("  (dry-run, no swap)" if dry_run else ""))
        return record

    # Promote. Validate the candidate BEFORE touching final/.
    if not _adapter_ok(candidate_dir):
        record["result"] = "promote-failed"
        record["reason"] = f"candidate has no adapter_config.json: {candidate_dir}"
        _log_promo(record)
        raise SystemExit(record["reason"])

    staging = os.path.join(ADAPTER_ROOT, f"final.incoming-{ts}")
    bak = os.path.join(ADAPTER_ROOT, f"final.bak-{ts}") if os.path.exists(FINAL_DIR) else None
    record["evidence"]["incumbent_backup"] = bak
    try:
        # 1) Copy candidate into staging (the slow, failure-prone step) — final/ untouched.
        if os.path.exists(staging):
            shutil.rmtree(staging)
        shutil.copytree(candidate_dir, staging)
        # 2) Move the incumbent aside (PermissionError here if a server holds it open).
        if bak:
            shutil.move(FINAL_DIR, bak)
        # 3) Atomically swap staging -> final/ (same volume rename).
        os.replace(staging, FINAL_DIR)
        record["promoted_to"] = FINAL_DIR
    except Exception as e:  # noqa: BLE001 — restore + always log, then re-raise
        # Restore the incumbent if we already moved it and the live dir is now missing.
        if bak and os.path.exists(bak) and not os.path.exists(FINAL_DIR):
            shutil.move(bak, FINAL_DIR)
            record["evidence"]["restored_incumbent"] = True
        if os.path.exists(staging):
            shutil.rmtree(staging, ignore_errors=True)
        record["result"] = "promote-failed"
        record["reason"] = f"{type(e).__name__}: {e}"
        _log_promo(record)
        raise
    _log_promo(record)
    print(f"\n[promote] PROMOTE: {reason}  -> {FINAL_DIR}"
          + (f"  (incumbent backed up: {bak})" if bak else "  (bootstrap, no prior adapter)"))
    return record


def _self_test():
    cases = [
        # (candidate, incumbent, margin, expected)
        (0.80, 0.75, 0.0, "promote"),
        (0.75, 0.75, 0.0, "reject"),    # tie does not promote
        (0.74, 0.75, 0.0, "reject"),    # regression
        (0.78, 0.75, 0.05, "reject"),   # +0.03 < margin 0.05
        (0.81, 0.75, 0.05, "promote"),  # +0.06 >= margin 0.05
        (0.10, None, 0.0, "promote"),   # bootstrap: no incumbent -> promote first
    ]
    ok = True
    for cand, inc, m, exp in cases:
        got, why = decide_promotion(cand, inc, m)
        flag = "OK " if got == exp else "FAIL"
        if got != exp:
            ok = False
        print(f"  {flag} cand={cand} inc={inc} margin={m} -> {got} (expected {exp})  [{why}]")
    print("\nself-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="Σ₀ Ouro continual-training loop")
    ap.add_argument("--self-test", action="store_true", help="verify the promote-gate logic (no GPU)")
    ap.add_argument("--source-jsonl", action="append", default=[], help="extra live-run JSONL source(s) to harvest")
    ap.add_argument("--candidate", default=None, help="pre-trained adapter dir to eval-gate (skips harvest/train)")
    ap.add_argument("--train", action="store_true", help="train a new adapter from the verified set")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--out", default=None, help="output adapter dir for --train (default: <root>/coding-<ts>)")
    ap.add_argument("--eval", action="store_true", help="run HumanEval on candidate + incumbent")
    ap.add_argument("--full", action="store_true", help="eval on all 164 (default: --limit 20)")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--promote", action="store_true", help="swap final/ if the gate passes")
    ap.add_argument("--margin", type=float, default=0.0, help="min pass@1 improvement to promote")
    ap.add_argument("--dry-run", action="store_true", help="never swap final/ (report only)")
    a = ap.parse_args()

    if a.self_test:
        return _self_test()

    candidate_dir = a.candidate

    # harvest + verify (skipped if eval-gating a pre-built candidate without --train)
    if not a.candidate or a.train:
        cands = stage_harvest(a.source_jsonl)
        train_path, n_verified, n_dropped = stage_verify_build(cands)
        if n_verified == 0:
            print("\n[stop] no candidates survived execution-verification; nothing to train.")
            if not a.train:
                return 0
        if a.train:
            candidate_dir = a.out or os.path.join(ADAPTER_ROOT, f"coding-{int(time.time())}")
            stage_train(train_path, candidate_dir, a.epochs)
        else:
            print("\n[default] harvest + verify only (no --train). Verified set ready at:")
            print(f"         {train_path}")
            print("         Re-run with --train --eval --promote on the GPU box to close the loop.")
            return 0

    if not candidate_dir:
        print("[stop] no candidate adapter to evaluate (use --train or --candidate).")
        return 1

    if a.eval:
        cand_p, _ = stage_eval(candidate_dir, "ouro-candidate", full=a.full, limit=a.limit)
        if _adapter_ok(FINAL_DIR):
            inc_p, _ = stage_eval(FINAL_DIR, "ouro-incumbent", full=a.full, limit=a.limit)
            print(f"\n[eval] candidate pass@1={cand_p:.3f}  incumbent pass@1={inc_p:.3f}")
        else:
            inc_p = None
            print(f"\n[eval] candidate pass@1={cand_p:.3f}  incumbent: none (bootstrap)")
        if a.promote:
            stage_promote(candidate_dir, cand_p, inc_p, a.margin, dry_run=a.dry_run)
    elif a.promote:
        print("[warn] --promote requires --eval (need pass@1 to gate on). Skipping promote.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
