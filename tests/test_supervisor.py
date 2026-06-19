"""
Tests for the Superfleet Phase 2 Supervisor / autoscaler.

These cover the pure decision logic (plan_tick), local-first queue observation
(replay the JSONL ledger), the pause kill-switch, and a dry-run tick — none of
which spawn real worker processes, so the suite is fast and side-effect-free.
"""

import sys
from pathlib import Path

import pytest

# src/mcp_server is the home of supervisor.py + queue_ledger.py.
_MCP = Path(__file__).resolve().parents[1] / "src" / "mcp_server"
if str(_MCP) not in sys.path:
    sys.path.insert(0, str(_MCP))

import queue_ledger  # noqa: E402
import supervisor as sup  # noqa: E402


def _make_ledger(tmp_path, n_pending=0, n_active=0):
    """Build a ledger with n_pending pending + n_active active tasks."""
    ledger = tmp_path / "task-ledger.jsonl"
    for i in range(n_pending):
        queue_ledger.append_event(
            ledger, "enqueued",
            task={"id": f"p{i}", "description": f"pending {i}",
                  "priority": "medium", "status": "pending"},
        )
    for i in range(n_active):
        tid = f"a{i}"
        queue_ledger.append_event(
            ledger, "enqueued",
            task={"id": tid, "description": f"active {i}",
                  "priority": "medium", "status": "pending"},
        )
        queue_ledger.append_event(ledger, "status", task_id=tid, status="active")
    return ledger


# --------------------------------------------------------------------------- #
# Queue observation (local-first)
# --------------------------------------------------------------------------- #

def test_observe_empty_ledger(tmp_path):
    snap = sup.observe_queue(tmp_path / "missing.jsonl")
    assert snap.depth == 0
    assert snap.active == 0
    assert snap.total == 0


def test_observe_requeues_orphaned_active_to_pending(tmp_path):
    # queue_ledger.replay requeues orphaned active tasks to pending: a dead process
    # cannot keep work in flight, so durability recovery moves the 2 "active" tasks
    # back to pending. Observing the file therefore sees all 5 as pending.
    ledger = _make_ledger(tmp_path, n_pending=3, n_active=2)
    snap = sup.observe_queue(ledger)
    assert snap.depth == 5      # 3 pending + 2 recovered-from-active
    assert snap.active == 0     # nothing is truly in flight (no live process)
    assert snap.total == 5      # all 5 tasks are still live in the ledger


# --------------------------------------------------------------------------- #
# plan_tick — the autoscaling decision (pure)
# --------------------------------------------------------------------------- #

def test_plan_spawns_workers_when_depth_positive():
    cfg = sup.SupervisorConfig(capacity=36, low_watermark=2, researcher_enabled=False)
    snap = sup.QueueSnapshot(depth=5, active=0)
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.workers == 5
    assert plan.spawn_researcher is False


def test_plan_clamps_to_capacity_headroom():
    cfg = sup.SupervisorConfig(capacity=10, researcher_enabled=False)
    # 8 already active -> only 2 headroom even though depth=20.
    snap = sup.QueueSnapshot(depth=20, active=8)
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.workers == 2


def test_plan_no_workers_when_at_capacity():
    cfg = sup.SupervisorConfig(capacity=4, researcher_enabled=False)
    snap = sup.QueueSnapshot(depth=10, active=4)
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.workers == 0


def test_plan_counts_already_launched_workers_toward_capacity():
    cfg = sup.SupervisorConfig(capacity=5, researcher_enabled=False)
    # No tasks marked active yet, but we already launched 3 workers this run.
    snap = sup.QueueSnapshot(depth=10, active=0)
    plan = sup.plan_tick(snap, cfg, live_workers=3, live_researchers=0)
    assert plan.workers == 2


def test_plan_no_workers_when_queue_empty():
    cfg = sup.SupervisorConfig(capacity=36, researcher_enabled=False)
    snap = sup.QueueSnapshot(depth=0, active=0)
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.workers == 0


# --------------------------------------------------------------------------- #
# Researcher — OFF by default, opt-in, drain-triggered, bounded
# --------------------------------------------------------------------------- #

def test_researcher_off_by_default():
    cfg = sup.SupervisorConfig(capacity=36, low_watermark=2)
    assert cfg.researcher_enabled is False
    snap = sup.QueueSnapshot(depth=0, active=0)  # idle
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.spawn_researcher is False


def test_researcher_spawns_when_idle_and_enabled():
    cfg = sup.SupervisorConfig(capacity=36, low_watermark=2,
                               researcher_enabled=True, max_researchers=1)
    snap = sup.QueueSnapshot(depth=1, active=0)  # below low_watermark
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.spawn_researcher is True


def test_researcher_not_spawned_when_busy():
    cfg = sup.SupervisorConfig(capacity=36, low_watermark=2, researcher_enabled=True)
    snap = sup.QueueSnapshot(depth=10, active=0)  # busy, above watermark
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=0)
    assert plan.spawn_researcher is False


def test_researcher_bounded_by_max():
    cfg = sup.SupervisorConfig(capacity=36, low_watermark=2,
                               researcher_enabled=True, max_researchers=1)
    snap = sup.QueueSnapshot(depth=0, active=0)
    plan = sup.plan_tick(snap, cfg, live_workers=0, live_researchers=1)
    assert plan.spawn_researcher is False


# --------------------------------------------------------------------------- #
# Pause kill-switch
# --------------------------------------------------------------------------- #

def test_pause_env_flag(monkeypatch):
    monkeypatch.setenv("SUPERFLEET_PAUSE", "1")
    assert sup.is_paused() is True


def test_pause_off_by_default(monkeypatch):
    monkeypatch.delenv("SUPERFLEET_PAUSE", raising=False)
    monkeypatch.setattr(sup, "PAUSE_FILE", Path("/nonexistent/supervisor.pause"))
    assert sup.is_paused() is False


# --------------------------------------------------------------------------- #
# Dry-run tick spawns nothing
# --------------------------------------------------------------------------- #

def test_dry_run_tick_spawns_nothing(tmp_path):
    ledger = _make_ledger(tmp_path, n_pending=5)
    cfg = sup.SupervisorConfig(capacity=36, ledger_path=ledger, researcher_enabled=False)
    s = sup.Supervisor(cfg=cfg, dry_run=True)
    evt = s.run_once()
    assert evt["dry_run"] is True
    assert evt["workers_to_spawn"] == 5     # it WOULD spawn 5
    assert evt["spawned_workers"] == 0      # but spawned none
    assert len(s.workers) == 0


def test_paused_tick_spawns_nothing(tmp_path, monkeypatch):
    ledger = _make_ledger(tmp_path, n_pending=5)
    cfg = sup.SupervisorConfig(capacity=36, ledger_path=ledger)
    monkeypatch.setenv("SUPERFLEET_PAUSE", "1")
    s = sup.Supervisor(cfg=cfg, dry_run=False)
    evt = s.tick()
    assert evt["paused"] is True
    assert len(s.workers) == 0


def test_config_loads_capacity_from_agents_json():
    cfg = sup.SupervisorConfig.load()
    # agents.json ships designedRingSlots=36 / elasticPoolTarget=64.
    assert cfg.capacity >= 1
    assert cfg.elastic_cap >= cfg.capacity
