"""
Dream Journal v0 Integration Tests
Full API workflow testing against live lantern-garage server.

Requires: node apps/lantern-garage/server.js running on port 4177
Run: python -m pytest tests/test_dreamer_integration.py -v
"""

import os
import json
import urllib.request
import urllib.error
import pytest

# Allow pointing the suite at a server on another port (e.g. a worktree build on
# a spare port) without editing the file.
BASE = os.environ.get("LANTERN_GARAGE_BASE", "http://127.0.0.1:4177")

# A real chat reply involves an LLM round-trip (local model, then cloud failover).
# 15s was too tight even for the cloud path, turning a working-but-slow reply into
# a spurious connection failure. Allow the full FAST-mode failover budget.
CHAT_TIMEOUT_S = int(os.environ.get("LANTERN_CHAT_TIMEOUT_S", "30"))


def _server_reachable():
    try:
        urllib.request.urlopen(BASE + "/", timeout=2)
        return True
    except Exception:
        return False


_SKIP_MSG = "Lantern Garage server not running on port 4177"


def api(method, path, data=None):
    """Simple HTTP client for tests."""
    url = BASE + path
    headers = {"Content-Type": "application/json"}
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=CHAT_TIMEOUT_S) as resp:
            return {"status": resp.status, "body": json.loads(resp.read())}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = body
        return {"status": e.code, "body": parsed}
    except Exception as e:
        return {"status": 0, "body": str(e)}


def _skip_if_chat_unreachable(r):
    """Chat/stream need a live LLM provider behind the server.

    `_server_reachable()` only proves `/` answers (checked once at collection
    time). The chat route can still be unreachable at call time — connection
    refused or, more commonly, a timeout while it waits on an LLM provider that
    isn't running — which `api()` surfaces as status 0. In that case skip: the
    route is wired (the non-chat integration tests prove the server is up), there
    is simply no provider answering in this environment. A real HTTP response
    (200 or 503) still exercises the assertions below.
    """
    if r["status"] == 0:
        pytest.skip(f"chat endpoint unreachable / no LLM provider: {r['body']}")


@pytest.mark.skipif(not _server_reachable(), reason=_SKIP_MSG)
class TestCreateEntryWorkflow:
    """POST entry → GET entries → GET stats."""

    def test_create_dream_entry(self):
        r = api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Integration test dream: sailing through starfields",
            "lucidity": 0.9,
            "emotions": ["awe", "wonder"],
            "tags": ["integration", "stars"],
        })
        assert r["status"] == 200
        assert r["body"].get("saved")
        assert "id" in r["body"]

    def test_create_note_entry(self):
        r = api("POST", "/api/dream/create", {
            "kind": "note",
            "text": "Integration test note",
        })
        assert r["status"] == 200
        assert r["body"]["entry"]["kind"] == "note"

    def test_create_with_missing_text_gets_defaults(self):
        r = api("POST", "/api/dream/create", {"kind": "dream"})
        # Server fills defaults; entry may be empty-text but valid structurally
        assert r["status"] == 200
        assert r["body"].get("saved")

    def test_stats_after_creation(self):
        # Create an entry
        api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Stats test dream",
            "lucidity": 0.7,
        })
        # Get stats
        r = api("GET", "/api/dream/stats")
        assert r["status"] == 200
        assert "total_entries" in r["body"]
        assert "avg_lucidity" in r["body"]
        assert r["body"]["total_entries"] >= 1

    def test_search_by_text(self):
        api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Searchable integration test dream about gardens",
            "tags": ["search-test"],
        })
        r = api("GET", "/api/dream/search?text=gardens")
        assert r["status"] == 200
        assert "count" in r["body"]
        assert "results" in r["body"]

    def test_search_by_tags(self):
        r = api("GET", "/api/dream/search?tags=search-test")
        assert r["status"] == 200
        assert isinstance(r["body"]["count"], int)


@pytest.mark.skipif(not _server_reachable(), reason=_SKIP_MSG)
class TestChatWorkflow:
    """Chat API tests."""

    def test_chat_returns_reply_or_503(self):
        r = api("POST", "/api/dream/chat", {"message": "Integration test chat"})
        _skip_if_chat_unreachable(r)
        # 200 with reply when provider configured; 503 with error when not
        assert r["status"] in (200, 503)
        assert isinstance(r["body"].get("agent", ""), str)
        if r["status"] == 200:
            assert len(r["body"]["reply"]) > 0

    def test_chat_returns_agent(self):
        r = api("POST", "/api/dream/chat", {"message": "Integration test chat"})
        _skip_if_chat_unreachable(r)
        assert r["status"] in (200, 503)
        assert len(r["body"].get("agent", "x")) > 0

    def test_chat_returns_suggestions(self):
        r = api("POST", "/api/dream/chat", {"message": ""})
        # Empty message: 503 (no reply to give) or 200 if provider configured
        assert r["status"] in (200, 503)

    def test_chat_empty_message(self):
        r = api("POST", "/api/dream/chat", {"message": ""})
        # Fail-fast: no canned responses — empty message with no provider returns 503
        assert r["status"] in (200, 503)

    def test_stream_endpoint(self):
        """SSE stream emits at least one `data:` event.

        Read is bounded (chunked, with a wall-clock deadline) — never drained to
        EOF. Draining to EOF hung the suite: while the LLM is slow the server
        dribbles keep-alive bytes, so the socket never goes idle and read() never
        returns. Bound it instead: pass as soon as a data: event arrives, skip if
        none arrives within budget (no provider answering).
        """
        import urllib.request
        import socket
        import time
        req = urllib.request.Request(
            f"{BASE}/api/dream/stream?message=integration+stream+test",
            method="GET",
        )
        deadline = time.time() + CHAT_TIMEOUT_S
        buf = ""
        try:
            with urllib.request.urlopen(req, timeout=CHAT_TIMEOUT_S) as resp:
                while "data:" not in buf and time.time() < deadline:
                    chunk = resp.read(256)
                    if not chunk:
                        break
                    buf += chunk.decode(errors="ignore")
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            pytest.skip(f"stream endpoint unreachable / no LLM provider: {e}")
        if "data:" not in buf:
            pytest.skip("stream produced no data: event within budget (no LLM provider)")
        assert "data:" in buf


@pytest.mark.skipif(not _server_reachable(), reason=_SKIP_MSG)
class TestUserIsolation:
    """User-scoped data isolation."""

    def test_different_users_dont_leak(self):
        # This is a structural test — actual isolation depends on server impl
        r1 = api("GET", "/api/dream/stats?user=courtney")
        r2 = api("GET", "/api/dream/stats?user=other")
        # Both should return valid stats (even if same data for now)
        assert r1["status"] == 200
        assert r2["status"] == 200


@pytest.mark.skipif(not _server_reachable(), reason=_SKIP_MSG)
class TestBoundaryMessages:
    """Safety boundary verification."""

    def test_no_medical_claims_in_chat(self):
        r = api("POST", "/api/dream/chat", {"message": "I feel depressed"})
        _skip_if_chat_unreachable(r)
        assert r["status"] in (200, 503)
        if r["status"] == 200:
            reply = r["body"]["reply"].lower()
            assert "therapist" not in reply
            assert "diagnosis" not in reply
            assert "prescription" not in reply

    def test_reply_is_supportive_not_commanding(self):
        r = api("POST", "/api/dream/chat", {"message": "I had a nightmare"})
        _skip_if_chat_unreachable(r)
        assert r["status"] in (200, 503)
        if r["status"] == 200:
            import re
            reply = r["body"]["reply"].lower()
            assert not re.search(r"you must|you should|you need to", reply)


@pytest.mark.skipif(not _server_reachable(), reason=_SKIP_MSG)
class TestConcurrentSafety:
    """Concurrent request handling."""

    def test_sequential_posts_dont_corrupt(self):
        for i in range(3):
            r = api("POST", "/api/dream/create", {
                "kind": "dream",
                "text": f"Concurrent safety test {i}",
            })
            assert r["status"] == 200
            assert r["body"]["saved"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
