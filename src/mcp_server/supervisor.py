"""
Superfleet Phase 2 — Supervisor / autoscaler (the "listener").

In-house, local-first ONLY. No Redis, no Celery, no cloud broker. The Supervisor
is the single long-lived "Founder" node from docs/SUPERFLEET-SWARM-DESIGN.md. It is
NOT a new subsystem — it is the Convergence Core scaled: one Kernel, one queue, one
memory, with a bounded pool of interchangeable workers all running the same loop
(Observe -> Remember -> Reason -> Act -> Verify -> Converge) on Task objects. It
strengthens Act (parallel execution) and Reason (idle-time research).

Control loop (one tick, ~2s):

    depth   = queue.pending()                # replay the JSONL ledger
    active  = workers.active()               # = active_slots (status=active)
    cap     = capacity()                     # config/agents.json designedRingSlots -> elastic

    want = min(depth, cap.workers - active)  # spawn workers WHEN tasks exist
    for i in 1..want: spawn_worker()         # worker runs task_run (the Kernel consumer)

    if depth < LOW_WATERMARK and researchers < MAX_RESEARCH:   # research WHEN idle
        spawn_researcher()                                     # DREAM, proposal-only

Spawn-on-demand + drain-triggered research = the swarm never idles and never runs
unbounded.

Safety rails (non-negotiable, per the design doc):
  - Bounded concurrency (ring slots) — never unbounded spawn.
  - Researcher OFF by default (opt-in via SUPERFLEET_RESEARCHER=1).
  - Global pause kill-switch (env SUPERFLEET_PAUSE=1 or data/queue/supervisor.pause file).
  - Worker output is a PROPOSAL until Verified (task_run caps confidence at 0.3).

Local-first guarantee: queue depth is read by replaying the durable JSONL ledger
(data/queue/task-ledger.jsonl) — no running server required to *observe* the queue.
Workers actually execute through the existing task_run path. By default a worker is a
subprocess that calls the in-house task_run tool directly (no network); set
SUPERFLEET_WORKER_MODE=http to instead invoke the MCP server's task_run tool over the
local loopback HTTP endpoint.

Run (either form works; the file puts src/ on sys.path itself):
    python src/mcp_server/supervisor.py --once --dry-run   # show what it would spawn
    python src/mcp_server/supervisor.py --status           # queue snapshot + config
    python src/mcp_server/supervisor.py --once             # run one real tick
    python src/mcp_server/supervisor.py                    # long-lived autoscaler
  or, with src on PYTHONPATH:
    PYTHONPATH=src python -m mcp_server.supervisor --once --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# src/ is the import root (matches pytest.ini `pythonpath = apps src` and server.py).
_THIS = Path(__file__).resolve()
_SRC = _THIS.parents[1]            # .../src
REPO_ROOT = _THIS.parents[2]       # repo root
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
if str(_THIS.parent) not in sys.path:
    sys.path.insert(0, str(_THIS.parent))

import queue_ledger  # noqa: E402  (in-house durable ledger; pure local files)


# --------------------------------------------------------------------------- #
# Paths / config
# --------------------------------------------------------------------------- #

LEDGER_PATH = REPO_ROOT / "data" / "queue" / "task-ledger.jsonl"
AGENTS_CONFIG_PATH = REPO_ROOT / "config" / "agents.json"
PAUSE_FILE = REPO_ROOT / "data" / "queue" / "supervisor.pause"
SUPERVISOR_LOG = REPO_ROOT / "data" / "queue" / "supervisor-events.jsonl"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


@dataclass
class SupervisorConfig:
    """All tunables. Defaults come from config/agents.json + safe env overrides."""

    # Capacity: how many concurrent workers we may have in flight.
    capacity: int = 36                 # config/agents.json designedRingSlots
    elastic_cap: int = 64              # elasticPoolTarget (burst ceiling)
    # Drain-triggered research.
    low_watermark: int = 2             # depth strictly below this == "idle"
    max_researchers: int = 1
    researcher_enabled: bool = False   # OFF by default — opt-in only
    # Loop timing.
    tick_seconds: float = 2.0
    # Worker execution.
    worker_mode: str = "subprocess"    # "subprocess" (local, default) | "http"
    garage_base_url: str = "http://127.0.0.1:4177"
    mcp_base_url: str = "http://127.0.0.1:8771"
    ledger_path: Path = LEDGER_PATH

    @classmethod
    def load(cls) -> "SupervisorConfig":
        cfg = cls()
        # Capacity from agents.json (the design contract).
        try:
            if AGENTS_CONFIG_PATH.exists():
                ac = json.loads(AGENTS_CONFIG_PATH.read_text(encoding="utf-8"))
                cfg.capacity = int(ac.get("designedRingSlots", cfg.capacity))
                cfg.elastic_cap = int(ac.get("elasticPoolTarget", cfg.elastic_cap))
        except Exception:
            pass
        # Env overrides (all optional).
        cfg.capacity = _env_int("SUPERFLEET_CAPACITY", cfg.capacity)
        cfg.elastic_cap = _env_int("SUPERFLEET_ELASTIC_CAP", cfg.elastic_cap)
        cfg.low_watermark = _env_int("SUPERFLEET_LOW_WATERMARK", cfg.low_watermark)
        cfg.max_researchers = _env_int("SUPERFLEET_MAX_RESEARCHERS", cfg.max_researchers)
        cfg.researcher_enabled = _env_flag("SUPERFLEET_RESEARCHER")
        try:
            cfg.tick_seconds = float(os.getenv("SUPERFLEET_TICK_SECONDS", cfg.tick_seconds))
        except (TypeError, ValueError):
            pass
        cfg.worker_mode = os.getenv("SUPERFLEET_WORKER_MODE", cfg.worker_mode).strip().lower()
        cfg.garage_base_url = os.getenv("GARAGE_BASE_URL", cfg.garage_base_url).rstrip("/")
        cfg.mcp_base_url = os.getenv("SUPERFLEET_MCP_URL", cfg.mcp_base_url).rstrip("/")
        return cfg


# --------------------------------------------------------------------------- #
# Queue observation (local-first: replay the durable ledger)
# --------------------------------------------------------------------------- #

@dataclass
class QueueSnapshot:
    depth: int           # pending tasks (work waiting to be claimed)
    active: int          # tasks currently in flight (status=active)
    pending_ids: List[str] = field(default_factory=list)
    total: int = 0       # all live tasks regardless of status


def observe_queue(ledger_path: Path) -> QueueSnapshot:
    """Read queue state by replaying the in-house JSONL ledger. No server needed.

    Mirrors server.py: pending == status 'pending', active == status 'active'.
    queue_ledger.replay already requeues orphaned active tasks from a dead process,
    but a *live* server keeps real active tasks marked active, so we count both.
    """
    tasks = queue_ledger.replay(ledger_path)
    pending = [t for t in tasks if t.get("status") == "pending"]
    active = [t for t in tasks if t.get("status") == "active"]
    return QueueSnapshot(
        depth=len(pending),
        active=len(active),
        pending_ids=[str(t.get("id")) for t in pending if t.get("id")],
        total=len(tasks),
    )


# --------------------------------------------------------------------------- #
# Kill-switch / pause
# --------------------------------------------------------------------------- #

def is_paused() -> bool:
    """Global pause kill-switch: env SUPERFLEET_PAUSE=1 OR a pause file on disk."""
    if _env_flag("SUPERFLEET_PAUSE"):
        return True
    try:
        return PAUSE_FILE.exists()
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Spawn plan (the autoscaling decision — pure, testable)
# --------------------------------------------------------------------------- #

@dataclass
class SpawnPlan:
    workers: int                     # number of workers to spawn this tick
    spawn_researcher: bool           # whether to spawn one researcher this tick
    reason: str
    snapshot: QueueSnapshot
    effective_capacity: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ts": _now(),
            "depth": self.snapshot.depth,
            "active": self.snapshot.active,
            "effective_capacity": self.effective_capacity,
            "workers_to_spawn": self.workers,
            "spawn_researcher": self.spawn_researcher,
            "reason": self.reason,
        }


def plan_tick(
    snap: QueueSnapshot,
    cfg: SupervisorConfig,
    live_workers: int,
    live_researchers: int,
) -> SpawnPlan:
    """Decide what to spawn this tick. Pure function — no side effects.

    want_workers = min(depth, capacity - in_flight), clamped to >= 0.
    in_flight counts both real active tasks AND workers we already launched this run
    (so we never double-count toward capacity).
    """
    capacity = max(cfg.capacity, 0)
    # In-flight = tasks the server has marked active + workers we launched that may
    # not yet have flipped a task to active. Take the max to stay conservative.
    in_flight = max(snap.active, live_workers)
    headroom = max(capacity - in_flight, 0)
    want = max(min(snap.depth, headroom), 0)

    spawn_researcher = (
        cfg.researcher_enabled
        and snap.depth < cfg.low_watermark
        and live_researchers < cfg.max_researchers
    )

    if want > 0:
        reason = f"depth={snap.depth} > 0, headroom={headroom} -> spawn {want} worker(s)"
    elif snap.depth == 0:
        reason = "queue empty -> no workers"
    else:
        reason = (
            f"depth={snap.depth} but at capacity "
            f"(in_flight={in_flight} >= {capacity}) -> no workers"
        )
    if spawn_researcher:
        reason += "; queue idle -> spawn researcher (DREAM, proposal-only)"
    elif cfg.researcher_enabled and snap.depth < cfg.low_watermark:
        reason += "; researcher capped"

    return SpawnPlan(
        workers=want,
        spawn_researcher=spawn_researcher,
        reason=reason,
        snapshot=snap,
        effective_capacity=capacity,
    )


# --------------------------------------------------------------------------- #
# Workers
# --------------------------------------------------------------------------- #

class Worker:
    """A single spawned worker process running one task through task_run.

    Two execution modes, both local-loopback:
      subprocess (default): spawn `python -c` that imports the in-house task_run tool
                            and runs the top pending task. Fully local — works with the
                            network unplugged (task_run itself calls the local garage).
      http:                 POST to the MCP server's task_run tool over loopback.
    """

    def __init__(self, kind: str = "worker", task_id: str = "") -> None:
        self.kind = kind          # "worker" | "researcher"
        self.task_id = task_id
        self.proc: Optional[subprocess.Popen] = None
        self.started_at = time.time()
        self._http_thread: Optional[threading.Thread] = None
        self._http_done = threading.Event()

    # -- lifecycle ------------------------------------------------------ #
    def is_alive(self) -> bool:
        if self.proc is not None:
            return self.proc.poll() is None
        if self._http_thread is not None:
            return not self._http_done.is_set()
        return False

    def returncode(self) -> Optional[int]:
        if self.proc is not None:
            return self.proc.poll()
        if self._http_thread is not None:
            return 0 if self._http_done.is_set() else None
        return None

    def terminate(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass

    # -- spawners ------------------------------------------------------- #
    @classmethod
    def spawn_subprocess(cls, cfg: SupervisorConfig, task_id: str = "") -> "Worker":
        """Spawn a local python subprocess that runs task_run for one task.

        It imports the MCP server lazily and calls _tool_task_run directly so the
        whole thing stays in-house (no broker, no HTTP between supervisor and task_run).
        """
        w = cls(kind="worker", task_id=task_id)
        code = (
            "import sys, json;"
            f"sys.path.insert(0, {str(_SRC / 'mcp_server')!r});"
            f"sys.path.insert(0, {str(_SRC)!r});"
            "import server;"
            f"print(json.dumps(server._tool_task_run({task_id!r})))"
        )
        env = dict(os.environ)
        w.proc = subprocess.Popen(
            [sys.executable, "-c", code],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return w

    @classmethod
    def spawn_http(cls, cfg: SupervisorConfig, task_id: str = "") -> "Worker":
        """Invoke the MCP server's task_run tool over local loopback HTTP (opt-in)."""
        w = cls(kind="worker", task_id=task_id)

        def _run() -> None:
            try:
                _call_mcp_tool(cfg.mcp_base_url, "task_run", {"task_id": task_id})
            except Exception:
                pass
            finally:
                w._http_done.set()

        w._http_thread = threading.Thread(target=_run, daemon=True)
        w._http_thread.start()
        return w


def spawn_worker(cfg: SupervisorConfig, task_id: str = "") -> Worker:
    if cfg.worker_mode == "http":
        return Worker.spawn_http(cfg, task_id)
    return Worker.spawn_subprocess(cfg, task_id)


def spawn_researcher(cfg: SupervisorConfig) -> Worker:
    """Spawn the idle-time researcher: DREAM mode, proposal-only.

    Off by default. When enabled it submits ONE grounded candidate task via the
    in-house task_intake path (low priority). It never injects ungrounded noise:
    the description carries an explicit [claim, evidence, confidence, source] stamp,
    and task_run later caps confidence at 0.3 (LANTERN-DREAM rule).
    """
    w = Worker(kind="researcher")
    claim = (
        "[DREAM proposal] Idle-scan candidate: review the most recent failed/"
        "low-confidence convergence records and propose a concrete follow-up. "
        "[evidence: data/convergence/records.jsonl] [confidence<=0.3] "
        "[source: superfleet researcher]"
    )
    code = (
        "import sys, json;"
        f"sys.path.insert(0, {str(_SRC / 'mcp_server')!r});"
        f"sys.path.insert(0, {str(_SRC)!r});"
        "import server;"
        f"print(json.dumps(server._tool_task_intake({claim!r}, 'low')))"
    )
    w.proc = subprocess.Popen(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT),
        env=dict(os.environ),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return w


# --------------------------------------------------------------------------- #
# MCP HTTP helper (opt-in worker mode only)
# --------------------------------------------------------------------------- #

def _call_mcp_tool(base_url: str, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Minimal MCP tools/call over the server's /messages JSON-RPC endpoint."""
    import urllib.request

    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/messages",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=int(os.getenv("TASK_RUN_TIMEOUT_SEC", "300"))) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


# --------------------------------------------------------------------------- #
# Supervisor
# --------------------------------------------------------------------------- #

class Supervisor:
    """Long-lived autoscaler. One owner, one queue — no distributed-claim problem."""

    def __init__(self, cfg: Optional[SupervisorConfig] = None, dry_run: bool = False) -> None:
        self.cfg = cfg or SupervisorConfig.load()
        self.dry_run = dry_run
        self.workers: List[Worker] = []
        self.researchers: List[Worker] = []
        self.ticks = 0
        self._stop = False

    # -- reaping -------------------------------------------------------- #
    def reap(self) -> int:
        """Drop finished workers/researchers. Returns how many were reaped."""
        before = len(self.workers) + len(self.researchers)
        self.workers = [w for w in self.workers if w.is_alive()]
        self.researchers = [r for r in self.researchers if r.is_alive()]
        return before - (len(self.workers) + len(self.researchers))

    # -- one tick ------------------------------------------------------- #
    def tick(self) -> Dict[str, Any]:
        self.ticks += 1
        reaped = self.reap()

        if is_paused():
            evt = {
                "ts": _now(), "tick": self.ticks, "paused": True,
                "workers_to_spawn": 0, "spawn_researcher": False,
                "reason": "PAUSED (kill-switch)", "reaped": reaped,
                "live_workers": len(self.workers), "live_researchers": len(self.researchers),
            }
            self._log(evt)
            return evt

        snap = observe_queue(self.cfg.ledger_path)
        plan = plan_tick(snap, self.cfg, len(self.workers), len(self.researchers))

        spawned_workers = 0
        spawned_researcher = False
        if not self.dry_run:
            # Spawn workers, each claiming the top pending task (task_run picks it).
            for _ in range(plan.workers):
                # Stop early if we are at the hard elastic ceiling (belt-and-braces).
                if len(self.workers) >= self.cfg.elastic_cap:
                    break
                self.workers.append(spawn_worker(self.cfg))
                spawned_workers += 1
            if plan.spawn_researcher:
                self.researchers.append(spawn_researcher(self.cfg))
                spawned_researcher = True

        evt = {
            **plan.to_dict(),
            "tick": self.ticks,
            "paused": False,
            "reaped": reaped,
            "dry_run": self.dry_run,
            "spawned_workers": spawned_workers,
            "spawned_researcher": spawned_researcher,
            "live_workers": len(self.workers),
            "live_researchers": len(self.researchers),
            "worker_mode": self.cfg.worker_mode,
            "researcher_enabled": self.cfg.researcher_enabled,
        }
        self._log(evt)
        return evt

    # -- run loop ------------------------------------------------------- #
    def run_once(self) -> Dict[str, Any]:
        return self.tick()

    def run_forever(self) -> None:
        try:
            while not self._stop:
                evt = self.tick()
                _print_event(evt)
                time.sleep(self.cfg.tick_seconds)
        except KeyboardInterrupt:
            self.stop()

    def stop(self) -> None:
        self._stop = True
        for w in list(self.workers) + list(self.researchers):
            w.terminate()

    # -- observability -------------------------------------------------- #
    def _log(self, evt: Dict[str, Any]) -> None:
        try:
            SUPERVISOR_LOG.parent.mkdir(parents=True, exist_ok=True)
            with open(SUPERVISOR_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(evt, default=str) + "\n")
        except Exception:
            pass


def _print_event(evt: Dict[str, Any]) -> None:
    if evt.get("paused"):
        print(f"[{evt['ts']}] tick={evt['tick']} PAUSED -- {evt['reason']}")
        return
    print(
        f"[{evt['ts']}] tick={evt['tick']} "
        f"depth={evt.get('depth')} active={evt.get('active')} "
        f"cap={evt.get('effective_capacity')} "
        f"want={evt.get('workers_to_spawn')} "
        f"spawned={evt.get('spawned_workers', 0)} "
        f"researcher={evt.get('spawn_researcher')} "
        f"live_workers={evt.get('live_workers')} "
        f"{'[DRY-RUN] ' if evt.get('dry_run') else ''}-- {evt.get('reason')}"
    )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="supervisor",
        description="Superfleet Phase 2 Supervisor / autoscaler (in-house, local-first).",
    )
    p.add_argument("--once", action="store_true",
                   help="Run exactly one tick and exit.")
    p.add_argument("--dry-run", action="store_true",
                   help="Decide and print what would be spawned, but spawn nothing.")
    p.add_argument("--tick-seconds", type=float, default=None,
                   help="Override loop interval (default from SUPERFLEET_TICK_SECONDS or 2s).")
    p.add_argument("--capacity", type=int, default=None,
                   help="Override worker capacity (default = agents.json designedRingSlots).")
    p.add_argument("--researcher", action="store_true",
                   help="Enable the idle-time researcher (off by default).")
    p.add_argument("--status", action="store_true",
                   help="Print queue snapshot + config and exit (no spawn).")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    cfg = SupervisorConfig.load()
    if args.tick_seconds is not None:
        cfg.tick_seconds = args.tick_seconds
    if args.capacity is not None:
        cfg.capacity = args.capacity
    if args.researcher:
        cfg.researcher_enabled = True

    if args.status:
        snap = observe_queue(cfg.ledger_path)
        print(json.dumps({
            "ledger": str(cfg.ledger_path),
            "ledger_exists": cfg.ledger_path.exists(),
            "depth": snap.depth,
            "active": snap.active,
            "total_live": snap.total,
            "capacity": cfg.capacity,
            "elastic_cap": cfg.elastic_cap,
            "low_watermark": cfg.low_watermark,
            "researcher_enabled": cfg.researcher_enabled,
            "worker_mode": cfg.worker_mode,
            "paused": is_paused(),
        }, indent=2))
        return 0

    sup = Supervisor(cfg=cfg, dry_run=args.dry_run)

    if args.once or args.dry_run:
        evt = sup.run_once()
        _print_event(evt)
        return 0

    print(
        f"[supervisor] starting — capacity={cfg.capacity} elastic={cfg.elastic_cap} "
        f"low_watermark={cfg.low_watermark} tick={cfg.tick_seconds}s "
        f"researcher={'ON' if cfg.researcher_enabled else 'OFF'} "
        f"worker_mode={cfg.worker_mode}"
    )
    print(f"[supervisor] ledger={cfg.ledger_path}")
    print("[supervisor] pause: set SUPERFLEET_PAUSE=1 or touch "
          f"{PAUSE_FILE}. Ctrl-C to stop.")
    sup.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
