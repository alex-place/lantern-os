import json
import pytest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_cloud_mirror_manifest_has_multiple_cloud_urls() -> None:
    manifest = json.loads((ROOT / "manifests" / "cloud-mirrors.json").read_text(encoding="utf-8"))
    mirrors = manifest["cloudMirrors"]
    urls = [item["url"] for item in mirrors]
    assert manifest["deployProvider"] == "Netlify"
    assert manifest["deployBranch"] == "master"
    assert "https://lantern-os-cloud.netlify.app" in urls
    assert len(urls) == len(set(urls))
    assert manifest["awsRuntime"]["imageSource"] == "apps/lantern-garage/Dockerfile"
    assert manifest["awsRuntime"]["containerPort"] == 8080
    assert all("onrender.com" in item["url"] for item in manifest["retiredMirrors"])


def test_aws_dockerfile_uses_cloud_runtime_and_port() -> None:
    text = (ROOT / "apps" / "lantern-garage" / "Dockerfile").read_text(encoding="utf-8")
    assert "FROM python:3.12-slim" in text
    assert "EXPOSE 8080" in text


def test_package_splits_local_and_cloud_runtime_scripts() -> None:
    package = json.loads((ROOT / "apps" / "lantern-garage" / "package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    assert scripts["start"] == "node server.js"
    assert scripts["start:local"] == "node server.js"
    # cloud-server.js removed in cleanup PR #230 — start:cloud and check for it no longer exist


def test_runtime_cicd_docs_cover_local_cloud_and_render_validation() -> None:
    text = (ROOT / "docs" / "archive" / "LANTERN-RUNTIME-CICD.md").read_text(encoding="utf-8")
    required = [
        "npm run start:local",
        "npm run start:cloud",
        "AWS ECS Fargate",
        "static-surface-ci.yml",
        "AWS deploy gate",
        "Show the state. Say the limit. Self-correct before acting.",
        "A door is a protocol boundary",
        "advisory, source-backed, operator-reviewed, and challengeable",
        "localhost-only Lantern chat surface",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_local_and_cloud_runtimes_share_browser_hardening_headers() -> None:
    # cloud-server.js removed in PR #230 — only verify server.js
    text = (ROOT / "apps" / "lantern-garage" / "server.js").read_text(encoding="utf-8")
    assert "X-Content-Type-Options" in text
    assert "Referrer-Policy" in text
    assert "X-Frame-Options" in text
    assert "Permissions-Policy" in text


@pytest.mark.skip(reason="cloud-server.js removed in cleanup PR #230")
def test_cloud_runtime_keeps_write_methods_explicitly_bounded() -> None:
    text = (ROOT / "apps" / "lantern-garage" / "cloud-server.js").read_text(encoding="utf-8")
    assert "cloud_read_only_method_not_allowed" in text


def test_server_supports_cloud_port_and_mirror_api() -> None:
    server = (ROOT / "apps" / "lantern-garage" / "server.js").read_text(encoding="utf-8")
    routes = (ROOT / "apps" / "lantern-garage" / "routes" / "status.js").read_text(encoding="utf-8")
    assert "process.env.PORT" in server
    assert "0.0.0.0" in server
    assert '"/api/cloud-mirrors"' in routes
    assert "LANTERN_CLOUD_MIRROR_URLS" in server


# (test_dashboard_holds_unverified_aws_url_as_local_front_door was removed: its
# subject — public/app.js and its cloud-mirror front-door logic — was deleted as
# dead code in #2685, which left this test failing on every PR.)
