"""Tests for csf.coder_grounding — omni round-trip + TF-IDF retrieve relevance."""
import json
import pathlib
import tempfile

import pytest

from csf import coder_grounding


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_KC_RECORDS = [
    {
        "id": "convergence-loop",
        "path": "docs/CONVERGANCE-SIGMA0-BRIEFING.md#loop",
        "heading": "The Convergence Loop",
        "text": "Observe Remember Reason Act Verify Converge — every feature must strengthen one stage of this loop.",
        "doc": "CONVERGANCE-SIGMA0-BRIEFING.md",
    },
    {
        "id": "csf-format",
        "path": "docs/CSF-FORMAT-SPECIFICATION.md#omni",
        "heading": "Omni codec best-fit compression",
        "text": "The omni codec runs the whole panel brotli zstd lzma bz2 zlib per blob and picks the smallest.",
        "doc": "CSF-FORMAT-SPECIFICATION.md",
    },
    {
        "id": "grounding-gate",
        "path": "docs/SIGMA0-OURO-CODER.md#gate",
        "heading": "Grounding gate for the Ouro coder",
        "text": "sigma0_coder_gate lifts the ungrounded confidence ceiling and injects evidence into the system surface.",
        "doc": "SIGMA0-OURO-CODER.md",
    },
]


@pytest.fixture()
def tmp_grounding(tmp_path, monkeypatch):
    """Redirect KB_INDEX and GROUNDING_CSF to temp paths, write synthetic records."""
    idx = tmp_path / "knowledge" / "index.jsonl"
    idx.parent.mkdir(parents=True)
    idx.write_text("\n".join(json.dumps(r) for r in _KC_RECORDS) + "\n")

    csf_out = tmp_path / "csf" / "coder-grounding.csf"

    monkeypatch.setattr(coder_grounding, "KB_INDEX", idx)
    monkeypatch.setattr(coder_grounding, "GROUNDING_CSF", csf_out)
    monkeypatch.setattr(coder_grounding, "_cache", None)

    return {"idx": idx, "csf": csf_out, "tmp": tmp_path}


# ---------------------------------------------------------------------------
# Build: omni round-trip
# ---------------------------------------------------------------------------

def test_build_creates_archive(tmp_grounding):
    g = tmp_grounding
    result = coder_grounding.build(out_path=g["csf"])

    assert g["csf"].exists(), "archive file must exist after build()"
    assert result["records"] == len(_KC_RECORDS)
    assert result["ratio"] > 1.0, "omni archive should compress synthetic JSON"
    assert result["codec"] == "omni"


def test_build_archive_integrity(tmp_grounding):
    """CSF pack_blobs + read_file must round-trip without error (integrity check baked in)."""
    from csf import csf_pack

    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    raw = csf_pack.read_file(str(g["csf"]), coder_grounding._ARC_INDEX)
    lines = [l for l in raw.decode("utf-8").splitlines() if l.strip()]
    assert len(lines) == len(_KC_RECORDS)


# ---------------------------------------------------------------------------
# Retrieve: TF-IDF relevance ordering
# ---------------------------------------------------------------------------

def test_retrieve_relevance_ordering(tmp_grounding):
    """'convergence loop' should surface convergence-loop record above others."""
    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    coder_grounding._cache = None  # force reload

    hits = coder_grounding.retrieve("convergence loop stage", k=3)

    assert len(hits) >= 1
    assert hits[0]["id"] == "convergence-loop", (
        f"expected convergence-loop first, got {hits[0]['id']}")
    assert hits[0]["score"] > 0


def test_retrieve_compression_query(tmp_grounding):
    """'omni codec compression brotli' should surface csf-format record."""
    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    coder_grounding._cache = None

    hits = coder_grounding.retrieve("omni codec brotli compression", k=3)

    assert hits, "expected at least one result"
    assert hits[0]["id"] == "csf-format"


def test_retrieve_empty_query_returns_nothing(tmp_grounding):
    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    coder_grounding._cache = None

    hits = coder_grounding.retrieve("", k=5)
    assert hits == []


def test_retrieve_after_explicit_build(tmp_grounding):
    """retrieve() works correctly after an explicit build() to the patched path."""
    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    coder_grounding._cache = None

    hits = coder_grounding.retrieve("convergence", k=2)
    assert len(hits) >= 1
    assert g["csf"].exists()


# ---------------------------------------------------------------------------
# grounding_context
# ---------------------------------------------------------------------------

def test_grounding_context_returns_preamble(tmp_grounding):
    g = tmp_grounding
    coder_grounding.build(out_path=g["csf"])
    coder_grounding._cache = None

    preamble, ids = coder_grounding.grounding_context("convergence loop", k=2)

    assert "Keystone OS grounding" in preamble
    assert len(ids) >= 1
    assert any("CONVERGANCE" in id_ or "convergence" in id_ for id_ in ids)
