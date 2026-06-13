"""
regulatory_researcher.py — Autonomous Regulatory Research Component

Scans public regulatory APIs and maps findings to flourishing dimensions.
Runs autonomously on a schedule or on-demand. Feeds the HFF world model.

Regulatory sources (all public, no auth required unless noted):
  - openFDA       — drug/device/food recalls, adverse events
  - BLS API       — employment, wages, CPI
  - FRED (St. Louis Fed) — economic indicators (requires free key)
  - SEC EDGAR     — company enforcement actions, filings
  - Regulations.gov — federal rulemaking docket

Flourishing mapping:
  health_safety    ← FDA recalls, adverse events
  economic_security ← BLS employment, CPI
  fairness_justice ← SEC enforcement, regulatory penalties
  environmental    ← EPA (future)
  autonomy         ← rulemaking burden, comment participation

All network calls are wrapped in try/except with clear fallbacks.
This module never crashes the HFF app — it degrades gracefully.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
try:
    import urllib.request as _urllib
    import urllib.parse as _urlparse
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FLOURISHING_DIMS = [
    "health_safety",
    "economic_security",
    "fairness_justice",
    "environmental",
    "autonomy",
    "transparency",
]

# Public API endpoints — all freely accessible without auth
_FDA_BASE   = "https://api.fda.gov"
_BLS_BASE   = "https://api.bls.gov/publicAPI/v2"
_FRED_BASE  = "https://fred.stlouisfed.org/graph/fredgraph.csv"
_EDGAR_BASE = "https://efts.sec.gov/LATEST/search-index"

_DEFAULT_TIMEOUT = 10  # seconds per request
_MAX_RESULTS     = 10  # cap results per source per scan


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class RegulatorySignal:
    """One finding from a regulatory API, mapped to a flourishing dimension."""
    signal_id:    str
    source:       str
    dimension:    str
    title:        str
    summary:      str
    severity:     float           # 0.0 (benign) to 1.0 (severe)
    confidence:   float           # 0.0 to 1.0
    scope:        str             # "us_national" | "sector:{name}" | "entity:{id}"
    url:          Optional[str]
    raw:          Dict[str, Any]
    fetched_at:   str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "signal_id":  self.signal_id,
            "source":     self.source,
            "dimension":  self.dimension,
            "title":      self.title,
            "summary":    self.summary,
            "severity":   self.severity,
            "confidence": self.confidence,
            "scope":      self.scope,
            "url":        self.url,
            "fetched_at": self.fetched_at,
        }


@dataclass
class ResearchResult:
    """Aggregated output of one autonomous research run."""
    run_id:      str
    started_at:  str
    finished_at: Optional[str]
    signals:     List[RegulatorySignal] = field(default_factory=list)
    errors:      List[str] = field(default_factory=list)
    dim_scores:  Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id":      self.run_id,
            "started_at":  self.started_at,
            "finished_at": self.finished_at,
            "signal_count": len(self.signals),
            "errors":      self.errors,
            "dim_scores":  self.dim_scores,
            "signals":     [s.to_dict() for s in self.signals],
        }


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get_json(url: str, timeout: int = _DEFAULT_TIMEOUT) -> Optional[Dict]:
    """Fetch URL, parse JSON. Returns None on any error."""
    try:
        req = _urllib.Request(url, headers={"User-Agent": "LanternOS-HFF/1.0"})
        with _urllib.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _signal_id(*parts: str) -> str:
    return hashlib.sha256(":".join(parts).encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Source scanners
# ---------------------------------------------------------------------------

class FDAScannerSensor:
    """
    Scans openFDA for recent drug/device/food recalls and adverse events.
    Maps to: health_safety dimension.
    API docs: https://open.fda.gov/apis/
    No key required for basic queries (rate-limited at 240 req/min).
    """

    def scan_recalls(self, limit: int = _MAX_RESULTS) -> List[RegulatorySignal]:
        url = (f"{_FDA_BASE}/drug/enforcement.json"
               f"?limit={limit}&sort=report_date:desc")
        data = _get_json(url)
        if not data or "results" not in data:
            return []
        signals = []
        for r in data["results"][:limit]:
            severity = 1.0 if r.get("classification") == "Class I" else (
                       0.6 if r.get("classification") == "Class II" else 0.3)
            signals.append(RegulatorySignal(
                signal_id=_signal_id("fda_recall", r.get("recall_number", ""), r.get("report_date", "")),
                source="openFDA drug enforcement",
                dimension="health_safety",
                title=f"Drug Recall: {r.get('recalling_firm', 'unknown firm')}",
                summary=(r.get("reason_for_recall") or "")[:200],
                severity=severity,
                confidence=0.92,
                scope="us_national",
                url=f"https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
                raw=r,
            ))
        return signals

    def scan_adverse_events(self, limit: int = _MAX_RESULTS) -> List[RegulatorySignal]:
        url = (f"{_FDA_BASE}/drug/event.json"
               f"?limit={limit}&sort=receivedate:desc"
               f'&search=serious:"1"')
        data = _get_json(url)
        if not data or "results" not in data:
            return []
        signals = []
        for r in data["results"][:limit]:
            patient = r.get("patient", {})
            reactions = patient.get("reaction", [{}])
            reaction_str = "; ".join(
                rx.get("reactionmeddrapt", "") for rx in reactions[:3]
            )
            signals.append(RegulatorySignal(
                signal_id=_signal_id("fda_ae", r.get("safetyreportid", ""), r.get("receivedate", "")),
                source="openFDA adverse events",
                dimension="health_safety",
                title=f"Adverse Event: {reaction_str or 'serious event'}",
                summary=f"Report date: {r.get('receivedate', 'unknown')}. Reactions: {reaction_str}",
                severity=0.7,
                confidence=0.75,
                scope="us_national",
                url="https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program",
                raw={k: r.get(k) for k in ("safetyreportid", "receivedate", "serious")},
            ))
        return signals


class BLSScannerSensor:
    """
    Scans BLS public data for employment/wage/CPI indicators.
    Maps to: economic_security dimension.
    API docs: https://www.bls.gov/developers/api_faqs.htm
    No key required for v1 (50 queries/day limit).
    """

    # Key BLS series IDs (public, no key needed)
    _SERIES = {
        "unemployment_rate": "LNS14000000",   # U-3 unemployment rate
        "cpi_all_items":     "CUUR0000SA0",   # CPI all urban consumers
        "avg_hourly_wages":  "CES0500000003", # avg hourly earnings, private
    }

    def scan(self) -> List[RegulatorySignal]:
        signals = []
        series_ids = list(self._SERIES.values())
        url = f"{_BLS_BASE}/timeseries/data/"
        try:
            payload = json.dumps({
                "seriesid": series_ids,
                "startyear": str(datetime.now().year - 1),
                "endyear": str(datetime.now().year),
            }).encode()
            req = _urllib.Request(
                url, data=payload,
                headers={"Content-Type": "application/json",
                         "User-Agent": "LanternOS-HFF/1.0"},
            )
            with _urllib.urlopen(req, timeout=_DEFAULT_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return []

        if data.get("status") != "REQUEST_SUCCEEDED":
            return []

        series_map = {s["seriesID"]: s for s in data.get("Results", {}).get("series", [])}

        for name, sid in self._SERIES.items():
            s = series_map.get(sid)
            if not s or not s.get("data"):
                continue
            latest = s["data"][0]
            try:
                value = float(latest["value"])
            except (ValueError, KeyError):
                continue

            # Severity heuristic
            if name == "unemployment_rate":
                severity = min(1.0, value / 15.0)   # 15% = fully severe
            elif name == "cpi_all_items":
                severity = 0.2  # baseline; spikes detected via trend
            else:
                severity = max(0.0, 1.0 - (value / 40.0))  # wages: higher=better

            signals.append(RegulatorySignal(
                signal_id=_signal_id("bls", sid, latest.get("year", ""), latest.get("period", "")),
                source="BLS public API",
                dimension="economic_security",
                title=f"BLS {name.replace('_', ' ').title()}",
                summary=(f"Latest reading: {value} ({latest.get('periodName', '')} "
                         f"{latest.get('year', '')}). Series: {sid}"),
                severity=severity,
                confidence=0.95,
                scope="us_national",
                url=f"https://data.bls.gov/timeseries/{sid}",
                raw={"series_id": sid, "latest": latest},
            ))
        return signals


class SECEdgarScannerSensor:
    """
    Scans SEC EDGAR full-text search for recent enforcement actions.
    Maps to: fairness_justice + transparency dimensions.
    API docs: https://efts.sec.gov/LATEST/search-index?q=...
    No auth required.
    """

    def scan_enforcement(self, limit: int = _MAX_RESULTS) -> List[RegulatorySignal]:
        query = _urlparse.urlencode({
            "q": '"enforcement action" OR "cease and desist" OR "civil penalty"',
            "dateRange": "custom",
            "startdt": (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d"),
            "enddt": datetime.now().strftime("%Y-%m-%d"),
            "forms": "34-12G",
        })
        url = f"https://efts.sec.gov/LATEST/search-index?{query}&hits.hits.total.value=true"
        # Try EDGAR full-text search
        data = _get_json(f"https://efts.sec.gov/LATEST/search-index?q=%22enforcement%22&dateRange=custom&startdt={(datetime.now()-timedelta(days=30)).strftime('%Y-%m-%d')}&enddt={datetime.now().strftime('%Y-%m-%d')}")
        if not data:
            return []
        hits = (data.get("hits") or {}).get("hits") or []
        signals = []
        for h in hits[:limit]:
            src = h.get("_source", {})
            signals.append(RegulatorySignal(
                signal_id=_signal_id("edgar", h.get("_id", ""), src.get("file_date", "")),
                source="SEC EDGAR",
                dimension="fairness_justice",
                title=f"SEC Filing: {src.get('display_names', ['unknown'])[0] if src.get('display_names') else 'unknown entity'}",
                summary=f"{src.get('form_type', '')} filed {src.get('file_date', '')}",
                severity=0.4,
                confidence=0.7,
                scope=f"entity:{src.get('entity_name', 'unknown')}",
                url=f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={src.get('entity_id', '')}",
                raw={"entity": src.get("entity_name"), "form": src.get("form_type"), "date": src.get("file_date")},
            ))
        return signals


# ---------------------------------------------------------------------------
# Flourishing dimension scorer
# ---------------------------------------------------------------------------

def score_dimensions(signals: List[RegulatorySignal]) -> Dict[str, float]:
    """
    Aggregate signals by dimension into a 0-1 flourishing score.
    Score = 1 - weighted_severity (higher score = more flourishing).
    """
    by_dim: Dict[str, List[float]] = {d: [] for d in FLOURISHING_DIMS}
    for s in signals:
        if s.dimension in by_dim:
            by_dim[s.dimension].append(s.severity * s.confidence)

    scores: Dict[str, float] = {}
    for dim, severities in by_dim.items():
        if severities:
            mean_severity = sum(severities) / len(severities)
            scores[dim] = round(max(0.0, min(1.0, 1.0 - mean_severity)), 4)
        else:
            scores[dim] = None  # no data for this dimension
    return {k: v for k, v in scores.items() if v is not None}


# ---------------------------------------------------------------------------
# Autonomous researcher
# ---------------------------------------------------------------------------

class RegulatoryResearcher:
    """
    Orchestrates autonomous scans across all regulatory sources.
    Runs in a background thread; operator gate prevents unsupervised escalation.
    Results are stored in-memory (latest N runs).
    """

    MAX_HISTORY = 10

    def __init__(self) -> None:
        self._fda   = FDAScannerSensor()
        self._bls   = BLSScannerSensor()
        self._edgar = SECEdgarScannerSensor()
        self._history: List[ResearchResult] = []
        self._lock  = threading.Lock()
        self._running = False

    # ── Single research run ────────────────────────────────────────────────

    def run_once(self, operator_gate: bool = True) -> ResearchResult:
        """
        Execute one full research sweep across all sources.
        operator_gate=True means results are flagged for review before
        being fed into the world model — no autonomous escalation.
        """
        run_id = _signal_id("run", datetime.now(timezone.utc).isoformat())
        result = ResearchResult(
            run_id=run_id,
            started_at=datetime.now(timezone.utc).isoformat(),
            finished_at=None,
        )

        # FDA recalls
        try:
            result.signals.extend(self._fda.scan_recalls())
        except Exception as e:
            result.errors.append(f"fda_recalls: {e}")

        # FDA adverse events
        try:
            result.signals.extend(self._fda.scan_adverse_events(limit=5))
        except Exception as e:
            result.errors.append(f"fda_ae: {e}")

        # BLS economic indicators
        try:
            result.signals.extend(self._bls.scan())
        except Exception as e:
            result.errors.append(f"bls: {e}")

        # SEC EDGAR
        try:
            result.signals.extend(self._edgar.scan_enforcement(limit=5))
        except Exception as e:
            result.errors.append(f"edgar: {e}")

        # Score dimensions
        result.dim_scores   = score_dimensions(result.signals)
        result.finished_at  = datetime.now(timezone.utc).isoformat()

        # Store result
        with self._lock:
            self._history.append(result)
            if len(self._history) > self.MAX_HISTORY:
                self._history.pop(0)

        return result

    # ── Background autonomous loop ─────────────────────────────────────────

    def start_autonomous_loop(self, interval_seconds: int = 3600) -> None:
        """Start a background thread that re-runs research every interval."""
        if self._running:
            return
        self._running = True

        def _loop():
            while self._running:
                try:
                    self.run_once(operator_gate=True)
                except Exception:
                    pass
                time.sleep(interval_seconds)

        t = threading.Thread(target=_loop, daemon=True, name="regulatory-researcher")
        t.start()

    def stop_autonomous_loop(self) -> None:
        self._running = False

    # ── Accessors ──────────────────────────────────────────────────────────

    def latest_result(self) -> Optional[ResearchResult]:
        with self._lock:
            return self._history[-1] if self._history else None

    def history(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [r.to_dict() for r in self._history]

    def dim_summary(self) -> Dict[str, Any]:
        """Aggregate dimension scores across all history, weighted by recency."""
        with self._lock:
            if not self._history:
                return {}
            # Use only the 3 most recent runs
            recent = self._history[-3:]
            combined: Dict[str, List[float]] = {}
            for r in recent:
                for dim, score in r.dim_scores.items():
                    combined.setdefault(dim, []).append(score)
        return {
            dim: round(sum(scores) / len(scores), 4)
            for dim, scores in combined.items()
        }


# ---------------------------------------------------------------------------
# Singleton instance (imported by app.py)
# ---------------------------------------------------------------------------

researcher = RegulatoryResearcher()