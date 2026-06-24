import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "build_claude_session_dataset.py"
SPEC = importlib.util.spec_from_file_location("session_dataset", SCRIPT)
dataset = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dataset)

TRAIN_SCRIPT = Path(__file__).parents[1] / "scripts" / "train-qlora-ouro.py"
TRAIN_SPEC = importlib.util.spec_from_file_location("ouro_trainer", TRAIN_SCRIPT)
trainer = importlib.util.module_from_spec(TRAIN_SPEC)
TRAIN_SPEC.loader.exec_module(trainer)


class AgentSessionDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.limits = {
            "context": 3600,
            "output": 2200,
            "tool_result": 500,
            "window": 8,
            "match": "lantern-os",
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_jsonl(self, name, records):
        path = self.root / name
        path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        return path

    def test_codex_requires_real_result_and_scrubs_private_values(self):
        path = self.write_jsonl(
            "codex.jsonl",
            [
                {
                    "type": "session_meta",
                    "payload": {"cwd": "C:\\dev\\lantern-os"},
                },
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "inspect C:\\Users\\alex\\repo with sk-" + "a" * 24,
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "shell_command",
                        "arguments": '{"command":"git status"}',
                        "call_id": "call-1",
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": "call-1",
                        "output": "clean",
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "shell_command",
                        "arguments": '{"command":"git diff"}',
                        "call_id": "missing-result",
                    },
                },
            ],
        )
        rows, stats = dataset.codex_rows(path, self.limits)
        self.assertEqual(1, len(rows))
        self.assertEqual("codex", rows[0]["metadata"]["source"])
        self.assertIn("<tool_call>", rows[0]["output"])
        self.assertNotIn("C:\\Users\\alex", json.dumps(rows))
        self.assertNotIn("sk-" + "a" * 24, json.dumps(rows))
        self.assertEqual(1, stats["skipped_missing_result"])

    def test_chatgpt_only_emits_tool_using_turns_with_results(self):
        path = self.root / "conversations.json"
        path.write_text(
            json.dumps(
                [
                    {
                        "id": "chat-1",
                        "mapping": {
                            "u": {
                                "id": "u",
                                "message": {
                                    "role": "user",
                                    "create_time": 1,
                                    "content": {"parts": ["look up the issue"]},
                                },
                            },
                            "a": {
                                "id": "a",
                                "message": {
                                    "role": "assistant",
                                    "create_time": 2,
                                    "content": {"parts": []},
                                    "tool_calls": [
                                        {
                                            "id": "tc-1",
                                            "function": {
                                                "name": "web_search",
                                                "arguments": '{"query":"issue"}',
                                            },
                                        }
                                    ],
                                },
                            },
                            "t": {
                                "id": "t",
                                "message": {
                                    "role": "tool",
                                    "create_time": 3,
                                    "tool_call_id": "tc-1",
                                    "content": "result",
                                },
                            },
                            "plain": {
                                "id": "plain",
                                "message": {
                                    "role": "assistant",
                                    "create_time": 4,
                                    "content": {"parts": ["ordinary answer"]},
                                },
                            },
                        },
                    }
                ]
            ),
            encoding="utf-8",
        )
        rows, stats = dataset.chatgpt_rows(path, self.limits)
        self.assertEqual(1, len(rows))
        self.assertEqual("chatgpt", rows[0]["metadata"]["source"])
        self.assertEqual("web_search", rows[0]["metadata"]["tool_name"])
        self.assertEqual(1, stats["tool_rows"])

    def test_claude_rejects_errored_tool_call(self):
        path = self.write_jsonl(
            "claude.jsonl",
            [
                {"type": "user", "message": {"content": "run the check"}},
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "tool-1",
                                "name": "Bash",
                                "input": {"command": "pytest"},
                            }
                        ]
                    },
                },
                {
                    "type": "user",
                    "message": {
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "tool-1",
                                "is_error": True,
                                "content": "exit code 1",
                            }
                        ]
                    },
                },
            ],
        )
        rows, stats = dataset.claude_rows(path, self.limits)
        self.assertEqual([], rows)
        self.assertEqual(1, stats["skipped_error"])

    def test_json_output_is_deterministic(self):
        row, _ = dataset.make_row("same", "answer", "base", "session")
        unique, _ = dataset.make_row("different", "answer", "base", "session")
        rows = [row, unique]
        rows.sort(
            key=lambda item: dataset.stable_id(
                item["instruction"], item.get("input", ""), item["output"]
            )
        )
        first, second = self.root / "first.json", self.root / "second.json"
        dataset.write_rows(first, rows)
        dataset.write_rows(second, rows)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(2, len(json.loads(first.read_text(encoding="utf-8"))))
        self.assertEqual(2, len(trainer.load_training_records(first)))

        legacy = self.root / "legacy.jsonl"
        legacy.write_text(
            "\n".join(json.dumps(item) for item in rows) + "\n", encoding="utf-8"
        )
        self.assertEqual(2, len(trainer.load_training_records(legacy)))


if __name__ == "__main__":
    unittest.main()
