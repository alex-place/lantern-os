"""
In-house durable task ledger for the Convergence Core queue (Superfleet Phase 1).

The MCP task queue was in-memory only (reset on every restart). This makes it
durable WITHOUT any external broker (no Redis/cloud): every queue mutation appends
one event to an append-only JSONL ledger, and on startup the queue is rebuilt by
replaying the ledger (event sourcing). Pure local files — fork/back-up the whole
queue by copying data/queue/.

Event shapes (one JSON object per line):
  {"ts", "event": "enqueued", "task": {...}}                     # task_intake
  {"ts", "event": "status", "task_id", "status", ...fields}      # active/done/failed/cancelled
  {"ts", "event": "deleted", "task_id"}                          # task_delete
  {"ts", "event": "cleared", "filter": "all"|"<status>"}         # queue_clear

Design notes:
- A single Supervisor owns the queue, so there is no distributed-claim problem —
  events are appended by one writer in order.
- Orphaned in-flight tasks (status=active at replay time, i.e. the process died
  mid-run) are requeued to "pending" so work is never silently lost.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

_PRIORITY = {"high": 0, "medium": 1, "low": 2}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_event(ledger_path: Path, event: str, **payload: Any) -> bool:
    """Append one lifecycle event. Best-effort: never raises into the caller."""
    try:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        rec = {"ts": _now(), "event": event, **payload}
        with open(ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, default=str) + "\n")
        return True
    except Exception:
        return False


def replay(ledger_path: Path) -> List[Dict[str, Any]]:
    """Rebuild the live task list from the ledger. Returns tasks sorted by priority.
    Orphaned active tasks are requeued to pending."""
    if not ledger_path.exists():
        return []

    tasks: Dict[str, Dict[str, Any]] = {}
    try:
        with open(ledger_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue  # tolerate a torn final line

                kind = ev.get("event")
                if kind == "enqueued":
                    task = ev.get("task") or {}
                    if task.get("id"):
                        tasks[task["id"]] = dict(task)
                elif kind == "status":
                    tid = ev.get("task_id")
                    if tid in tasks:
                        for k, v in ev.items():
                            if k not in ("ts", "event", "task_id"):
                                tasks[tid][k] = v
                elif kind == "deleted":
                    tasks.pop(ev.get("task_id"), None)
                elif kind == "cleared":
                    flt = ev.get("filter", "all")
                    if flt == "all":
                        tasks.clear()
                    else:
                        tasks = {k: v for k, v in tasks.items() if v.get("status") != flt}
    except Exception:
        # A corrupt ledger should degrade to whatever we parsed, not crash startup.
        pass

    # Requeue work that was in-flight when the process stopped.
    for task in tasks.values():
        if task.get("status") == "active":
            task["status"] = "pending"
            task["requeued_from"] = "active"

    return sorted(tasks.values(), key=lambda t: _PRIORITY.get(t.get("priority"), 1))


def compact(ledger_path: Path) -> int:
    """Rewrite the ledger as one 'enqueued' event per surviving live task
    (drops dead history). Returns the number of live tasks kept. Optional upkeep."""
    live = replay(ledger_path)
    try:
        tmp = ledger_path.with_suffix(".jsonl.compact")
        with open(tmp, "w", encoding="utf-8") as f:
            for task in live:
                f.write(json.dumps({"ts": _now(), "event": "enqueued", "task": task}, default=str) + "\n")
        tmp.replace(ledger_path)
    except Exception:
        pass
    return len(live)
