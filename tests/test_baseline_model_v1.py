import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_baseline_model_v1_records_ingest_counts_and_aws_truth() -> None:
    model = json.loads(read("data/baseline-model/v1.json"))
    assert model["schema"] == "lantern.baseline_model.v1"
    assert model["status"] == "baseline_updated_not_v1_promoted"
    assert model["truthBoundaries"]["cloudProvider"] == "AWS ECS Fargate"
    assert model["truthBoundaries"]["renderStatus"] == "retired_from_lantern_cloud_truth"
    assert model["ingestion"]["internalFileCount"] >= 100
    assert model["ingestion"]["flatRagRecordCount"] >= 100
    assert model["ingestion"]["downloadMergeRecords"] >= 20
    assert model["truthBoundaries"]["clearedCashUsd"] == 0
    assert model["truthBoundaries"]["pendingInvoiceUsd"] == 199
    assert model["statsEvidence"]["kalshiPublicSnapshot"]["minMidCents"] == 20
    assert model["statsEvidence"]["kalshiPublicSnapshot"]["actionableTradeCount"] == 0
    assert model["statsEvidence"]["oneIdeStatus"]["mode"] == "read_only_preflight"
    assert model["statsEvidence"]["oneIdeStatus"]["failedServiceCount"] == 0


def test_baseline_model_v1_clears_old_docs_by_retirement_manifest() -> None:
    text = read("manifests/retired-surfaces.md")
    required = [
        "Render Lantern cloud mirror",
        "AWS ECS Fargate container lane",
        "cloud-server.js",
        "HFF Render mirror as Lantern status source",
        "Local-held HFF status",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_baseline_model_v1_markdown_links_receipt_and_blocks_promotion() -> None:
    text = read("manifests/LANTERN-BASELINE-MODEL-v1.md")
    required = [
        "baseline updated; v1.0.0 promotion still held",
        "Internal house RAG files",
        "Flat RAG records",
        "AWS service URL is not verified yet",
        "v1.0.0 tag remains held",
        "data/baseline-model/v1.json",
        "Stats Receipts",
        "values below 20 cents excluded",
        "artifacts/ONE-IDE-STATUS-LATEST.pdf",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_dashboard_links_baseline_model_v1_receipt() -> None:
    html = read("apps/lantern-garage/public/index.html")
    assert "Baseline v1" in html
    assert "/view?path=manifests/LANTERN-BASELINE-MODEL-v1.md" in html
