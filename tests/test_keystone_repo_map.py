"""Tests for the symbol-graph repo-map (src/keystone/repo_map.py, #1409/#1413)."""

import pytest

from keystone.repo_map import (
    FileEntry,
    build_repo_map,
    extract_symbols,
    pagerank,
    render_repo_map,
)

pytestmark = pytest.mark.synthetic


def test_extract_symbols_python():
    text = "import os\n\ndef alpha():\n    return beta()\n\nclass Gamma:\n    pass\n"
    defined, referenced = extract_symbols(text, ".py")
    assert defined == {"alpha", "Gamma"}
    # references include called names but exclude keywords/short tokens
    assert "beta" in referenced
    assert "return" not in referenced
    assert "os" not in referenced  # len < 3 stoplist? os is len 2 -> excluded


def test_extract_symbols_js():
    text = "export function doThing(x) { return helper(x); }\nconst Widget = 1;\n"
    defined, referenced = extract_symbols(text, ".ts")
    assert "doThing" in defined
    assert "Widget" in defined
    assert "helper" in referenced


def test_js_local_vars_are_not_captured_as_defs():
    # Local const/let/var inside a function body must NOT be treated as defs —
    # that was the v1 noise bug. Only top-level / exported declarations count.
    text = (
        "export function handler() {\n"
        "  const data = load();\n"      # local -> ignored
        "  let entry = data[0];\n"        # local -> ignored
        "  return entry;\n"
        "}\n"
        "const TOP_LEVEL = 1;\n"          # column 0 -> captured
        "export const Widget = 2;\n"      # exported -> captured
    )
    defined, _ = extract_symbols(text, ".js")
    assert "handler" in defined
    assert "TOP_LEVEL" in defined
    assert "Widget" in defined
    assert "data" not in defined
    assert "entry" not in defined


def test_idf_downweights_ambiguous_symbols():
    # A symbol defined in many files yields weaker edges than a unique one.
    nodes = ["caller", "a", "b", "uniq"]
    # `caller` references a symbol defined by both a and b (ambiguous) plus one
    # defined only by uniq. With IDF weighting uniq should out-rank a and b.
    edges = {
        "caller": {"a": 0.5, "b": 0.5, "uniq": 1.0},
        "a": {}, "b": {}, "uniq": {},
    }
    ranks = pagerank(nodes, edges)
    assert ranks["uniq"] > ranks["a"]
    assert ranks["uniq"] > ranks["b"]


def test_pagerank_sums_to_one_and_rewards_inbound():
    nodes = ["a", "b", "c"]
    # a and b both point at c; c points nowhere
    edges = {"a": {"c": 1.0}, "b": {"c": 1.0}, "c": {}}
    ranks = pagerank(nodes, edges)
    assert abs(sum(ranks.values()) - 1.0) < 1e-6
    assert ranks["c"] > ranks["a"]
    assert ranks["c"] > ranks["b"]


def test_pagerank_empty():
    assert pagerank([], {}) == {}


def _make_repo(tmp_path):
    # util.py is referenced by two callers -> should rank highest.
    (tmp_path / "util.py").write_text(
        "def shared_helper():\n    return 1\n\nclass Core:\n    pass\n",
        encoding="utf-8",
    )
    (tmp_path / "alpha.py").write_text(
        "def run_alpha():\n    return shared_helper() + Core().x\n", encoding="utf-8"
    )
    (tmp_path / "beta.py").write_text(
        "def run_beta():\n    return shared_helper()\n", encoding="utf-8"
    )
    return tmp_path


def test_build_repo_map_ranks_load_bearing_file_first(tmp_path):
    root = str(_make_repo(tmp_path))
    entries = build_repo_map(root)
    assert entries, "expected at least one ranked file"
    assert isinstance(entries[0], FileEntry)
    paths = [e.path for e in entries]
    assert set(paths) == {"util.py", "alpha.py", "beta.py"}
    # util.py defines symbols both other files reference -> top rank.
    assert paths[0] == "util.py"
    util = next(e for e in entries if e.path == "util.py")
    assert util.defined == ["Core", "shared_helper"]


def test_build_repo_map_respects_max_files(tmp_path):
    root = str(_make_repo(tmp_path))
    entries = build_repo_map(root, max_files=1)
    assert len(entries) == 1
    assert entries[0].path == "util.py"


def test_focus_files_personalizes_ranking(tmp_path):
    root = str(_make_repo(tmp_path))
    # Focusing on beta.py (which references shared_helper) should still surface
    # util.py (its definer) at the top, with a focus bonus applied.
    entries = build_repo_map(root, focus_files=["beta.py"])
    assert entries[0].path == "util.py"
    assert entries[0].score > 0


def test_skip_dirs_excludes_vendored(tmp_path):
    _make_repo(tmp_path)
    vend = tmp_path / "node_modules"
    vend.mkdir()
    (vend / "lib.py").write_text("def vendored():\n    pass\n", encoding="utf-8")
    entries = build_repo_map(str(tmp_path))
    assert all("node_modules" not in e.path for e in entries)


def test_render_repo_map_compact(tmp_path):
    root = str(_make_repo(tmp_path))
    out = render_repo_map(build_repo_map(root))
    assert "util.py" in out
    assert "shared_helper" in out
