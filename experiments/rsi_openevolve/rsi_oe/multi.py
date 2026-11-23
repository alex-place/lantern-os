"""Run many (arm, seed) runs as coroutines in one process, sharing a sandbox pool.

Memory is the constraint on the 12 GB dev box: one process per run costs ~200 MB each.
Here every run is a coroutine; they share one pool of sandbox workers and one thread
executor. OpenEvolve's database and prompt sampler draw from Python's global `random`,
so each run restores its own `random` state after every await (ArmRun._aw); the code
between awaits runs uninterrupted, so each run sees only its own random stream.

    python -m rsi_oe.multi loop --root runs/main --arms 1,2,3 --seeds 0,1,2,3,4 --gens 30
    python -m rsi_oe.multi successor --root runs/main --test-gens 5,10,15,20,25,30
"""
from __future__ import annotations

import argparse
import asyncio
import concurrent.futures as cf
import json
import sys
import time
import traceback
from pathlib import Path

from . import sandbox
from .llm import LLM, Ledger
from .loop import ArmRun, RunConfig
from .successor import run_successor


async def _guard(name: str, coro, status: dict, root: Path):
    t0 = time.time()
    try:
        res = await coro
        status[name] = {"ok": True, "minutes": round((time.time() - t0) / 60, 1)}
        return res
    except Exception:  # one run's failure must not stop the others
        status[name] = {"ok": False, "error": traceback.format_exc()[-2000:]}
        return None
    finally:
        (root / "multi_status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
        print(json.dumps({"done": name, **{k: v for k, v in status[name].items() if k != "error"}}),
              flush=True)


async def main_async(a) -> int:
    loop = asyncio.get_running_loop()
    loop.set_default_executor(cf.ThreadPoolExecutor(max_workers=64))
    root = Path(a.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    pool = sandbox.SandboxPool(a.workers)
    status: dict = {}
    tasks = []
    try:
        for s in [int(x) for x in a.seeds.split(",")]:
            for arm in [int(x) for x in a.arms.split(",")]:
                name = f"arm{arm}_s{s}"
                out = root / name
                if a.mode == "loop":
                    cfg = RunConfig(arm=arm, seed=s, out=str(out), gens=a.gens, model=a.model)
                    run = ArmRun(cfg, pool=pool)
                    tasks.append(_guard(name, run.run(), status, root))
                else:
                    if not (out / "config.json").exists():
                        continue
                    cfg = json.loads((out / "config.json").read_text(encoding="utf-8"))
                    llm = LLM(cfg["model"], "openai", temperature=0.7, max_tokens=cfg["max_tokens"],
                              ledger=Ledger())
                    gens = [int(x) for x in a.test_gens.split(",")]
                    tasks.append(_guard(name, run_successor(out, gens, llm, pool=pool), status, root))
        await asyncio.gather(*tasks)
    finally:
        pool.close()
    return 0 if all(v.get("ok") for v in status.values()) else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("mode", choices=("loop", "successor"))
    ap.add_argument("--root", required=True)
    ap.add_argument("--arms", default="1,2,3")
    ap.add_argument("--seeds", default="0,1,2,3,4")
    ap.add_argument("--gens", type=int, default=30)
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--test-gens", default="5,10,15,20,25,30")
    return asyncio.run(main_async(ap.parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
