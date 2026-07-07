"""Shared leaderboard-row provenance + append helper (#2108).

Every benchmark writer (`eval_coding.py`, `eval_humaneval_*.py`, ...) historically
built a summary dict and appended it to `data/eval/leaderboard.jsonl` by hand, with
no record of *which* code/model produced the number. That made the ledger
un-groupable: you could not tell whether two rows came from the same checkpoint, or
which checkpoint was actually served, so any cross-benchmark ("holistic") read was
unsound (see the ck600-vs-he20 snapshot mismatch that motivated this).

This module adds the missing provenance at write time:

- ``git_sha``            — the commit the harness ran at (so a row is tied to code).
- ``served_checkpoint``  — the model that actually produced the row, resolved from
                           the row itself (``engine`` / ``model`` / ``served_models``).
                           Only an in-process Ouro engine inherits the ``OURO_*``
                           serving env (read directly, no import of the serving
                           module, to stay out of its CI gate).
- ``campaign_id``        — a grouping key. Set ``EVAL_CAMPAIGN_ID`` before running a
                           suite against one snapshot and every row it writes shares
                           it; unset, it falls back to the git sha so rows are still
                           groupable by code state.

The ledger is append-only. The original stamp read the ``OURO_*`` env
*unconditionally*, so a run measuring a different engine on a box configured to
serve Ouro got a contradictory stamp — leaderboard label ``qwen25coder-onbox-2173``
records ``model: qwen2.5-coder:latest`` but ``served_checkpoint:
ouro@checkpoint-600``. Such historical rows are NOT rewritten; readers should trust
a row's own ``model``/``served_models`` over a pre-fix ``served_checkpoint`` when
the two disagree. Only future stamps are fixed (``served_checkpoint_for``).

Writers should stop hand-appending and call ``append_leaderboard(row)`` — it stamps
any of the three fields that are missing (never clobbering a value a caller set
deliberately) and writes one JSON line. Keeping the stamping here, not in each
writer, means a schema change lands in one place.
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEADERBOARD_PATH = os.path.join(ROOT, "data", "eval", "leaderboard.jsonl")


def git_sha(short: bool = True) -> Optional[str]:
    """Current HEAD sha, or None if git isn't available (e.g. a source tarball).

    Uses ``execFile``-style arg list (no shell) and swallows any failure — a missing
    sha must never break a benchmark run, it just means that row is un-pinned.
    """
    try:
        args = ["git", "rev-parse", "--short", "HEAD"] if short else ["git", "rev-parse", "HEAD"]
        out = subprocess.run(
            args, cwd=ROOT, capture_output=True, text=True, timeout=5, check=True
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def served_checkpoint() -> Optional[str]:
    """Best-effort id of the local model+adapter this box is CONFIGURED to serve.

    Reads the ``OURO_*`` env the serving path already honours rather than probing a
    running server, so this works whether or not ``ouro_serve.py`` is up and —
    importantly — without importing the serving module (which would drag this into
    the ``eval-leaderboard-gate`` CI check). Shape: ``"<model>@<adapter-basename>"``
    when an adapter is set, else just the model. None when nothing is configured.

    NB: this is the box's serving config, NOT necessarily the engine a given run
    measured — stamping goes through ``served_checkpoint_for(row)``, which only
    trusts this env for rows an Ouro engine actually produced.
    """
    model = os.environ.get("OURO_MODEL") or os.environ.get("KEYSTONE_SERVE_OURO_MODEL")
    adapter = os.environ.get("OURO_ADAPTER")
    if not model and not adapter:
        return None
    if adapter:
        base = os.path.basename(adapter.rstrip("/\\")) or adapter
        return f"{model or 'ouro'}@{base}"
    return model


def served_checkpoint_for(row: dict) -> Optional[str]:
    """served_checkpoint for THIS row, from the engine the run actually used.

    The ``OURO_*`` env describes the box's local-serving config, not necessarily
    what a given run measured, so it is only trusted when the row says an
    in-process Ouro engine produced it. Resolution order:

    1. Ouro engine (``loop`` / anything containing "ouro") — the engine loaded the
       ``OURO_*`` config itself, so the env is the truth; fall back to the row's
       own ``base_model`` when the env is unset.
    2. Chat-surface rows (``served_models`` histogram of what actually answered) —
       unanimous → that model IS the served identity; mixed → there is no single
       checkpoint, so don't invent one (the histogram stays on the row).
    3. Any other engine (Ollama http, cloud provider) — the run's own ``--model``
       arg is what produced the row; the box's serving env is irrelevant.
    4. A row with no engine/model signal at all — legacy env fallback.
    """
    engine = str(row.get("engine") or "").lower()
    if engine == "loop" or "ouro" in engine:
        return served_checkpoint() or row.get("base_model")
    served_models = row.get("served_models")
    if isinstance(served_models, dict) and served_models:
        return next(iter(served_models)) if len(served_models) == 1 else None
    model = row.get("model")
    if model:
        return str(model)
    return served_checkpoint() if not engine else None


def campaign_id() -> str:
    """Grouping key for one benchmark campaign.

    Explicit ``EVAL_CAMPAIGN_ID`` wins (set it once around a whole-suite run so every
    mark shares it). Otherwise fall back to ``sha:<git_sha>`` so rows are still
    groupable by the code state that produced them; ``"uncommitted"`` when even that
    is unavailable.
    """
    explicit = os.environ.get("EVAL_CAMPAIGN_ID")
    if explicit:
        return explicit
    sha = git_sha()
    return f"sha:{sha}" if sha else "uncommitted"


def stamp_provenance(row: dict) -> dict:
    """Add git_sha / served_checkpoint / campaign_id to a row, in place.

    Only fills a field that's absent or None — a caller that set one deliberately
    (e.g. a replay stamping a historical sha) keeps its value. ``served_checkpoint``
    is only added when we could resolve one, so cloud-provider rows aren't polluted
    with an empty key.
    """
    row.setdefault("git_sha", None)
    if row.get("git_sha") is None:
        row["git_sha"] = git_sha()
    row.setdefault("campaign_id", None)
    if row.get("campaign_id") is None:
        row["campaign_id"] = campaign_id()
    if row.get("served_checkpoint") is None:
        sc = served_checkpoint_for(row)
        if sc is not None:
            row["served_checkpoint"] = sc
    return row


def append_leaderboard(row: dict, path: str = LEADERBOARD_PATH) -> dict:
    """Stamp provenance and append ``row`` as one JSON line. Returns the stamped row."""
    stamp_provenance(row)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row
