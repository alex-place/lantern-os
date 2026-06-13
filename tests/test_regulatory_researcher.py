"""
test_regulatory_researcher.py — Autonomous Regulatory Research component tests

Tests RegulatorySignal shape, score_dimensions(), RegulatoryResearcher,
and the HTTP API routes (mocked — no real network calls).
"""

import sys, json, time
from pathlib import Path
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

import pytest
from regulatory_researcher import (
    RegulatorySignal, ResearchResult, RegulatoryResearcher,
    FDAScannerSensor, BLSScannerSensor, SECEdgarScannerSensor,
    score_dimensions, FLOURISHING_DIMS, _signal_id,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_signal(dim="health_safety", severity=0.5, confidence=0.9, source="test"):
    return RegulatorySignal(
        signal_id=_signal_id("test", dim, str(severity)),
        source=source,
        dimension=dim,
        title=f"Test signal {dim}",
        summary="Test summary",
        severity=severity,
        confidence=confidence,
        scope="us_national",
        url=None,
        raw={},
    )


FDA_RECALL_RESPONSE = {
    "results": [
        {
            "recall_number": "D-001-2026",
            "classification": "Class I",
            "recalling_firm": "ACME Pharma",
            "reason_for_recall": "Contamination with foreign material",
            "report_date": "20260601",
        },
        {
            "recall_number": "D-002-2026",
            "classification": "Class II",
            "recalling_firm": "Healthco",
            "reason_for_recall": "Labeling error",
            "report_date": "20260602",
        },
    ]
}

BLS_RESPONSE = {
    "status": "REQUEST_SUCCEEDED",
    "Results": {
        "series": [
            {
                "seriesID": "LNS14000000",
                "data": [{"year": "2026", "period": "M05", "periodName": "May", "value": "4.1"}]
            }
        ]
    }
}


# ---------------------------------------------------------------------------
# RegulatorySignal
# ---------------------------------------------------------------------------

class TestRegulatorySignal:
    def test_to_dict_has_required_keys(self):
        s = make_signal()
        d = s.to_dict()
        for k in ("signal_id", "source", "dimension", "title", "summary",
                  "severity", "confidence", "scope", "url", "fetched_at"):
            assert k in d, f"missing key {k}"

    def test_severity_in_range(self):
        s = make_signal(severity=0.7)
        assert 0.0 <= s.severity <= 1.0

    def test_confidence_in_range(self):
        s = make_signal(confidence=0.85)
        assert 0.0 <= s.confidence <= 1.0

    def test_signal_id_is_deterministic(self):
        a = _signal_id("fda", "recall-001", "20260101")
        b = _signal_id("fda", "recall-001", "20260101")
        assert a == b

    def test_signal_id_differs_for_different_inputs(self):
        a = _signal_id("fda", "recall-001")
        b = _signal_id("fda", "recall-002")
        assert a != b


# ---------------------------------------------------------------------------
# score_dimensions
# ---------------------------------------------------------------------------

class TestScoreDimensions:
    def test_empty_signals_returns_empty(self):
        assert score_dimensions([]) == {}

    def test_single_signal_high_severity_gives_low_score(self):
        signals = [make_signal(dim="health_safety", severity=0.9, confidence=1.0)]
        scores = score_dimensions(signals)
        assert "health_safety" in scores
        assert scores["health_safety"] < 0.2

    def test_single_signal_low_severity_gives_high_score(self):
        signals = [make_signal(dim="health_safety", severity=0.1, confidence=1.0)]
        scores = score_dimensions(signals)
        assert scores["health_safety"] > 0.8

    def test_multiple_dimensions(self):
        signals = [
            make_signal("health_safety",    severity=0.5),
            make_signal("economic_security", severity=0.3),
        ]
        scores = score_dimensions(signals)
        assert "health_safety"    in scores
        assert "economic_security" in scores

    def test_only_known_dimensions_included(self):
        signals = [make_signal("unknown_dim", severity=0.5)]
        scores = score_dimensions(signals)
        assert "unknown_dim" not in scores

    def test_scores_in_range(self):
        signals = [make_signal(severity=s) for s in (0.0, 0.5, 1.0)]
        scores = score_dimensions(signals)
        for v in scores.values():
            assert 0.0 <= v <= 1.0

    def test_confidence_weighs_severity(self):
        low_conf  = [make_signal(severity=1.0, confidence=0.1)]
        high_conf = [make_signal(severity=1.0, confidence=1.0)]
        lo_score = score_dimensions(low_conf)["health_safety"]
        hi_score = score_dimensions(high_conf)["health_safety"]
        assert lo_score > hi_score  # low confidence = lower impact = higher flourishing


# ---------------------------------------------------------------------------
# FDAScannerSensor (mocked)
# ---------------------------------------------------------------------------

class TestFDAScannerSensor:
    def test_scan_recalls_returns_signals(self):
        sensor = FDAScannerSensor()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE):
            signals = sensor.scan_recalls(limit=5)
        assert len(signals) == 2
        assert all(s.dimension == "health_safety" for s in signals)

    def test_class_i_recall_has_high_severity(self):
        sensor = FDAScannerSensor()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE):
            signals = sensor.scan_recalls()
        class_i = next(s for s in signals if "ACME" in s.title)
        assert class_i.severity == 1.0

    def test_class_ii_recall_has_medium_severity(self):
        sensor = FDAScannerSensor()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE):
            signals = sensor.scan_recalls()
        class_ii = next(s for s in signals if "Healthco" in s.title)
        assert class_ii.severity == 0.6

    def test_returns_empty_on_network_failure(self):
        sensor = FDAScannerSensor()
        with patch("regulatory_researcher._get_json", return_value=None):
            signals = sensor.scan_recalls()
        assert signals == []

    def test_signal_source_is_openfda(self):
        sensor = FDAScannerSensor()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE):
            signals = sensor.scan_recalls()
        assert all("openFDA" in s.source for s in signals)


# ---------------------------------------------------------------------------
# BLSScannerSensor (mocked)
# ---------------------------------------------------------------------------

class TestBLSScannerSensor:
    def test_scan_returns_signals(self):
        sensor = BLSScannerSensor()
        import urllib.request
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(BLS_RESPONSE).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__  = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            signals = sensor.scan()
        assert len(signals) >= 1
        assert all(s.dimension == "economic_security" for s in signals)

    def test_returns_empty_on_failure(self):
        sensor = BLSScannerSensor()
        with patch("urllib.request.urlopen", side_effect=Exception("timeout")):
            signals = sensor.scan()
        assert signals == []

    def test_signal_has_bls_source(self):
        sensor = BLSScannerSensor()
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(BLS_RESPONSE).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__  = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            signals = sensor.scan()
        assert all("BLS" in s.source for s in signals)


# ---------------------------------------------------------------------------
# RegulatoryResearcher (with mocked sensors)
# ---------------------------------------------------------------------------

class TestRegulatoryResearcher:
    def _patched(self):
        """Return a researcher with all sensors returning test signals."""
        r = RegulatoryResearcher()
        r._fda._get_recalls   = lambda: [make_signal("health_safety", 0.4)]
        r._bls._get_scan      = lambda: [make_signal("economic_security", 0.2)]
        return r

    def test_run_once_returns_result(self):
        r = RegulatoryResearcher()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            result = r.run_once()
        assert isinstance(result, ResearchResult)
        assert result.finished_at is not None
        assert result.run_id is not None

    def test_run_once_stores_in_history(self):
        r = RegulatoryResearcher()
        with patch("regulatory_researcher._get_json", return_value=None), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            r.run_once()
        assert len(r._history) == 1

    def test_history_capped_at_max(self):
        r = RegulatoryResearcher()
        r.MAX_HISTORY = 3
        with patch("regulatory_researcher._get_json", return_value=None), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            for _ in range(5):
                r.run_once()
        assert len(r._history) <= 3

    def test_latest_result_is_last_run(self):
        r = RegulatoryResearcher()
        with patch("regulatory_researcher._get_json", return_value=None), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            result = r.run_once()
        assert r.latest_result() is result

    def test_errors_recorded_on_network_failure(self):
        r = RegulatoryResearcher()
        with patch("regulatory_researcher._get_json", return_value=None), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            result = r.run_once()
        assert isinstance(result.errors, list)

    def test_dim_scores_populated_when_signals_found(self):
        r = RegulatoryResearcher()
        with patch("regulatory_researcher._get_json", return_value=FDA_RECALL_RESPONSE), \
             patch("urllib.request.urlopen", side_effect=Exception("offline")):
            result = r.run_once()
        if result.signals:
            assert "health_safety" in result.dim_scores

    def test_dim_summary_empty_on_no_history(self):
        r = RegulatoryResearcher()
        assert r.dim_summary() == {}

    def test_dim_summary_aggregates_recent_runs(self):
        r = RegulatoryResearcher()
        # Inject pre-built result with known scores
        from regulatory_researcher import ResearchResult
        fake = ResearchResult(run_id="x", started_at="t", finished_at="t",
                              dim_scores={"health_safety": 0.6})
        r._history.append(fake)
        summary = r.dim_summary()
        assert "health_safety" in summary
        assert abs(summary["health_safety"] - 0.6) < 0.01

    def test_autonomous_loop_starts_and_stops(self):
        r = RegulatoryResearcher()
        r.start_autonomous_loop(interval_seconds=9999)
        assert r._running
        r.stop_autonomous_loop()
        assert not r._running

    def test_start_loop_idempotent(self):
        r = RegulatoryResearcher()
        r.start_autonomous_loop(interval_seconds=9999)
        r.start_autonomous_loop(interval_seconds=9999)  # second call is no-op
        r.stop_autonomous_loop()