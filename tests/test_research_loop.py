"""Tests for the Research Convergence Loop (src/convergence/research.py).

Verifies the six-stage loop applied to research, fully offline (fake searcher):
- Observe + Remember: web results persisted as evidence memories
- Reason: candidate claims grounded in evidence
- Verify: External Reality Rule — any single external source marks a claim "supported"
  (confidence 0.45); cross-source corroboration raises confidence (2→0.65, 3→0.85)
- Converge: a cited report + persisted convergence records
- ResearchProgram: durable JSONL queue drained continuously
"""

import json

import pytest

from src.convergence.research import (
    ResearchLoop,
    ResearchProgram,
    duckduckgo_search,
    web_search,
    heuristic_reasoner,
    _jaccard,
    _overlap,
    _tokenize,
    _domain,
)


# Two sources corroborate the photosynthesis claim (distinct domains a.com + b.org);
# the mitochondria claim appears on a single domain (c.net) only.
_FAKE_RESULTS = [
    {
        "title": "Photosynthesis — Biology",
        "url": "https://a.com/photosynthesis",
        "snippet": "Photosynthesis converts sunlight into chemical energy in plants.",
    },
    {
        "title": "How plants make food",
        "url": "https://b.org/plants",
        "snippet": "Photosynthesis converts sunlight into chemical energy stored in plants.",
    },
    {
        "title": "Cell biology basics",
        "url": "https://c.net/cell",
        "snippet": "The mitochondria is the powerhouse of the cell.",
    },
]


def fake_searcher(query, max_results=5):
    # Same evidence regardless of sub-query; the loop dedupes by URL.
    return [dict(r) for r in _FAKE_RESULTS][:max_results]


def empty_searcher(query, max_results=5):
    return []


# ───────────────────────────── searcher hardening ─────────────────────────────

def test_searcher_retries_on_empty(monkeypatch):
    # DuckDuckGo soft-throttle returns an empty page; the searcher should retry and
    # rotate the User-Agent until it gets results.
    import src.convergence.research as rm
    calls = {"n": 0, "uas": []}

    def fake_fetch(query, max_results, ua):
        calls["n"] += 1
        calls["uas"].append(ua)
        if calls["n"] < 3:
            return []
        return [{"rank": 1, "title": "t", "url": "https://x.com/a", "snippet": "s"}]

    monkeypatch.setattr(rm, "_ddg_fetch", fake_fetch)
    out = rm.duckduckgo_search("q", max_results=5, retries=3, _sleep=lambda s: None)
    assert calls["n"] == 3
    assert out and out[0]["url"] == "https://x.com/a"
    assert len(set(calls["uas"])) >= 2  # rotated the User-Agent


def test_searcher_gives_up_after_retries(monkeypatch):
    import src.convergence.research as rm
    calls = {"n": 0}

    def always_empty(query, max_results, ua):
        calls["n"] += 1
        return []

    monkeypatch.setattr(rm, "_ddg_fetch", always_empty)
    out = rm.duckduckgo_search("q", retries=3, _sleep=lambda s: None)
    assert out == []
    assert calls["n"] == 3


def _clear_search_keys(monkeypatch):
    for k in ("BRAVE_SEARCH_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"):
        monkeypatch.delenv(k, raising=False)


def test_web_search_prefers_keyed_provider(monkeypatch):
    import src.convergence.research as rm
    _clear_search_keys(monkeypatch)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "k")
    monkeypatch.setattr(rm, "_brave_search",
                        lambda q, n, key: [{"rank": 1, "title": "b", "url": "https://brave.example", "snippet": "s"}])
    monkeypatch.setattr(rm, "duckduckgo_search", lambda q, n=5: [{"rank": 1, "url": "https://ddg.example"}])
    out = rm.web_search("q", 5)
    assert out[0]["url"] == "https://brave.example"  # keyed provider wins


def test_web_search_falls_back_to_ddg_without_key(monkeypatch):
    import src.convergence.research as rm
    _clear_search_keys(monkeypatch)
    monkeypatch.setattr(rm, "duckduckgo_search",
                        lambda q, n=5: [{"rank": 1, "title": "d", "url": "https://ddg.example", "snippet": "s"}])
    out = rm.web_search("q", 5)
    assert out[0]["url"] == "https://ddg.example"


def test_web_search_skips_failing_provider(monkeypatch):
    # keyed provider configured but erroring/empty → fall back to DDG, no crash
    import src.convergence.research as rm
    _clear_search_keys(monkeypatch)
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "k")
    def boom(q, n, key): raise RuntimeError("provider down")
    monkeypatch.setattr(rm, "_brave_search", boom)
    monkeypatch.setattr(rm, "duckduckgo_search", lambda q, n=5: [{"rank": 1, "url": "https://ddg.example"}])
    out = rm.web_search("q", 5)
    assert out[0]["url"] == "https://ddg.example"


# ───────────────────────────── text utilities ─────────────────────────────

def test_domain_strips_www():
    assert _domain("https://www.example.com/path") == "example.com"
    assert _domain("https://sub.example.org") == "sub.example.org"


def test_jaccard_clusters_near_duplicates():
    a = _tokenize("Photosynthesis converts sunlight into chemical energy in plants")
    b = _tokenize("Photosynthesis converts sunlight into chemical energy stored in plants")
    c = _tokenize("The mitochondria is the powerhouse of the cell")
    assert _jaccard(a, b) >= 0.5
    assert _jaccard(a, c) < 0.5


def test_overlap_contains_shorter_claim():
    a = _tokenize("Photosynthesis converts sunlight into chemical energy in plants")
    b = _tokenize("Photosynthesis converts sunlight into chemical energy stored in plants")
    c = _tokenize("The mitochondria is the powerhouse of the cell")
    assert _overlap(a, b) >= 0.45
    assert _overlap(a, c) < 0.45


# ───────────────────────────── the loop ─────────────────────────────

def test_loop_observe_and_remember(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path, min_sources=2)
    report = loop.run("How does photosynthesis work?")
    # Three distinct URLs → three evidence memories / sources.
    assert len(report.sources) == 3
    assert (tmp_path / "memory.jsonl").exists()
    mem_lines = (tmp_path / "memory.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(mem_lines) >= 3


def test_external_reality_rule_corroboration(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path, min_sources=2)
    report = loop.run("How does photosynthesis work?")

    supported = report.supported
    unsupported = report.unsupported
    assert len(supported) >= 1, "the two-source photosynthesis claim must be supported"

    sup = supported[0]
    assert "photosynthesis" in sup.text.lower()
    assert len(sup.domains) >= 2, "supported claim must cite >= 2 independent domains"
    assert len(sup.source_indices) >= 2

    # The single-source mitochondria claim must NOT clear the rule.
    assert any("mitochondria" in c.text.lower() for c in unsupported)

    # Corroborated confidence strictly exceeds any single-source confidence.
    if unsupported:
        assert sup.confidence > max(c.confidence for c in unsupported)


def test_records_persisted_and_cited(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path, min_sources=2)
    report = loop.run("How does photosynthesis work?")

    # Convergence records persisted with evidence + confidence + verification.
    records_path = tmp_path / "convergence-records.jsonl"
    assert records_path.exists()
    records = [json.loads(l) for l in records_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert records, "at least one convergence record must be written"
    for rec in records:
        assert rec["verified"] is True
        assert "evidence_ids" in rec
        assert 0.0 <= rec["confidence"] <= 1.0

    # The markdown report is cited (URLs + numbered sources).
    md = report.to_markdown()
    assert "https://a.com/photosynthesis" in md
    assert "## Sources" in md
    assert "[1]" in md

    # Structured form carries [claim, evidence, confidence, source].
    d = report.to_dict()
    assert d["supported_claims"]
    first = d["supported_claims"][0]
    assert "confidence" in first and "source_indices" in first and "text" in first


def test_report_files_written(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path, min_sources=2)
    loop.run("How does photosynthesis work?")
    reports = list((tmp_path / "reports").glob("*.md"))
    jsons = list((tmp_path / "reports").glob("*.json"))
    assert len(reports) == 1
    assert len(jsons) == 1


def test_graceful_degradation_no_results(tmp_path):
    loop = ResearchLoop(searcher=empty_searcher, data_dir=tmp_path, min_sources=2)
    report = loop.run("a question with no answers online")
    assert report.sources == []
    assert report.supported == []
    md = report.to_markdown()
    assert "No claim cleared the External Reality Rule" in md


def test_plan_sub_queries_includes_question():
    queries = ResearchLoop.plan_sub_queries("What is RAG?")
    assert "What is RAG?" in queries
    assert len(queries) <= 3


def test_empty_question_rejected(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path)
    with pytest.raises(ValueError):
        loop.run("   ")


# ───────────────────────────── continuous program ─────────────────────────────

def test_program_queue_drains_continuously(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path, min_sources=2)
    program = ResearchProgram(loop=loop, queue_path=tmp_path / "queue.jsonl")

    program.enqueue("How does photosynthesis work?", priority="high")
    program.enqueue("What powers the cell?", priority="low")
    assert len(program.pending()) == 2

    results = program.run_continuous()
    assert len(results) == 2
    assert program.pending() == []

    status = program.status()
    assert status["by_status"].get("completed") == 2


def test_program_queue_survives_reinstantiation(tmp_path):
    qp = tmp_path / "queue.jsonl"
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path)
    p1 = ResearchProgram(loop=loop, queue_path=qp)
    p1.enqueue("durable question?")

    # New program instance reads the same on-disk queue.
    p2 = ResearchProgram(loop=ResearchLoop(searcher=fake_searcher, data_dir=tmp_path), queue_path=qp)
    assert len(p2.pending()) == 1
    out = p2.run_next()
    assert out is not None
    assert p2.pending() == []


def test_heuristic_reasoner_skips_thin_snippets(tmp_path):
    loop = ResearchLoop(searcher=fake_searcher, data_dir=tmp_path)
    report = loop.run("photosynthesis")
    # Reasoner should yield claims from substantive snippets.
    claims = heuristic_reasoner("photosynthesis", list(loop.kernel.memory.values()))
    assert all(len(_tokenize(c["text"])) >= 3 for c in claims)


# ───────────────────────────── CLI ─────────────────────────────

def _patch_searcher(monkeypatch):
    import src.convergence.research as research_mod
    monkeypatch.setattr(research_mod, "duckduckgo_search", fake_searcher)


def test_cli_status_on_empty_queue(tmp_path, capsys):
    from src.convergence.research import main
    assert main(["--data-dir", str(tmp_path), "status"]) == 0
    out = capsys.readouterr().out
    assert '"queue_depth": 0' in out


def test_cli_enqueue_pending_and_drain(tmp_path, monkeypatch, capsys):
    _patch_searcher(monkeypatch)
    from src.convergence.research import main
    dd = str(tmp_path)

    assert main(["--data-dir", dd, "enqueue", "How", "does", "photosynthesis", "work?"]) == 0
    assert main(["--data-dir", dd, "enqueue", "--priority", "high", "What", "powers", "the", "cell?"]) == 0
    capsys.readouterr()

    assert main(["--data-dir", dd, "pending"]) == 0
    pending_out = capsys.readouterr().out
    assert pending_out.count("\n") == 2  # two pending tasks listed

    assert main(["--data-dir", dd, "drain"]) == 0
    drain_out = capsys.readouterr().out
    assert "drained 2 task(s)" in drain_out

    # Queue is now empty.
    assert main(["--data-dir", dd, "drain"]) == 0
    assert "nothing to drain" in capsys.readouterr().out


def test_cli_next_runs_one(tmp_path, monkeypatch, capsys):
    _patch_searcher(monkeypatch)
    from src.convergence.research import main
    dd = str(tmp_path)
    main(["--data-dir", dd, "enqueue", "a", "question", "to", "research?"])
    capsys.readouterr()
    assert main(["--data-dir", dd, "next"]) == 0
    assert "corroborated claim(s)" in capsys.readouterr().out
    # Nothing left.
    assert main(["--data-dir", dd, "next"]) == 0
    assert "queue empty" in capsys.readouterr().out


def test_cli_run_oneshot_json(tmp_path, monkeypatch, capsys):
    _patch_searcher(monkeypatch)
    from src.convergence.research import main
    assert main(["--data-dir", str(tmp_path), "run", "--json", "photosynthesis", "process"]) == 0
    out = capsys.readouterr().out
    assert '"question":' in out and '"sources":' in out


def test_cli_no_command_prints_help(tmp_path, capsys):
    from src.convergence.research import main
    assert main(["--data-dir", str(tmp_path)]) == 0
    assert "Research Convergence Loop" in capsys.readouterr().out


# ── dilation → external-grounding depth (the within→without bridge, #764) ───────

def test_research_dilation_scales_grounding(tmp_path):
    """Higher dilation widens web breadth (max_results) and raises the corroboration
    floor (min_sources) via convergence_io.grounding_policy."""
    seen = {}

    def recording_searcher(query, max_results=5):
        seen["max_results"] = max_results       # same per run; last call wins
        return [dict(r) for r in _FAKE_RESULTS][:max_results]

    loop = ResearchLoop(searcher=recording_searcher, data_dir=tmp_path, min_sources=2)
    rep_lo = loop.run("how does photosynthesis work?", dilation=0.4)
    lo_mr, lo_ms = seen["max_results"], rep_lo.min_sources
    rep_hi = loop.run("how does photosynthesis work?", dilation=4.0)
    hi_mr, hi_ms = seen["max_results"], rep_hi.min_sources

    assert hi_mr > lo_mr                          # high dilation → wider web breadth
    assert hi_ms >= lo_ms                         # ...and a higher corroboration floor
    assert hi_ms >= 3                             # D≥3 → base(2)+1
    rep_none = loop.run("how does photosynthesis work?")
    assert rep_none.min_sources == 2             # no dilation → unchanged defaults
