#!/usr/bin/env python3
"""Build a self-contained, loadable Keystone-Σ₀ PLT checkpoint dir.

Downloads the Apache-2.0 LoopCoder-V2 weights + tokenizer, drops OUR modeling +
configuration code beside them, and rewrites config.json so
`AutoModelForCausalLM.from_pretrained(<out>, trust_remote_code=True)` loads the
model on a stock transformers stack.

    python download_and_patch.py --out ./checkpoint
    python download_and_patch.py --out /data/keystone-sigma0 --revision main

Needs: huggingface_hub, and ~18 GB of disk + download for the bf16 weights.
The weights are NOT committed to git — every training box runs this once.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# Windows consoles default to cp1252 and choke on the ↓/→/✓ status glyphs below.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = Path(__file__).resolve().parent
UPSTREAM = "Multilingual-Multimodal-NLP/LoopCoder-V2"

# Files we overwrite/own in the output dir (our code, not the vendor's).
OUR_FILES = ["configuration_keystone_plt.py", "modeling_keystone_plt.py"]
# Vendor python we deliberately DROP (replaced by ours) so nothing stale loads.
DROP_FILES = [
    "configuration_iquestpltcoder.py",
    "configuration_iquestcoder.py",
    "modeling_iquestpltcoder.py",
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Download + patch LoopCoder-V2 → Keystone-Σ₀ PLT")
    ap.add_argument("--out", default=str(HERE / "checkpoint"), help="output checkpoint dir")
    ap.add_argument("--revision", default="main")
    ap.add_argument("--repo", default=UPSTREAM)
    args = ap.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("pip install huggingface_hub", file=sys.stderr)
        return 2

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    print(f"↓ downloading {args.repo}@{args.revision} → {out}  (~18 GB, one time)")
    snapshot_download(
        repo_id=args.repo,
        revision=args.revision,
        local_dir=str(out),
        allow_patterns=[
            "*.safetensors", "*.safetensors.index.json",
            "tokenizer*", "*.model", "special_tokens_map.json",
            "added_tokens.json", "chat_template.jinja", "generation_config.json",
            "config.json",
        ],
    )

    # Drop vendor python, copy ours in.
    for f in DROP_FILES:
        p = out / f
        if p.exists():
            p.unlink()
            print(f"  − dropped vendor {f}")
    for f in OUR_FILES:
        shutil.copy2(HERE / f, out / f)
        print(f"  + {f}")

    # Patch config.json: own the architecture, wire auto_map to our modules.
    cfg_path = out / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["model_type"] = "keystone_plt"
    cfg["architectures"] = ["KeystonePLTForCausalLM"]
    cfg["auto_map"] = {
        "AutoConfig": "configuration_keystone_plt.KeystonePLTConfig",
        "AutoModelForCausalLM": "modeling_keystone_plt.KeystonePLTForCausalLM",
    }
    cfg.setdefault("plt_clp_shift", False)          # parity knob, default off
    cfg["use_cache"] = False                        # PLT incremental decode is a later stage
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    print("  ✎ patched config.json (model_type, architectures, auto_map, use_cache)")

    # Patch tokenizer_config.json: drop the vendor custom-tokenizer auto_map and
    # use the self-contained fast tokenizer (tokenizer.json) — keeps us off vendor
    # python and avoids a missing tokenization_*.py at load time.
    tok_path = out / "tokenizer_config.json"
    if tok_path.exists():
        tcfg = json.loads(tok_path.read_text(encoding="utf-8"))
        tcfg.pop("auto_map", None)
        tcfg["tokenizer_class"] = "PreTrainedTokenizerFast"
        tok_path.write_text(json.dumps(tcfg, indent=2), encoding="utf-8")
        print("  ✎ patched tokenizer_config.json (→ PreTrainedTokenizerFast)")

    print(f"\n✓ ready: {out}")
    print("  next:  python check_parity.py --model", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
