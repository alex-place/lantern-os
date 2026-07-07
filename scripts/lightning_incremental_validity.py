#!/usr/bin/env python3
"""Dispatch the §8.6-5 incremental-validity experiment to the Lightning L4 studio.

Pattern per the recorded L4 dispatch path: get studio → start L4 → upload payload →
nohup → poll the log → capture SIV_REPORT_JSON → ALWAYS stop the studio (billing).
Usage:  python scripts/lightning_incremental_validity.py [--branch <branch>]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lightning_dispatch import _get_studio, _sdk  # reuse the debugged studio plumbing

PAYLOAD = """#!/usr/bin/env python3
import subprocess, sys, os
R = "/teamspace/studios/this_studio/lantern-siv"
subprocess.run(["rm", "-rf", R])
subprocess.run(["git", "clone", "--depth", "1", "https://github.com/alex-place/lantern-os.git", R], check=True)
subprocess.run(["git", "fetch", "--depth", "1", "origin", "{branch}"], cwd=R, check=True)
subprocess.run(["git", "checkout", "FETCH_HEAD"], cwd=R, check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "transformers==4.57.6", "peft", "accelerate"], check=False)
env = dict(os.environ, KEYSTONE_L4="1", PYTHONUNBUFFERED="1")
r = subprocess.run([sys.executable, "experiments/sigma_incremental_validity.py", "--run",
                    "--base", "ByteDance/Ouro-1.4B", "--out", "/tmp/siv_report.json"], cwd=R, env=env)
print("PAYLOAD_DONE rc=%d" % r.returncode)
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", default="claude/sigma-incremental-validity")
    ap.add_argument("--minutes", type=int, default=55)
    args = ap.parse_args()
    _, Machine = _sdk()
    studio = _get_studio()
    print(f"studio status: {studio.status}")
    try:
        if str(studio.status).lower() not in ("running",):
            print("starting L4 ...")
            studio.start(Machine.L4)
        payload = PAYLOAD.replace("{branch}", args.branch)
        with open("siv_payload.py", "w") as f:
            f.write(payload)
        studio.upload_file("siv_payload.py", "siv_payload.py")
        studio.run("nohup python siv_payload.py > /tmp/siv.log 2>&1 &")
        print("dispatched; polling /tmp/siv.log ...")
        deadline = time.time() + args.minutes * 60
        report = None
        while time.time() < deadline:
            time.sleep(30)
            tail = studio.run("tail -c 3000 /tmp/siv.log 2>/dev/null || echo ''")
            last = (tail or "").strip().splitlines()
            print("  |", last[-1][:160] if last else "(empty)")
            if "SIV_REPORT_JSON:" in (tail or "") or "PAYLOAD_DONE" in (tail or ""):
                full = studio.run("cat /tmp/siv_report.json 2>/dev/null || echo ''")
                if full and full.strip().startswith("{"):
                    report = full.strip()
                break
            if "Traceback" in (tail or ""):
                print("PAYLOAD ERROR — full tail:")
                print(studio.run("tail -c 6000 /tmp/siv.log"))
                break
        if report:
            os.makedirs("data/sigma0", exist_ok=True)
            with open("data/sigma0/incremental_validity_report.json", "w") as f:
                f.write(report)
            print("REPORT SAVED data/sigma0/incremental_validity_report.json")
            print(json.dumps(json.loads(report)["incremental"], indent=1))
        else:
            print("NO REPORT captured (see log output above)")
    finally:
        print("stopping studio (billing) ...")
        try:
            studio.stop()
            print("studio stopped.")
        except Exception as e:  # noqa: BLE001
            print(f"STUDIO STOP FAILED — stop it manually! ({e})")


if __name__ == "__main__":
    main()
