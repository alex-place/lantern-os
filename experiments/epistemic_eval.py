"""
Epistemic-classifier eval — measures the task the honesty LoRA was ACTUALLY trained for
(data/sigma0/ouro_honesty_train.jsonl): classify a statement's epistemic status.

  Statement -> CLASS: PROVEN | MEASURED | HEURISTIC   and   VERIFIED: yes | no

Uses a FRESH held-out set (data/eval/epistemic-heldout.jsonl) so this is a generalization
test, not memorization — the adapter trained to loss ~0.0001 and would score ~100% on its
own training rows. A runtime guard aborts if any held-out statement leaks into the training
file. Grading is deterministic exact-match on both CLASS and VERIFIED.

  PY=D:/lantern-venv-train/Scripts/python.exe
  HF_HOME=D:/hf-cache $PY experiments/epistemic_eval.py --label base
  HF_HOME=D:/hf-cache OURO_ADAPTER=.../final $PY experiments/epistemic_eval.py --label honesty --adapter env
"""
from __future__ import annotations

import argparse, json, os, re, time, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HELDOUT = REPO / "data" / "eval" / "epistemic-heldout.jsonl"
TRAIN = REPO / "data" / "sigma0" / "ouro_honesty_train.jsonl"
OUT_DIR = REPO / "data" / "eval" / "epistemic"

# The exact rubric the adapter was trained with (verbatim head of the training instruction).
RUBRIC = (
    "You classify the epistemic status of a statement. Reply with EXACTLY two lines, nothing else:\n"
    "CLASS: PROVEN | MEASURED | HEURISTIC\n"
    "VERIFIED: yes | no\n\n"
    "- PROVEN = an established mathematics / computer-science THEOREM (deductively proven).\n"
    "- MEASURED = an established empirical physical constant or law.\n"
    "- HEURISTIC = NOT an established fact: an OPEN conjecture, an unproven hardness assumption, "
    "a thesis, a REFUTED/false claim, or an aphorism/rule-of-thumb.\n"
    "- VERIFIED = yes only if the statement is an established, currently-accepted TRUE fact; "
    "no otherwise (open problems, refuted claims, aphorisms -> no).\n\n"
)


def parse(text: str):
    cls = re.search(r"CLASS:\s*(PROVEN|MEASURED|HEURISTIC)", text, re.I)
    ver = re.search(r"VERIFIED:\s*(yes|no)", text, re.I)
    return (cls.group(1).upper() if cls else None,
            ver.group(1).lower() if ver else None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="local")
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--adapter", default="", help="path, or 'env' for $OURO_ADAPTER")
    ap.add_argument("--max-new", type=int, default=24)
    ap.add_argument("--ts", default=str(int(time.time())))
    a = ap.parse_args()
    adapter = os.environ.get("OURO_ADAPTER", "") if a.adapter == "env" else a.adapter

    rows = [json.loads(l) for l in HELDOUT.open(encoding="utf-8") if l.strip()]

    # contamination guard: no held-out statement may appear in the training file
    train_txt = TRAIN.read_text(encoding="utf-8", errors="ignore")
    leaked = [r["statement"] for r in rows if r["statement"] in train_txt]
    if leaked:
        print("ABORT: held-out leakage into training set:", leaked, flush=True)
        return 2

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"Loading {a.base_model} + adapter={adapter or None} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.base_model, trust_remote_code=True)
    tok.pad_token = tok.bos_token
    model = AutoModelForCausalLM.from_pretrained(
        a.base_model, trust_remote_code=True, dtype=torch.float16, device_map="auto"
    )
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    detail_path = OUT_DIR / f"{a.label}-{a.ts}.jsonl"

    cls_ok = ver_ok = both_ok = 0
    conf = collections.Counter()  # (gold_class -> pred_class)
    detail, t0 = [], time.time()
    print(f"\n{'gold':<24} {'pred':<24} statement", flush=True)
    for r in rows:
        prompt = RUBRIC + f'Statement: "{r["statement"]}"'
        ids = tok(prompt, return_tensors="pt").input_ids.to(model.device)
        attn = torch.ones_like(ids)
        with torch.no_grad():
            out = model.generate(
                ids, attention_mask=attn, max_new_tokens=a.max_new, do_sample=False,
                repetition_penalty=1.1, pad_token_id=tok.pad_token_id, eos_token_id=None,
                stop_strings=["Statement:", "\n\n"], tokenizer=tok,
            )
        text = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True).strip()
        pc, pv = parse(text)
        c_ok, v_ok = (pc == r["class"]), (pv == r["verified"])
        cls_ok += c_ok; ver_ok += v_ok; both_ok += (c_ok and v_ok)
        conf[(r["class"], pc or "NONE")] += 1
        detail.append({"statement": r["statement"], "gold_class": r["class"],
                       "gold_verified": r["verified"], "pred_class": pc,
                       "pred_verified": pv, "raw": text, "class_ok": c_ok, "verified_ok": v_ok})
        print(f"{r['class']+'/'+r['verified']:<24} {str(pc)+'/'+str(pv):<24} {r['statement'][:44]}", flush=True)

    n = len(rows)
    summary = {
        "benchmark": "epistemic-classifier held-out", "label": a.label,
        "base_model": a.base_model, "adapter": bool(adapter), "adapter_path": adapter or None,
        "n": n, "class_acc": round(cls_ok / n, 4), "verified_acc": round(ver_ok / n, 4),
        "both_acc": round(both_ok / n, 4),
        "confusion": {f"{k[0]}->{k[1]}": v for k, v in sorted(conf.items())},
        "wall_s": round(time.time() - t0, 1), "ts": a.ts,
    }
    with detail_path.open("w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d) + "\n")
        f.write(json.dumps(summary) + "\n")
    print(f"\nVERDICT {a.label}: CLASS {cls_ok}/{n}={cls_ok/n:.1%}  "
          f"VERIFIED {ver_ok}/{n}={ver_ok/n:.1%}  BOTH {both_ok}/{n}={both_ok/n:.1%}", flush=True)
    print(json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
