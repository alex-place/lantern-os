#!/usr/bin/env python3
"""
Re-run the Jun-15 "5000 shorts" Σ₀ study against REAL data.

WHY: the original study (commit d1544d2f) read data/youtube/raw_shorts_dataset.jsonl,
which is SYNTHETIC mock output from youtube_shorts_collector_v2._mock_api_data
(video_id "vid_000000", channel "UCchannel_0", views ~ lognormvariate). Real
samples (source="youtube_api_real") only arrived later in top5000_shorts.jsonl.

This script applies the SAME methodology (analyze_shorts.py) to the real dataset
so the original findings can be confirmed or marked provisional. It writes nothing
and trains nothing — pure read + report.

Usage:
    python scripts/rerun_shorts_real.py [path-to-real.jsonl]
    (default: data/youtube/top5000_shorts.jsonl)
"""

import json
import statistics
import sys
from pathlib import Path

# Reuse the exact feature extractor the original study relied on.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from v10_feature_extractor import SigmaZeroFeatureExtractor  # noqa: E402


def calc_collapse_risk(sigma0):
    # Identical formula to analyze_shorts.py.
    return max(0, (1 - sigma0["entropy_proxy"]) * 0.35
                  + (1 - sigma0["retention_proxy"]) * 0.35
                  + (1 - sigma0["velocity_score"]) * 0.30)


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "data/youtube/top5000_shorts.jsonl")
    if not src.exists():
        print(f"[ERROR] dataset not found: {src}")
        return 1

    rows = []
    real = 0
    with open(src, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            rows.append(r)
            if r.get("source") == "youtube_api_real":
                real += 1

    print(f"[DATASET] {src}")
    print(f"  rows={len(rows)} | marked real (source=youtube_api_real)={real} "
          f"({100*real/max(1,len(rows)):.0f}%)")
    if real == 0:
        print("  [WARN] no rows are marked real — this looks synthetic too.")
    print()

    ex = SigmaZeroFeatureExtractor()
    feats = [ex.extract_features(r) for r in rows]

    views = [f["engagement"]["views"] for f in feats]
    hi_thresh = statistics.quantiles(views, n=4)[2]  # 75th percentile
    hi = [f for f in feats if f["engagement"]["views"] >= hi_thresh]
    lo = [f for f in feats if f["engagement"]["views"] < hi_thresh]

    m_hi = statistics.mean([f["sigma0"]["motion_proxy"] for f in hi])
    m_lo = statistics.mean([f["sigma0"]["motion_proxy"] for f in lo])
    c_hi = statistics.mean([calc_collapse_risk(f["sigma0"]) for f in hi])
    c_lo = statistics.mean([calc_collapse_risk(f["sigma0"]) for f in lo])

    print("[REAL-DATA RERUN — top 25% by views vs rest]")
    print(f"  Motion        high={m_hi:.3f}  low={m_lo:.3f}  "
          f"delta={100*(m_hi-m_lo)/max(1e-9,m_lo):+.0f}%")
    print(f"  Collapse risk high={c_hi:.3f}  low={c_lo:.3f}  "
          f"delta={100*(c_hi-c_lo)/max(1e-9,c_lo):+.0f}%")
    print()

    print("[vs SYNTHETIC FINDING (commit d1544d2f)]")
    print(f"  Motion: synthetic said high>low (0.541 vs 0.404, +34%). "
          f"Real: {'REPLICATES' if m_hi > m_lo else 'DOES NOT replicate'}.")
    print(f"  Collapse: synthetic said viral=higher risk (0.449 vs 0.334). "
          f"Real: {'same direction' if c_hi > c_lo else 'OPPOSITE direction'}.")
    print()
    print("[CAVEAT] motion_proxy is a TITLE/metadata keyword+velocity heuristic, not")
    print("  a measured editing feature. This rerun validates the metadata prior only,")
    print("  not the 'editing language' claim. See docs/creator-v10/learning-pipeline-research.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
