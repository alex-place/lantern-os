"""Tests for scripts/arxiv_harvest.py — OAI-PMH parsing, category/date filtering,
month sharding and dedup. No network: parses a static OAI-PMH fixture.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# scripts/ isn't on pytest.ini's pythonpath (apps src); add it.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import arxiv_harvest as ah  # noqa: E402


# A minimal but realistic OAI-PMH ListRecords response in arXiv's native metadata
# format: one AI paper (keep), one pure-math paper (filtered out), one deleted record
# (skipped), plus a resumptionToken.
FIXTURE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-07-06T00:00:00Z</responseDate>
  <ListRecords>
    <record>
      <header>
        <identifier>oai:arXiv.org:2508.00001</identifier>
        <datestamp>2026-03-05</datestamp>
        <setSpec>cs</setSpec>
      </header>
      <metadata>
        <arXiv xmlns="http://arxiv.org/OAI/arXiv/">
          <id>2508.00001</id>
          <created>2026-03-01</created>
          <updated>2026-03-05</updated>
          <authors>
            <author><keyname>Smith</keyname><forenames>Jane Q</forenames></author>
            <author><keyname>Lee</keyname><forenames>Kai</forenames></author>
          </authors>
          <title>Reducing Hallucination in Large Language Models</title>
          <categories>cs.CL cs.AI</categories>
          <abstract>  We study hallucination in large language models
          and propose a reward model.  </abstract>
        </arXiv>
      </metadata>
    </record>
    <record>
      <header>
        <identifier>oai:arXiv.org:2509.09999</identifier>
        <datestamp>2026-03-06</datestamp>
        <setSpec>math</setSpec>
      </header>
      <metadata>
        <arXiv xmlns="http://arxiv.org/OAI/arXiv/">
          <id>2509.09999</id>
          <created>2026-03-02</created>
          <updated>2026-03-06</updated>
          <authors><author><keyname>Euler</keyname><forenames>L</forenames></author></authors>
          <title>On Prime Gaps</title>
          <categories>math.NT math.PR</categories>
          <abstract>A number theory result.</abstract>
        </arXiv>
      </metadata>
    </record>
    <record>
      <header status="deleted">
        <identifier>oai:arXiv.org:2508.00007</identifier>
        <datestamp>2026-03-07</datestamp>
      </header>
    </record>
    <resumptionToken>TOKEN-abc-123</resumptionToken>
  </ListRecords>
</OAI-PMH>
"""


def test_parse_extracts_fields_and_token():
    records, token, err = ah.parse_records(FIXTURE_XML)
    assert err is None
    assert token == "TOKEN-abc-123"
    # deleted record skipped -> only the two metadata records parsed
    assert len(records) == 2

    rec = records[0]
    assert rec["id"] == "2508.00001"
    assert rec["title"] == "Reducing Hallucination in Large Language Models"
    assert rec["categories"] == ["cs.CL", "cs.AI"]
    assert rec["primary_category"] == "cs.CL"
    # date derived from the id (2508 -> 2025-08), NOT the unreliable <created> field
    assert rec["published"] == "2025-08"
    assert rec["authors"] == ["Jane Q Smith", "Kai Lee"]
    # whitespace in the abstract is collapsed
    assert rec["abstract"] == "We study hallucination in large language models and propose a reward model."
    assert rec["arxiv_url"] == "https://arxiv.org/abs/2508.00001"
    assert rec["pdf_url"] == "https://arxiv.org/pdf/2508.00001"


def test_id_to_ym():
    assert ah.id_to_ym("2508.00001") == "2025-08"
    assert ah.id_to_ym("1709.08894") == "2017-09"
    assert ah.id_to_ym("2601.12345") == "2026-01"
    assert ah.id_to_ym("hep-th/9901001") == ""   # pre-2007 scheme, out of scope
    assert ah.id_to_ym("") == ""


def test_keep_filters_by_category():
    records, _, _ = ah.parse_records(FIXTURE_XML)
    ai_rec, math_rec = records[0], records[1]
    assert ah.keep(ai_rec, "2025-07-01") is True
    assert ah.keep(math_rec, "2025-07-01") is False  # math.NT/math.PR not in TARGET_CATEGORIES


def test_keep_filters_by_publish_date():
    records, _, _ = ah.parse_records(FIXTURE_XML)
    ai_rec = records[0]  # id 2508 -> published 2025-08
    assert ah.keep(ai_rec, "2025-07-01") is True
    assert ah.keep(ai_rec, "2025-09-01") is False  # 2025-08 is before the 2025-09 window
    # a paper whose id can't be dated is excluded from a recent-research corpus
    assert ah.keep({"id": "hep-th/9901001", "categories": ["cs.LG"]}, "2025-07-01") is False


def test_oai_error_surfaced():
    xml = (
        b'<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">'
        b'<error code="noRecordsMatch">no records</error></OAI-PMH>'
    )
    records, token, err = ah.parse_records(xml)
    assert records == []
    assert token is None
    assert err == ("noRecordsMatch", "no records")


def test_shard_path_by_month(tmp_path):
    assert ah.shard_path(tmp_path, "2025-08").name == "2025-08.jsonl"     # month granularity
    assert ah.shard_path(tmp_path, "2026-03-01").name == "2026-03.jsonl"  # day granularity tolerated
    assert ah.shard_path(tmp_path, "").name == "unknown.jsonl"


def test_writer_and_dedup(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    w = ah.ShardWriter(raw)
    rec = {"id": "2508.00001", "published": "2025-08", "title": "t", "abstract": "a"}
    w.write(rec)
    w.close()

    shard = raw / "2025-08.jsonl"
    assert shard.exists()
    stored = json.loads(shard.read_text(encoding="utf-8").strip())
    assert stored["id"] == "2508.00001"

    seen = ah.load_seen_ids(raw)
    assert "2508.00001" in seen
