#!/usr/bin/env python3
import subprocess, sys, os
R = "/teamspace/studios/this_studio/lantern-siv"
subprocess.run(["rm", "-rf", R])
subprocess.run(["git", "clone", "--depth", "1", "https://github.com/alex-place/lantern-os.git", R], check=True)
subprocess.run(["git", "fetch", "--depth", "1", "origin", "claude/sigma-incremental-validity"], cwd=R, check=True)
subprocess.run(["git", "checkout", "FETCH_HEAD"], cwd=R, check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "transformers==4.57.6", "peft", "accelerate"], check=False)
env = dict(os.environ, KEYSTONE_L4="1", PYTHONUNBUFFERED="1")
r = subprocess.run([sys.executable, "experiments/sigma_incremental_validity.py", "--run",
                    "--base", "ByteDance/Ouro-1.4B", "--out", "/tmp/siv_report.json"], cwd=R, env=env)
print("PAYLOAD_DONE rc=%d" % r.returncode)
