"""
CSF Technique 4 (#1596) go/no-go probe — hybrid GRC over the CSF-Col residual.

Premise under test (issue #1596): after CSF-Col (#1593) strips the structural
redundancy, the *residual* columns are where a grounded neural predictor (GRC,
#1595) drives bits to a floor that brotli can't reach. This is a CHEAP go/no-go
*before* committing to the ~20 min/MB cold neural coder, following the
evidence-first pattern of #1593 (CSF-Col shipped), #1594 (RKD deferred),
#1595 (GRC-alone refuted).

The honest decomposition the earlier probes did NOT do: split the CSF-Col output
into per-column streams and ask, column by column, *where the col+brotli bytes
actually go*. A neural predictor can only ever win on a column if its
teacher-forced cross-entropy (= ideal arithmetic-coder floor, DeepMind
"Language Modeling Is Compression") is below brotli's bits/byte on that column.

  - structural columns (timestamps, low-card enums, floats, empty lists):
    brotli already reaches << 1 bpb. A neural coder cannot beat that AND it
    cannot see the cross-record redundancy col already exposed -> no win.
  - high-entropy RANDOM columns (sha-256 checksums, random id suffixes, float
    embeddings): ~8 bpb for BOTH brotli and any predictor. Cryptographic hashes
    are maximum-entropy by construction -> structurally incompressible -> no win
    is even theoretically possible.
  - natural-language residual (free-text `content`, `*_reasoning`): the ONLY
    place an LM prior can plausibly beat brotli.

Stage A (no model): per-column brotli-11 accounting + classification. If the
natural-language residual is a small slice of the col+brotli total, even a
*perfect* neural coder on it saves little overall -> defer.

Stage B (gpt2-124M, CPU, teacher-forced CE, same instrument as #1595): measure
the neural bits/byte floor on the natural-language residual ONLY and compare to
brotli-11 on the same bytes. Net hybrid saving = (brotli_resid - neural_resid)
bytes, projected onto the whole-file col+brotli total.

Reproducible:  python experiments/csf_hybrid_residual_probe.py
               python experiments/csf_hybrid_residual_probe.py --model distilgpt2 --max-resid-bytes 120000
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import brotli

# make `import csf` work from the repo root without install (pytest.ini does this for tests)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

_dec = json.JSONDecoder()

MEM_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "csf_memory")
LOGS = ["raw.jsonl", "elephant-door-memories-2026-06-06.jsonl", "sample_traces.jsonl"]


# --------------------------------------------------------------------------
# Column extraction — faithful to col_transform: RAW value source substrings,
# never re-serialized, grouped by top-level field name (positional == named for
# the homogeneous append-only schema CSF-Col targets).
# --------------------------------------------------------------------------
def split_named(line: str):
    """Return [(key, raw_value_substring)] for a flat JSON object, or None."""
    if not line or line[0] != "{":
        return None
    n = len(line)
    i = 1
    out = []
    j0 = i
    while j0 < n and line[j0] in " \t":
        j0 += 1
    if j0 < n and line[j0] == "}":
        return []
    while True:
        while i < n and line[i] in " \t":
            i += 1
        if i >= n or line[i] != '"':
            return None
        try:
            key, j = _dec.raw_decode(line, i)
        except Exception:
            return None
        while j < n and line[j] in " \t":
            j += 1
        if j >= n or line[j] != ":":
            return None
        vstart = j + 1
        while vstart < n and line[vstart] in " \t":
            vstart += 1
        try:
            _val, k = _dec.raw_decode(line, vstart)
        except Exception:
            return None
        out.append((key, line[vstart:k]))
        while k < n and line[k] in " \t":
            k += 1
        if k >= n:
            return None
        c = line[k]
        if c == ",":
            i = k + 1
            continue
        if c == "}":
            return out
        return None


def columnize(path: str):
    """{field -> [raw value substrings]}, in first-seen field order."""
    with open(path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f if ln.strip()]
    cols: dict[str, list[str]] = {}
    order: list[str] = []
    for ln in lines:
        parsed = split_named(ln)
        if parsed is None:
            return None, len(lines)
        for key, val in parsed:
            if key not in cols:
                cols[key] = []
                order.append(key)
            cols[key].append(val)
    return [(k, cols[k]) for k in order], len(lines)


def brotli_len(b: bytes) -> int:
    if not b:
        return 0
    return len(brotli.compress(b, quality=11))


def bpb(nbytes_out: int, nbytes_in: int) -> float:
    return (nbytes_out * 8.0 / nbytes_in) if nbytes_in else 0.0


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------
def rich_alpha_ratio(s: str) -> float:
    """Fraction of chars that are letters OUTSIDE the hex alphabet (g-z). Real
    prose is full of these; a sha-256/uuid hex digest has *none* (a-f only), so
    this — unlike a naive a-z count — does not mistake a checksum for language."""
    if not s:
        return 0.0
    return sum(1 for c in s if "g" <= c <= "z") / len(s)


def space_ratio(s: str) -> float:
    if not s:
        return 0.0
    return s.count(" ") / len(s)


def classify(values: list[str], col_bpb: float) -> str:
    """Bucket a column by who can compress it:
      structural  -> brotli already < 1.0 bpb (below any LM floor) -> neural can't win
      random      -> hash/uuid/numeric: high bpb but no g-z words -> neural can't win
      nl-residual -> real language above the brotli floor -> the ONLY neural-addressable slice
    """
    blob = "\n".join(values)
    # brotli already beats the ~1 bpb natural-language floor: a neural prior is
    # blind to the cross-record redundancy LZ is exploiting here (the #1595 result).
    if col_bpb < 1.0:
        return "structural"
    # contested band: only real word-text (g-z letters + spaces) is neural-addressable;
    # hex digests / uuids / numbers have high bpb because they are RANDOM, not language.
    if rich_alpha_ratio(blob) >= 0.06 and space_ratio(blob) >= 0.02:
        return "nl-residual"
    return "random"


# --------------------------------------------------------------------------
# Stage A
# --------------------------------------------------------------------------
def stage_a(path: str, verbose: bool = True):
    cols, nlines = columnize(path)
    name = os.path.basename(path)
    if cols is None:
        print(f"[{name}] not column-transposable JSONL — skipped")
        return None
    raw_total = os.path.getsize(path)

    rows = []
    klass_bytes = {"structural": 0, "random": 0, "nl-residual": 0}
    klass_raw = {"structural": 0, "random": 0, "nl-residual": 0}
    nl_cols = []
    for field, values in cols:
        raw = "\n".join(values).encode("utf-8")
        cb = brotli_len(raw)
        col_bpb = bpb(cb, len(raw))
        kls = classify(values, col_bpb)
        rows.append((field, len(raw), cb, col_bpb, kls))
        klass_bytes[kls] += cb
        klass_raw[kls] += len(raw)
        if kls == "nl-residual":
            nl_cols.append((field, values))

    # what col+brotli actually spends: per-column brotli + a small skeleton.
    col_brotli_total = sum(cb for _f, _r, cb, _b, _k in rows)
    full = open(path, "rb").read()
    whole_brotli = brotli_len(full)

    if verbose:
        print(f"\n========== {name}  ({nlines} records, {raw_total:,} raw bytes) ==========")
        print(f"{'field':22s} {'rawB':>8s} {'brotliB':>8s} {'bpb':>6s}  class")
        for field, r, cb, b, k in sorted(rows, key=lambda x: -x[2]):
            print(f"{field:22s} {r:8,d} {cb:8,d} {b:6.2f}  {k}")
        print("-" * 56)
        print(f"per-column brotli total : {col_brotli_total:,} B")
        print(f"whole-file brotli-11    : {whole_brotli:,} B  (ships as the col entropy backend)")
        tot = max(1, klass_bytes['structural'] + klass_bytes['random'] + klass_bytes['nl-residual'])
        for k in ("structural", "random", "nl-residual"):
            print(f"  {k:12s}: {klass_bytes[k]:8,d} B brotli  ({100*klass_bytes[k]/tot:4.1f}% of col bytes)"
                  f"   from {klass_raw[k]:,} raw B")
        print(f"  -> natural-language residual is {100*klass_bytes['nl-residual']/tot:.1f}% of the "
              f"compressed budget; the neural pass can only ever address THIS slice.")
    return {
        "name": name, "nlines": nlines, "raw_total": raw_total,
        "col_brotli_total": col_brotli_total, "whole_brotli": whole_brotli,
        "klass_bytes": klass_bytes, "nl_cols": nl_cols, "cols": cols,
    }


# --------------------------------------------------------------------------
# Stage B — neural CE floor on the natural-language residual only
# --------------------------------------------------------------------------
def neural_bpb(text: str, model_name: str, max_bytes: int) -> tuple[float, int, int]:
    """Teacher-forced cross-entropy of `text` under `model_name`, in bits/byte.
    Returns (bits_per_byte, n_bytes_scored, n_tokens)."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    raw = text.encode("utf-8")[:max_bytes]
    text = raw.decode("utf-8", errors="ignore")
    nbytes = len(text.encode("utf-8"))

    tok = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name)
    model.eval()
    torch.set_grad_enabled(False)

    ids = tok(text, return_tensors="pt").input_ids[0]
    win = min(1024, getattr(model.config, "n_positions", 1024))
    total_nats = 0.0
    n_tok = 0
    for start in range(0, len(ids), win):
        chunk = ids[start:start + win]
        if len(chunk) < 2:
            break
        inp = chunk.unsqueeze(0)
        logits = model(inp).logits
        # predict token t from < t
        lp = torch.log_softmax(logits[0, :-1], dim=-1)
        tgt = chunk[1:]
        nll = -lp[range(len(tgt)), tgt]
        total_nats += float(nll.sum())
        n_tok += len(tgt)
    bits = total_nats / math.log(2)
    return (bits / nbytes if nbytes else 0.0), nbytes, n_tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt2", help="HF causal LM for the CE floor (gpt2, distilgpt2, ...)")
    ap.add_argument("--max-resid-bytes", type=int, default=80_000,
                    help="cap natural-language residual bytes scored by the model (CPU runtime)")
    ap.add_argument("--no-neural", action="store_true", help="Stage A only")
    args = ap.parse_args()

    print("CSF Technique 4 (#1596) — hybrid GRC over CSF-Col residual: go/no-go probe")
    print("=" * 76)

    summaries = []
    for log in LOGS:
        p = os.path.join(MEM_DIR, log)
        if os.path.exists(p):
            s = stage_a(p)
            if s:
                summaries.append(s)

    if args.no_neural:
        return

    # Stage B on the realistic log (the one that drives the byte budget). Score
    # the SINGLE most language-like column — the most LM-friendly slice that
    # exists — to give #1596 its best possible shot. If neural can't beat brotli
    # even here, it cannot beat it anywhere.
    big = max(summaries, key=lambda s: s["raw_total"])
    best = max(big["cols"], key=lambda kv: rich_alpha_ratio("\n".join(kv[1])) * len("\n".join(kv[1])))
    field, vals = best
    col_text = "\n".join(vals)

    print(f"\n========== Stage B: neural CE floor on the most language-like column ==========")
    print(f"log={big['name']}  column=`{field}`  raw bytes={len(col_text.encode('utf-8')):,}"
          f"  (this is the BEST case for a neural prior; scoring up to {args.max_resid_bytes:,})")
    n_bpb, scored, ntok = neural_bpb(col_text, args.model, args.max_resid_bytes)

    resid_raw = col_text.encode("utf-8")[:args.max_resid_bytes]
    br = brotli_len(resid_raw)
    br_bpb = bpb(br, len(resid_raw))
    neural_bytes = int(round(n_bpb * len(resid_raw) / 8.0))

    print(f"\nbytes scored               : {scored:,}  ({ntok:,} {args.model} tokens)")
    print(f"brotli-11 on `{field}`        : {br:,} B   = {br_bpb:.3f} bpb")
    print(f"{args.model} CE on `{field}`         : {neural_bytes:,} B   = {n_bpb:.3f} bpb")
    delta = br - neural_bytes
    print("-" * 60)
    if delta > 0:
        print(f"neural BEATS brotli on `{field}` by {delta:,} B ({100*delta/br:.1f}%)"
              f" — #1596 has headroom; confirm on the resident model before building.")
    else:
        print(f"neural LOSES to brotli on `{field}` by {-delta:,} B "
              f"({args.model} {n_bpb:.3f} bpb vs brotli {br_bpb:.3f} bpb).")
        print("=> Even the most language-like column has NO neural-addressable headroom:")
        print("   brotli is already below the LM floor because cross-record redundancy")
        print("   (#1595) dominates; the rest of the col budget is crypto-hash/uuid entropy")
        print("   that no predictor can model. #1596 has no premise at this data scale.")

    print("\n[claim, evidence, confidence, source] — fill verdict from the numbers above.")


if __name__ == "__main__":
    main()
