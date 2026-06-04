import json
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
    assert scripts["start:cloud"] == "node cloud-server.js"
    assert "node --check cloud-server.js" in scripts["check"]


def test_runtime_cicd_docs_cover_local_cloud_and_render_validation() -> None:
    text = (ROOT / "docs" / "LANTERN-RUNTIME-CICD.md").read_text(encoding="utf-8")
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
    for runtime in ["server.js", "cloud-server.js"]:
        text = (ROOT / "apps" / "lantern-garage" / runtime).read_text(encoding="utf-8")
        assert "X-Content-Type-Options" in text
        assert "Referrer-Policy" in text
        assert "X-Frame-Options" in text
        assert "Permissions-Policy" in text


def test_cloud_runtime_keeps_write_methods_explicitly_bounded() -> None:
    text = (ROOT / "apps" / "lantern-garage" / "cloud-server.js").read_text(encoding="utf-8")
    assert "cloud_read_only_method_not_allowed" in text
    assert 'url.pathname === "/api/chat" && req.method === "POST"' in text
    assert 'url.pathname === "/api/command" && req.method === "POST"' in text
    assert 'url.pathname.startsWith("/api/actions/") && req.method === "POST"' in text


def test_server_supports_cloud_port_and_mirror_api() -> None:
    text = (ROOT / "apps" / "lantern-garage" / "server.js").read_text(encoding="utf-8")
    assert "process.env.PORT" in text
    assert "0.0.0.0" in text
    assert '"/api/cloud-mirrors"' in text
    assert "LANTERN_CLOUD_MIRROR_URLS" in text


def test_dashboard_holds_unverified_aws_url_as_local_front_door() -> None:
    text = (ROOT / "apps" / "lantern-garage" / "public" / "app.js").read_text(encoding="utf-8")
    required = [
        "function canonicalFrontDoorVerified(cloudMirrors)",
        "function cloudMirrorStateLabel(mirror, mirrors)",
        'const CLOUD_PROVIDER_LABEL = "AWS ECS/Fargate"',
        "service URL pending",
        'setFrontDoorLink(frontDoorUrl, canonicalVerified ? "Cloud front door" : "Local front door")',
        "return mirrors?.localPrimary || LOCAL_APP_ORIGIN",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
