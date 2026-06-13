import json
from datetime import datetime, timedelta, timezone

from convergence_io_engine import TesseractEngine, NapSafety, ConvergenceLoop


def _write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_engine(tmp_path):
    engine = TesseractEngine(data_dir=str(tmp_path))
    engine.health.check = lambda url: {
        "url": url,
        "ok": True,
        "status": 200,
        "latency_ms": 1.0,
    }
    return engine


def test_health_check_requires_active_worker_or_fresh_listener(tmp_path):
    engine = _build_engine(tmp_path)
    try:
        result = engine.health_check("http://example.test/api/status")
        assert result["http_ok"] is True
        assert result["ok"] is False
        assert result["agent_activity"]["state"] == "idle"
        assert result["agent_activity"]["listener"]["status"] == "missing"
        assert "no active slots" in result["issues"][0]
    finally:
        engine._executor.shutdown(wait=False)


def test_health_check_rejects_stale_listener_manifest(tmp_path):
    now = datetime.now(timezone.utc)
    _write_json(
        tmp_path / "dollhouse" / "agent-checkin-manifest.json",
        {
            "generated_at": now.isoformat(),
            "listener": {
                "agent": "agent_inspector",
                "status": "active",
                "interval_seconds": 60,
                "heartbeat_at": (now - timedelta(minutes=5)).isoformat(),
            },
            "slots": [
                {
                    "slot_id": "checkin-old",
                    "interval_minutes": 30,
                    "agent_type": "dollhouse_monitor",
                    "last_run": (now - timedelta(hours=3)).isoformat(),
                    "status": "active",
                }
            ],
        },
    )

    engine = _build_engine(tmp_path)
    try:
        result = engine.health_check("http://example.test/api/status")
        listener = result["agent_activity"]["listener"]
        assert result["ok"] is False
        assert result["agent_activity"]["state"] == "idle"
        assert listener["source"] == "agent-checkin-manifest"
        assert listener["status"] == "stale"
        assert listener["ready"] is False
    finally:
        engine._executor.shutdown(wait=False)


def test_health_check_accepts_fresh_listener_manifest(tmp_path):
    now = datetime.now(timezone.utc)
    _write_json(
        tmp_path / "dollhouse" / "agent-checkin-manifest.json",
        {
            "generated_at": now.isoformat(),
            "listener": {
                "agent": "agent_inspector",
                "status": "active",
                "interval_seconds": 60,
                "heartbeat_at": (now - timedelta(seconds=20)).isoformat(),
            },
            "slots": [
                {
                    "slot_id": "checkin-fresh",
                    "interval_minutes": 30,
                    "agent_type": "dollhouse_monitor",
                    "last_run": (now - timedelta(minutes=10)).isoformat(),
                    "status": "active",
                }
            ],
        },
    )

    engine = _build_engine(tmp_path)
    try:
        result = engine.health_check("http://example.test/api/status")
        listener = result["agent_activity"]["listener"]
        assert result["ok"] is True
        assert result["agent_activity"]["state"] == "listener"
        assert listener["source"] == "agent-checkin-manifest"
        assert listener["ready"] is True
        assert listener["status"] == "fresh"
    finally:
        engine._executor.shutdown(wait=False)


def test_health_check_counts_any_active_slot_as_operational(tmp_path):
    _write_json(
        tmp_path / "agent-fleet" / "slots.json",
        {
            "version": 1,
            "slots": {
                "dream_journal-verify-req-0001": {
                    "claimed_at": datetime.now(timezone.utc).isoformat(),
                    "status": "active",
                }
            },
        },
    )

    engine = _build_engine(tmp_path)
    try:
        result = engine.health_check("http://example.test/api/status")
        activity = result["agent_activity"]
        inspect = engine.inspect()
        assert result["ok"] is True
        assert activity["state"] == "active"
        assert activity["active_slots"] == 1
        assert activity["dream_journal_slots_active"] == 1
        assert inspect["slots_active"] == 1
        assert inspect["dream_journal_slots_active"] == 1
    finally:
        engine._executor.shutdown(wait=False)


def test_health_check_accepts_fresh_tesseract_listener_snapshot(tmp_path):
    now = datetime.now(timezone.utc)
    _write_json(
        tmp_path / "agent-fleet" / "tesseract-latest.json",
        {
            "timestamp": now.isoformat(),
            "listener": {
                "agent": "agent_inspector",
                "status": "active",
                "interval_seconds": 60,
                "heartbeat_at": (now - timedelta(seconds=10)).isoformat(),
            },
            "dollhouse": {
                "status": "ok",
                "checkin_slots": 6,
            },
        },
    )

    engine = _build_engine(tmp_path)
    try:
        result = engine.health_check("http://example.test/api/status")
        listener = result["agent_activity"]["listener"]
        assert result["ok"] is True
        assert result["agent_activity"]["state"] == "listener"
        assert listener["source"] == "tesseract-latest"
        assert listener["ready"] is True
    finally:
        engine._executor.shutdown(wait=False)


# ══════════════════════════════════════════════════════════════════
#  Digital Blackbox — Internal Acceleration Tests
# ══════════════════════════════════════════════════════════════════


def test_nap_safety_returns_structure_even_without_psutil():
    nap = NapSafety()
    result = nap.check()
    assert "cpu_temp_c" in result
    assert "mem_percent" in result
    assert "throttle" in result
    assert "abort" in result
    assert result["abort"] is False


def _setup_repo_for_loop(tmp_path):
    """Create minimal repo structure so all 20 ConvergenceLoop phases pass."""
    import json as _json

    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    (scripts_dir / "Validate-CicdPipeline.ps1").write_text("# placeholder", encoding="utf-8")
    (tmp_path / "README.md").write_text("# Test\nCurrent Focus: test", encoding="utf-8")
    manifests_dir = tmp_path / "manifests" / "evidence"
    manifests_dir.mkdir(parents=True, exist_ok=True)
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    (docs_dir / "CONVERGENCE-LOOP.md").write_text("# doc", encoding="utf-8")
    (docs_dir / "CSF-FORMAT-SPECIFICATION.md").write_text("# spec", encoding="utf-8")
    # Phase 8 (check_ctf_symbolic): src/csf/ with at least one .py module
    csf_dir = tmp_path / "src" / "csf"
    csf_dir.mkdir(parents=True, exist_ok=True)
    (csf_dir / "memory_engine.py").write_text("# stub", encoding="utf-8")
    # Phase 9 (check_external_grounding): RAG house as external signal
    rag_dir = tmp_path / "data" / "rag-house"
    rag_dir.mkdir(parents=True, exist_ok=True)
    (rag_dir / "flat-rag-house-latest.json").write_text(
        _json.dumps({"sources": [], "recentConversations": []}), encoding="utf-8"
    )
    # Phase 10 (check_externally_anchored): PCSF model as second anchor
    pcsf_dir = tmp_path / "data" / "pcsf"
    pcsf_dir.mkdir(parents=True, exist_ok=True)
    (pcsf_dir / "model.pcsf.json").write_text(_json.dumps({"version": "1.0"}), encoding="utf-8")
    # ValidationRing needs data/agent-fleet
    (tmp_path / "data" / "agent-fleet").mkdir(parents=True, exist_ok=True)


def test_convergence_loop_default_multiplier_is_five(tmp_path):
    _setup_repo_for_loop(tmp_path)
    loop = ConvergenceLoop(repo_root=tmp_path)
    result = loop.run()
    # Adaptive early-exit means ticks <= configured multiplier (5)
    assert 1 <= result["internal_ticks"] <= 5
    assert result["promotion_ready"] is True
    assert result.get("status") != "aborted"
    assert len(result["phases"]) >= 1


def test_convergence_loop_custom_multiplier_and_dilation(tmp_path):
    _setup_repo_for_loop(tmp_path)
    loop = ConvergenceLoop(repo_root=tmp_path, internal_multiplier=2, external_dilation=0.5)
    result = loop.run()
    assert result["internal_ticks"] == 2
    assert result["promotion_ready"] is True
    # 1 internal tick * 18 (20 - 2 external) + 1 final tick * 20 = 38
    assert len(result["phases"]) == 38


def test_convergence_loop_external_io_phases_only_on_final_tick(tmp_path):
    _setup_repo_for_loop(tmp_path)
    # With multiplier=1 the single tick IS the final tick, so external phases run
    loop = ConvergenceLoop(repo_root=tmp_path, internal_multiplier=1)
    result = loop.run()
    names = [p["name"] for p in result["phases"]]
    assert names.count("record_evidence") == 1
    assert names.count("promote_or_hold") == 1
    assert names.count("inspect_repo") == 1
    # With multiplier > 1, adaptive exit may stop before the final tick;
    # external phases appear at most once regardless of ticks run
    loop3 = ConvergenceLoop(repo_root=tmp_path, internal_multiplier=3)
    result3 = loop3.run()
    names3 = [p["name"] for p in result3["phases"]]
    assert names3.count("record_evidence") <= 1
    assert names3.count("inspect_repo") == result3["internal_ticks"]


def test_convergence_loop_respects_zero_multiplier(tmp_path):
    _setup_repo_for_loop(tmp_path)
    loop = ConvergenceLoop(repo_root=tmp_path, internal_multiplier=0)
    result = loop.run()
    # min(1, 0) clamps to 1
    assert result["internal_ticks"] == 1
    assert len(result["phases"]) == 20


def test_convergence_loop_includes_safety_telemetry(tmp_path):
    _setup_repo_for_loop(tmp_path)
    loop = ConvergenceLoop(repo_root=tmp_path, internal_multiplier=1)
    result = loop.run()
    assert "safety" in result
    assert "cpu_temp_c" in result["safety"]
    assert "mem_percent" in result["safety"]


def test_deterministic_slot_id_on_retry(tmp_path):
    from convergence_io_engine import SlotManager
    slots = SlotManager(path=tmp_path / "slots.json")
    # First claim — slot_id is deterministic: "{slot_type}-{request_id}"
    id1 = slots.claim("dream_journal", "req-001")
    assert id1 is not None
    # Retry with same args returns the same deterministic slot id
    id2 = slots.claim("dream_journal", "req-001")
    assert id2 == id1
    # Different request_id gets a different slot
    id3 = slots.claim("dream_journal", "req-002")
    assert id3 != id1
    # After release, same args still produce the same deterministic slot id
    slots.release(id1)
    id4 = slots.claim("dream_journal", "req-001")
    assert id4 == id1


def test_trace_tree_structures_spans_and_finds_slowest(tmp_path):
    engine = _build_engine(tmp_path)
    # Mock internals so converge returns quickly without real work
    engine._surface = lambda ctx, msg: ctx
    engine._interface_mcp = lambda ctx: ctx
    engine._interface_slot_claim = lambda ctx: ctx
    engine._convergence_csf = lambda ctx: ctx
    engine._convergence_rag = lambda ctx: ctx
    engine._core_inference = lambda ctx, msg: {"text": "ok", "provider": "mock"}
    engine._convergence_log = lambda ctx, msg, result: None
    engine._interface_slot_release = lambda ctx: None
    engine._surface_render = lambda ctx, result: {"text": result.get("text", "ok"), "source": "mock"}
    try:
        result = engine.converge("test message")
        trace_tree = result.get("trace_tree")
        assert trace_tree is not None
        assert "spans" in trace_tree
        assert "slowest" in trace_tree
        # Should have spans for all the layers
        span_names = [s["op"] for s in trace_tree["spans"]]
        assert "persona_select" in span_names or "mcp_bridge" in span_names
    finally:
        engine._queue_depth = 0
        engine._executor.shutdown(wait=False)


def test_backpressure_returns_429_when_queue_saturated(tmp_path):
    engine = _build_engine(tmp_path)
    engine._max_queue_depth = 2
    try:
        # Artificially saturate the queue
        engine._queue_depth = 2
        result = engine.converge("test message")
        assert result["source"] == "backpressure"
        assert "429" in result["text"]
        assert result.get("retry_after") == 5
    finally:
        engine._queue_depth = 0
        engine._executor.shutdown(wait=False)


def test_backpressure_allows_request_when_queue_has_room(tmp_path):
    engine = _build_engine(tmp_path)
    engine._max_queue_depth = 8
    # Mock internals so converge returns quickly without real work
    engine._surface = lambda ctx, msg: ctx
    engine._interface_mcp = lambda ctx: ctx
    engine._interface_slot_claim = lambda ctx: ctx
    engine._convergence_csf = lambda ctx: ctx
    engine._convergence_rag = lambda ctx: ctx
    engine._core_inference = lambda ctx, msg: {"text": "ok", "provider": "mock"}
    engine._convergence_log = lambda ctx, msg, result: None
    engine._interface_slot_release = lambda ctx: None
    engine._surface_render = lambda ctx, result: {"text": result.get("text", "ok"), "source": "mock"}
    try:
        engine._queue_depth = 0
        result = engine.converge("test message")
        # Should not be backpressure; should be mock
        assert result["source"] != "backpressure"
    finally:
        engine._queue_depth = 0
        engine._executor.shutdown(wait=False)


def test_convergence_receipt_diff_detects_regressions_and_fixed_issues():
    from convergence_io_engine import ConvergenceReceipt

    prev = {
        "phases": [
            {"name": "inspect_repo", "status": "pass", "issues": [], "evidence": {"files": 100}},
            {"name": "identify_sources", "status": "pass", "issues": [], "evidence": {"dirty": False}},
            {"name": "test_suite", "status": "fail", "issues": ["test_a failed"], "evidence": {}},
        ]
    }
    curr = {
        "phases": [
            {"name": "inspect_repo", "status": "pass", "issues": [], "evidence": {"files": 100}},
            {"name": "identify_sources", "status": "fail", "issues": ["new dirty file"], "evidence": {"dirty": True}},
            {"name": "test_suite", "status": "pass", "issues": [], "evidence": {}},
        ]
    }
    diff = ConvergenceReceipt.diff(prev, curr)
    assert diff["has_previous"] is True
    assert "identify_sources" in diff["regressions"]
    assert {"phase": "identify_sources", "issue": "new dirty file"} in diff["new_issues"]
    assert {"phase": "test_suite", "issue": "test_a failed"} in diff["fixed_issues"]
    assert diff["manifest_drift"]["identify_sources.dirty"] == {"from": False, "to": True}
    assert diff["unchanged"] is False


def test_convergence_receipt_diff_first_run():
    from convergence_io_engine import ConvergenceReceipt
    diff = ConvergenceReceipt.diff({}, {"phases": [{"name": "inspect_repo", "status": "pass"}]})
    assert diff["has_previous"] is False
    assert diff["unchanged"] is False
    assert diff["regressions"] == []


def test_backpressure_decrements_queue_depth_on_return(tmp_path):
    engine = _build_engine(tmp_path)
    engine._max_queue_depth = 8
    # Mock internals so converge returns quickly without real work
    engine._surface = lambda ctx, msg: ctx
    engine._interface_mcp = lambda ctx: ctx
    engine._interface_slot_claim = lambda ctx: ctx
    engine._convergence_csf = lambda ctx: ctx
    engine._convergence_rag = lambda ctx: ctx
    engine._core_inference = lambda ctx, msg: {"text": "ok", "provider": "mock"}
    engine._convergence_log = lambda ctx, msg, result: None
    engine._interface_slot_release = lambda ctx: None
    engine._surface_render = lambda ctx, result: {"text": result.get("text", "ok"), "source": "mock"}
    try:
        engine._queue_depth = 1
        result = engine.converge("test message")
        # converge() increments then decrements; net should be back to starting value
        assert engine._queue_depth == 1
    finally:
        engine._queue_depth = 0
        engine._executor.shutdown(wait=False)
