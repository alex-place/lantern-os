#!/usr/bin/env python3
"""Validate the Lantern OS convergence fleet count contract.

This script validates design counts only. It does not prove live workers.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLEET_DOC = ROOT / "manifests" / "CONVERGENCE-LOOP-AGENT-FLEET.md"
LOOP_DOC = ROOT / "docs" / "CONVERGENCE-LOOP.md"


def count_loop_steps(text: str) -> int:
    return len(re.findall(r"^\d+\. ", text, flags=re.MULTILINE))


def count_matrix_rows(text: str) -> int:
    return len(re.findall(r"^\|\s*\d+\s*\|", text, flags=re.MULTILINE))


def build_receipt() -> dict:
    loop_text = LOOP_DOC.read_text(encoding="utf-8")
    fleet_text = FLEET_DOC.read_text(encoding="utf-8")

    loop_step_count = count_loop_steps(loop_text)
    role_matrix_rows = count_matrix_rows(fleet_text)
    expected_ring_slots = role_matrix_rows * 3
    pool_target = 64 if "32 base workers -> 64 elastic worker pool target" in fleet_text else None

    required_phrases = [
        "12 convergence-loop steps x 3 agents per step = 36 ring agents",
        "Always-Waiting Ring Contract",
        "Step Receipt Shape",
        "expectedRingSlots = 36",
        "poolTarget = 64",
        "design_contract_not_live_worker_proof",
    ]
    missing = [phrase for phrase in required_phrases if phrase not in fleet_text]

    ok = (
        loop_step_count == 12
        and role_matrix_rows == 12
        and expected_ring_slots == 36
        and pool_target == 64
        and not missing
    )

    return {
        "ok": ok,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "loopStepCount": loop_step_count,
        "roleMatrixRows": role_matrix_rows,
        "agentsPerStep": 3,
        "expectedRingSlots": expected_ring_slots,
        "poolTarget": pool_target,
        "claimBoundary": "design_contract_not_live_worker_proof",
        "missing": missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-json", type=Path)
    args = parser.parse_args()

    receipt = build_receipt()
    output = json.dumps(receipt, indent=2, sort_keys=True)
    print(output)

    if args.write_json:
        target = args.write_json
        if not target.is_absolute():
            target = ROOT / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(output + "\n", encoding="utf-8")

    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
