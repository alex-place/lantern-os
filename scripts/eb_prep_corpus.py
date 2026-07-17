#!/usr/bin/env python3
"""
eb_prep_corpus.py — Step-0 corpus + partition prep for the E-B gated-training run
(#2691; docs/SIGMA0-EB-L4-RUNBOOK.md §3). Produces the data files the run needs and
the three dispatch scripts currently point at but which don't exist:

  data/eval/distill.jsonl         SFT records {instruction, output} — OpenCodeInstruct,
                                  filtered to solutions that pass ALL their unit tests
  data/eval/distill-replay.jsonl  distill + a generic-capability anchor (Tulu-3 slice)
  data/eval/rlvr-train.jsonl      {prompt, tests} exec-graded — Eurus-2-RL coding split
  data/eval/eb-partition.json     seeded DISJOINT eval blocks (retention/sealed/pool/
                                  fresh/world/HIDDEN) over MBPP+HumanEval+LiveCodeBench
  data/eval/eb-manifest.json      counts, id ranges, seed, licenses, zero-overlap proof

Best-practice choices (all verified 2026-07-17), and why:
  * SFT  = nvidia/OpenCodeInstruct  — CC BY 4.0; Qwen-generated (clean provenance, NOT
           GPT-distilled -> no OpenAI-ToS entanglement); n-gram decontaminated upstream.
  * RLVR = PRIME-RL/Eurus-2-RL-Data — MIT; competition problems WITH executable tests.
  * held-out = livecodebench/code_generation_lite — contamination-free, date-annotated;
           the HIDDEN block is drawn from problems released AFTER the base-model cutoff,
           which is exactly the "re-drawn fresh verified truth" the freshness law
           (#2692 / SIGMA0-GROUNDING-LEDGER §1) proved is the only valid SELECTOR.
  * retention = MBPP + HumanEval (historic suite the Σ_θ gate's cond-2 reads).
  * DECONTAMINATION: every train prompt sharing a 13-gram with ANY eval prompt is dropped.

SAFETY: hitting the network requires --allow-download (this sandbox has no egress and
urllib would hang — run this on the fleet host / a training worker). Without it, or with
--dry-run, the script exercises ALL pure logic (extract mapping, decontam, partition,
zero-overlap assertion, writers) on synthetic rows so the pipeline is validated offline.

Usage (on a machine with internet):
  python scripts/eb_prep_corpus.py --allow-download                 # full prep
  python scripts/eb_prep_corpus.py --allow-download --distill-n 3000 --rlvr-n 1500
  python scripts/eb_prep_corpus.py --dry-run                        # validate logic, no net
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT_DEFAULT = REPO / "data" / "eval"
SEED_DEFAULT = 20260717
NGRAM = 13

# dataset id -> license (verified on the HF card, 2026-07-17)
SOURCES = {
    "distill": ("nvidia/OpenCodeInstruct", "CC BY 4.0"),
    "rlvr":    ("PRIME-RL/Eurus-2-RL-Data", "MIT"),
    "anchor":  ("allenai/tulu-3-sft-mixture", "ODC-BY"),
    "heldout": ("livecodebench/code_generation_lite", "competition-usage (internal eval only)"),
    "mbpp":    ("google-research-datasets/mbpp", "CC-BY-4.0 / Apache-2.0"),
    "humaneval": ("openai_humaneval", "MIT"),
}

# Disjoint eval blocks (sizes per runbook §3). Total = 1220 exec-verified tasks needed.
BLOCKS = {"retention": 100, "sealed": 60, "pool": 240, "fresh": 480, "world": 240, "hidden": 100}


# ─────────────────────────── normalization + n-gram decontamination ───────────────────────────
def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def _ngrams(s: str, n: int = NGRAM) -> set:
    toks = _norm(s).split()
    return {" ".join(toks[i:i + n]) for i in range(max(0, len(toks) - n + 1))} or {_norm(s)}


def build_eval_ngrams(prompts, n=NGRAM) -> set:
    acc = set()
    for p in prompts:
        acc |= _ngrams(p, n)
    return acc


def is_contaminated(prompt: str, eval_ngrams: set, n=NGRAM) -> bool:
    return bool(_ngrams(prompt, n) & eval_ngrams)


# ─────────────────────────── stable seeded hashing (never Python hash()) ───────────────────────────
def _h(*parts) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16], 16)


# ─────────────────────────── defensive schema mapping ───────────────────────────
def _pick(cols, candidates, name):
    for c in candidates:
        if c in cols:
            return c
    raise SystemExit(f"[eb_prep] cannot map {name!r}: none of {candidates} in columns {sorted(cols)}. "
                     f"The dataset schema changed — update the candidate list.")


def extract_distill(row, cols):
    """OpenCodeInstruct -> {instruction, output}. Keep only fully-verified solutions."""
    fi = _pick(cols, ["input", "instruction", "question", "prompt"], "distill.instruction")
    fo = _pick(cols, ["output", "solution", "response", "completion"], "distill.output")
    score = row.get("average_test_score")
    if score is not None and float(score) < 1.0:
        return None  # best practice: SFT only on solutions passing all their unit tests
    instr, out = (row.get(fi) or "").strip(), (row.get(fo) or "").strip()
    if not instr or not out:
        return None
    return {"instruction": instr, "output": out}


def extract_rlvr(row, cols):
    """Eurus-2-RL-Data coding split -> {instruction, tests}. Filter to code, keep tests."""
    ability = row.get("ability") or row.get("data_source") or ""
    if "code" not in str(ability).lower() and row.get("ability") is not None:
        return None
    fp = _pick(cols, ["prompt", "question", "input", "instruction"], "rlvr.prompt")
    prompt = row.get(fp)
    if isinstance(prompt, list):  # chat-format prompt -> take the user content
        prompt = " ".join(m.get("content", "") for m in prompt if isinstance(m, dict))
    prompt = (prompt or "").strip()
    rm = row.get("reward_model") or {}
    tests = rm.get("ground_truth") if isinstance(rm, dict) else None
    tests = tests or row.get("test_cases") or row.get("tests")
    if not prompt or not tests:
        return None
    return {"instruction": prompt, "tests": tests}


def extract_anchor(row, cols):
    """Tulu-3 SFT -> {instruction, output} from the first user/assistant turn."""
    msgs = row.get("messages")
    if not isinstance(msgs, list):
        return None
    user = next((m.get("content") for m in msgs if m.get("role") == "user"), "")
    asst = next((m.get("content") for m in msgs if m.get("role") == "assistant"), "")
    if not user or not asst:
        return None
    return {"instruction": user.strip(), "output": asst.strip()}


def extract_eval_task(row, cols, source):
    """MBPP / HumanEval / LiveCodeBench -> a uniform exec task with a stable id + date."""
    fp = _pick(cols, ["question_content", "text", "prompt", "problem", "question"], f"{source}.prompt")
    fid = next((c for c in ["task_id", "question_id", "id", "problem_id"] if c in cols), None)
    prompt = (str(row.get(fp) or "")).strip()
    rid = str(row.get(fid)) if fid else _h(source, prompt)
    date = row.get("contest_date") or row.get("release_date") or ""
    if not prompt:
        return None
    return {"id": f"{source}:{rid}", "prompt": prompt, "source": source, "date": str(date)}


# ─────────────────────────── seeded disjoint partition ───────────────────────────
def partition(eval_items, seed, cutoff_date=""):
    """Assign every eval task to exactly one block. The HIDDEN block is filled FIRST from
    contamination-free post-cutoff LiveCodeBench tasks (the fresh selector); everything else
    is assigned by a stable per-(id,seed) hash so the split is reproducible and disjoint."""
    items = sorted({it["id"]: it for it in eval_items}.values(), key=lambda x: x["id"])
    total_needed = sum(BLOCKS.values())
    if len(items) < total_needed:
        raise SystemExit(f"[eb_prep] need {total_needed} eval tasks, have {len(items)}. "
                         f"Increase LiveCodeBench pull or lower block sizes.")

    fresh_hidden = [it for it in items
                    if it["source"] == "livecodebench" and cutoff_date and it["date"] > cutoff_date]
    fresh_hidden.sort(key=lambda x: _h(x["id"], seed))
    hidden = fresh_hidden[:BLOCKS["hidden"]]
    if len(hidden) < BLOCKS["hidden"]:
        # not enough post-cutoff LCB — top up from the general pool by hash (flagged in manifest)
        rest = [it for it in items if it not in hidden]
        rest.sort(key=lambda x: _h("hidden-topup", x["id"], seed))
        hidden += rest[:BLOCKS["hidden"] - len(hidden)]
    hidden_ids = {it["id"] for it in hidden}

    remaining = [it for it in items if it["id"] not in hidden_ids]
    remaining.sort(key=lambda x: _h(x["id"], seed))
    blocks = {"hidden": [it["id"] for it in hidden]}
    i = 0
    for name, size in BLOCKS.items():
        if name == "hidden":
            continue
        blocks[name] = [it["id"] for it in remaining[i:i + size]]
        i += size

    # disjointness proof
    seen, overlap = set(), []
    for name, ids in blocks.items():
        for x in ids:
            if x in seen:
                overlap.append(x)
            seen.add(x)
    if overlap:
        raise SystemExit(f"[eb_prep] BUG: blocks overlap on {overlap[:5]} — partition is not disjoint.")
    return blocks, {"hidden_from_post_cutoff_lcb": len(fresh_hidden[:BLOCKS['hidden']]),
                    "hidden_topped_up": BLOCKS["hidden"] - min(len(fresh_hidden), BLOCKS["hidden"])}


# ─────────────────────────── writers ───────────────────────────
def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return len(rows)


# ─────────────────────────── the real (downloading) pipeline ───────────────────────────
def run_download(args):
    from datasets import load_dataset  # local import — only when actually downloading

    out = Path(args.out)
    base_cutoff = args.base_cutoff

    def take(ds_id, n, extract, source=None, streaming=True, **load_kw):
        print(f"[eb_prep] loading {ds_id} …")
        ds = load_dataset(ds_id, split="train", streaming=streaming, **load_kw)
        cols = set(getattr(ds, "column_names", None) or next(iter(ds)).keys())
        rows, seen = [], 0
        for row in ds:
            seen += 1
            rec = extract(row, cols) if source is None else extract(row, cols, source)
            if rec:
                rows.append(rec)
            if len(rows) >= n:
                break
            if seen > n * 50:  # guard: don't scan forever if the filter is too tight
                break
        print(f"[eb_prep]   kept {len(rows)}/{seen} from {ds_id}")
        return rows

    # 1. eval pool first (needed for decontamination + the partition)
    eval_items = []
    eval_items += [extract_eval_task(r, set(r.keys()), "mbpp")
                   for r in load_dataset(SOURCES["mbpp"][0], "sanitized", split="test")]
    eval_items += [extract_eval_task(r, set(r.keys()), "humaneval")
                   for r in load_dataset(SOURCES["humaneval"][0], split="test")]
    try:
        lcb = load_dataset(SOURCES["heldout"][0], split="test", version_tag=args.lcb_version)
        eval_items += [extract_eval_task(r, set(r.keys()), "livecodebench") for r in lcb]
    except Exception as e:  # noqa: BLE001
        print(f"[eb_prep] WARN: LiveCodeBench load failed ({e}); hidden block will lack post-cutoff freshness.")
    eval_items = [e for e in eval_items if e]
    eval_ngrams = build_eval_ngrams([e["prompt"] for e in eval_items])
    print(f"[eb_prep] eval pool: {len(eval_items)} tasks; {len(eval_ngrams)} decontam n-grams")

    # 2. train sets, decontaminated against the eval pool
    distill = [r for r in take(SOURCES["distill"][0], args.distill_n, extract_distill)
               if not is_contaminated(r["instruction"], eval_ngrams)]
    anchor = [r for r in take(SOURCES["anchor"][0], args.anchor_n, extract_anchor)
              if not is_contaminated(r["instruction"], eval_ngrams)]
    rlvr = [r for r in take(SOURCES["rlvr"][0], args.rlvr_n, extract_rlvr)
            if not is_contaminated(r["instruction"], eval_ngrams)]

    # 3. write
    n_distill = write_jsonl(out / "distill.jsonl", distill)
    n_replay = write_jsonl(out / "distill-replay.jsonl", distill + anchor)
    n_rlvr = write_jsonl(out / "rlvr-train.jsonl", rlvr)
    blocks, hidden_meta = partition(eval_items, args.seed, base_cutoff)
    (out / "eb-partition.json").write_text(json.dumps(
        {"seed": args.seed, "base_cutoff": base_cutoff, "blocks": blocks,
         "block_sizes": {k: len(v) for k, v in blocks.items()}, **hidden_meta},
        indent=2), encoding="utf-8")

    manifest = {"seed": args.seed, "created_for": "#2691 E-B run", "licenses": SOURCES,
                "counts": {"distill": n_distill, "distill_replay": n_replay, "rlvr": n_rlvr,
                           "eval_pool": len(eval_items)},
                "block_sizes": {k: len(v) for k, v in blocks.items()},
                "decontamination": f"{NGRAM}-gram overlap vs eval pool removed",
                "hidden_block": hidden_meta}
    (out / "eb-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # 4. zero train/eval id-overlap assertion (SFT/RLVR carry no eval ids by construction here,
    #    but re-assert on the prompt level: no train prompt equals an eval prompt verbatim)
    eval_prompt_set = {_norm(e["prompt"]) for e in eval_items}
    leaked = [r for r in (distill + rlvr) if _norm(r["instruction"]) in eval_prompt_set]
    if leaked:
        raise SystemExit(f"[eb_prep] LEAK: {len(leaked)} train prompts equal an eval prompt verbatim.")
    print(json.dumps(manifest, indent=2))
    print(f"\n[eb_prep] OK -> {out} (distill {n_distill}, replay {n_replay}, rlvr {n_rlvr}, "
          f"eval {len(eval_items)}; hidden {len(blocks['hidden'])})")


# ─────────────────────────── dry-run: validate all logic on synthetic rows ───────────────────────────
def run_dry(args):
    # synthetic rows matching each real schema
    dcols = {"input", "output", "average_test_score", "unit_tests"}
    distill = [extract_distill({"input": f"solve problem {i}", "output": f"def f{i}(): return {i}",
                                "average_test_score": 1.0 if i % 3 else 0.5}, dcols)
               for i in range(50)]
    distill = [d for d in distill if d]
    rcols = {"prompt", "ability", "reward_model"}
    rlvr = [extract_rlvr({"prompt": f"competitive problem {i}", "ability": "code",
                          "reward_model": {"ground_truth": f"assert f{i}()=={i}"}}, rcols) for i in range(20)]
    rlvr = [r for r in rlvr if r]
    acols = {"messages"}
    anchor = [extract_anchor({"messages": [{"role": "user", "content": f"q{i}"},
                                           {"role": "assistant", "content": f"a{i}"}]}, acols) for i in range(10)]
    # synthetic eval pool big enough for the partition
    total = sum(BLOCKS.values())
    eval_items = []
    for i in range(total + 50):
        src = "livecodebench" if i % 2 == 0 else ("mbpp" if i % 3 else "humaneval")
        date = "2099-01-01" if src == "livecodebench" else "2020-01-01"
        eval_items.append({"id": f"{src}:{i}", "prompt": f"eval task number {i} content", "source": src, "date": date})

    # decontam: plant one contaminated train prompt, confirm it's caught
    ng = build_eval_ngrams([e["prompt"] for e in eval_items])
    planted = "eval task number 5 content"
    assert is_contaminated(planted, ng), "decontam FAILED to catch a verbatim eval prompt"
    assert not is_contaminated("totally unrelated distinct training instruction text here", ng)

    blocks, hidden_meta = partition(eval_items, args.seed, cutoff_date="2050-01-01")
    assert all(len(blocks[k]) == BLOCKS[k] for k in BLOCKS), {k: len(v) for k, v in blocks.items()}
    # hidden must be all post-cutoff LiveCodeBench
    hidden_srcs = {i.split(":")[0] for i in blocks["hidden"]}
    assert hidden_srcs == {"livecodebench"}, f"hidden block not all post-cutoff LCB: {hidden_srcs}"
    # determinism
    blocks2, _ = partition(eval_items, args.seed, cutoff_date="2050-01-01")
    assert blocks == blocks2, "partition is not deterministic under a fixed seed"

    print("[eb_prep --dry-run] all logic checks passed:")
    print(f"  extractors: distill {len(distill)} (score<1 dropped), rlvr {len(rlvr)}, anchor {len(anchor)}")
    print(f"  decontam: {NGRAM}-gram catches verbatim eval prompts, passes unrelated text")
    print(f"  partition: {sum(BLOCKS.values())} tasks -> disjoint blocks {{"
          + ", ".join(f'{k}:{len(v)}' for k, v in blocks.items()) + "}")
    print("  hidden block: 100% post-cutoff LiveCodeBench; deterministic under seed")
    print("\n  -> real prep needs: python scripts/eb_prep_corpus.py --allow-download  (on an egress host)")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="E-B Step-0 corpus + partition prep (#2691)")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--seed", type=int, default=SEED_DEFAULT)
    ap.add_argument("--distill-n", type=int, default=3000)
    ap.add_argument("--anchor-n", type=int, default=1000)
    ap.add_argument("--rlvr-n", type=int, default=1500)
    ap.add_argument("--lcb-version", default="release_v5", help="LiveCodeBench version_tag")
    ap.add_argument("--base-cutoff", default="2025-01-01",
                    help="Ouro base-model cutoff date; hidden block = LCB problems after this")
    ap.add_argument("--allow-download", action="store_true",
                    help="REQUIRED to hit the network (this sandbox has no egress; omit -> dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="validate all logic offline, no network")
    args = ap.parse_args()

    if args.dry_run or not args.allow_download:
        if not args.dry_run:
            print("[eb_prep] no --allow-download -> running --dry-run (offline logic validation).\n")
        run_dry(args)
        return
    run_download(args)


if __name__ == "__main__":
    main()
