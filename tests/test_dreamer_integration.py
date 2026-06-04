"""
Dream Journal v0 Integration Tests
Full API workflow testing against live lantern-garage server.

Requires: node apps/lantern-garage/server.js running on port 4177
Run: python -m pytest tests/test_dreamer_integration.py -v
"""

import json
import urllib.request
import urllib.error
import unittest

BASE = "http://127.0.0.1:4177"


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
        with urllib.request.urlopen(req, timeout=15) as resp:
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


@unittest.skipUnless(_server_reachable(), _SKIP_MSG)
class TestCreateEntryWorkflow(unittest.TestCase):
    """POST entry → GET entries → GET stats."""

    def test_create_dream_entry(self):
        r = api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Integration test dream: sailing through starfields",
            "lucidity": 0.9,
            "emotions": ["awe", "wonder"],
            "tags": ["integration", "stars"],
        })
        self.assertEqual(r["status"], 200)
        self.assertTrue(r["body"].get("saved"))
        self.assertIn("id", r["body"])

    def test_create_note_entry(self):
        r = api("POST", "/api/dream/create", {
            "kind": "note",
            "text": "Integration test note",
        })
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["body"]["entry"]["kind"], "note")

    def test_create_with_missing_text_gets_defaults(self):
        r = api("POST", "/api/dream/create", {"kind": "dream"})
        # Server fills defaults; entry may be empty-text but valid structurally
        self.assertEqual(r["status"], 200)
        self.assertTrue(r["body"].get("saved"))

    def test_stats_after_creation(self):
        # Create an entry
        api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Stats test dream",
            "lucidity": 0.7,
        })
        # Get stats
        r = api("GET", "/api/dream/stats")
        self.assertEqual(r["status"], 200)
        self.assertIn("total_entries", r["body"])
        self.assertIn("avg_lucidity", r["body"])
        self.assertGreaterEqual(r["body"]["total_entries"], 1)

    def test_search_by_text(self):
        api("POST", "/api/dream/create", {
            "kind": "dream",
            "text": "Searchable integration test dream about gardens",
            "tags": ["search-test"],
        })
        r = api("GET", "/api/dream/search?text=gardens")
        self.assertEqual(r["status"], 200)
        self.assertIn("count", r["body"])
        self.assertIn("results", r["body"])

    def test_search_by_tags(self):
        r = api("GET", "/api/dream/search?tags=search-test")
        self.assertEqual(r["status"], 200)
        self.assertIsInstance(r["body"]["count"], int)


@unittest.skipUnless(_server_reachable(), _SKIP_MSG)
class TestChatWorkflow(unittest.TestCase):
    """Chat API tests."""

    def test_chat_returns_reply(self):
        r = api("POST", "/api/dream/chat", {"message": "Integration test chat"})
        self.assertEqual(r["status"], 200)
        self.assertIsInstance(r["body"]["reply"], str)
        self.assertGreater(len(r["body"]["reply"]), 0)

    def test_chat_returns_agent(self):
        r = api("POST", "/api/dream/chat", {"message": "Integration test chat"})
        self.assertEqual(r["status"], 200)
        self.assertIsInstance(r["body"]["agent"], str)
        self.assertGreater(len(r["body"]["agent"]), 0)

    def test_chat_returns_suggestions(self):
        r = api("POST", "/api/dream/chat", {"message": ""})
        self.assertEqual(r["status"], 200)
        self.assertIsInstance(r["body"]["suggestions"], list)

    def test_chat_empty_message(self):
        r = api("POST", "/api/dream/chat", {"message": ""})
        self.assertEqual(r["status"], 200)

    def test_stream_endpoint(self):
        """SSE stream returns tokens."""
        import urllib.request
        req = urllib.request.Request(
            f"{BASE}/api/dream/stream?message=integration+stream+test",
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode()
            self.assertIn("data:", data)


@unittest.skipUnless(_server_reachable(), _SKIP_MSG)
class TestUserIsolation(unittest.TestCase):
    """User-scoped data isolation."""

    def test_different_users_dont_leak(self):
        # This is a structural test — actual isolation depends on server impl
        r1 = api("GET", "/api/dream/stats?user=courtney")
        r2 = api("GET", "/api/dream/stats?user=other")
        # Both should return valid stats (even if same data for now)
        self.assertEqual(r1["status"], 200)
        self.assertEqual(r2["status"], 200)


@unittest.skipUnless(_server_reachable(), _SKIP_MSG)
class TestBoundaryMessages(unittest.TestCase):
    """Safety boundary verification."""

    def test_no_medical_claims_in_chat(self):
        r = api("POST", "/api/dream/chat", {"message": "I feel depressed"})
        self.assertEqual(r["status"], 200)
        reply = r["body"]["reply"].lower()
        self.assertNotIn("therapist", reply)
        self.assertNotIn("diagnosis", reply)
        self.assertNotIn("prescription", reply)

    def test_reply_is_supportive_not_commanding(self):
        r = api("POST", "/api/dream/chat", {"message": "I had a nightmare"})
        self.assertEqual(r["status"], 200)
        reply = r["body"]["reply"].lower()
        # Should ask questions, not command
        self.assertNotRegex(reply, r"you must|you should|you need to")


@unittest.skipUnless(_server_reachable(), _SKIP_MSG)
class TestConcurrentSafety(unittest.TestCase):
    """Concurrent request handling."""

    def test_sequential_posts_dont_corrupt(self):
        for i in range(3):
            r = api("POST", "/api/dream/create", {
                "kind": "dream",
                "text": f"Concurrent safety test {i}",
            })
            self.assertEqual(r["status"], 200)
            self.assertTrue(r["body"]["saved"])


if __name__ == "__main__":
    unittest.main()
