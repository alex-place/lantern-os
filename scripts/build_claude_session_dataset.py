"""Build the private Kaggle Ouro dataset from Claude, Codex, and ChatGPT.

The historical filename is retained for compatibility, but this is a
multi-source builder. Generated data remains local/gitignored. Codex and
ChatGPT rows require authentic tool calls with matching successful results.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

PREAMBLE = (
    "You are a coding agent working inside a software repository. Given the "
    "conversation so far, produce the next action: a brief reply and/or a tool "
    'call rendered as <tool_call>{"name":...,"input":{...}}</tool_call>.'
)
DEFAULT_OUT = "models/lantern-sigma0-coder/training-data.claude-combined.json"
SECRET_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9\-_]{20,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xai-[A-Za-z0-9\-]{20,}|AKIA[0-9A-Z]{16}|"
    r"xox[baprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,})"
)
WINDOWS_HOME_RE = re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\s\"']+")
UNIX_HOME_RE = re.compile(r"(?<![\w.-])/home/[^/\s\"']+")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
ERROR_RE = re.compile(
    r"\b(error|exception|traceback|failed|exit code [1-9]|enoent|"
    r"permission denied|no such file)\b",
    re.IGNORECASE,
)
SKIP_TOOLS = {"TodoWrite", "exit_plan_mode", "ExitPlanMode"}


def scrub_text(value: str) -> tuple[str, int]:
    count = 0
    for pattern, replacement in (
        (SECRET_RE, "[REDACTED_SECRET]"),
        (WINDOWS_HOME_RE, "%USERPROFILE%"),
        (UNIX_HOME_RE, "~"),
        (EMAIL_RE, "[REDACTED_EMAIL]"),
    ):
        value, changed = pattern.subn(replacement, value)
        count += changed
    return value, count


def scrub(value: Any) -> tuple[Any, int]:
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
        result, count = [], 0
        for item in value:
            clean, changed = scrub(item)
            result.append(clean)
            count += changed
        return result, count
    if isinstance(value, dict):
        result, count = {}, 0
        for key, item in value.items():
            clean, changed = scrub(item)
            result[key] = clean
            count += changed
        return result, count
    return value, 0


def truncate(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    value = value.strip()
    return value if len(value) <= limit else value[:limit] + " …[truncated]"


def render_tool_call(name: str, arguments: Any) -> str:
    if not isinstance(arguments, dict):
        arguments = {"value": arguments}
    payload = {"name": name, "input": arguments}
    return "<tool_call>" + json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "</tool_call>"


def stable_id(*parts: Any) -> str:
    raw = "\x1f".join(
        part
        if isinstance(part, str)
        else json.dumps(part, ensure_ascii=False, sort_keys=True)
        for part in parts
    )
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()


def read_records(path: Path) -> list[Any]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    stripped = text.lstrip()
    if not stripped:
        return []
    if stripped[0] in "[{":
        try:
            value = json.loads(text)
            return value if isinstance(value, list) else [value]
        except json.JSONDecodeError:
            pass
    records = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def source_files(paths: Iterable[str], suffixes=(".json", ".jsonl")) -> list[Path]:
    found: set[Path] = set()
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_file() and path.suffix.lower() in suffixes:
            found.add(path.resolve())
        elif path.is_dir():
            for suffix in suffixes:
                found.update(p.resolve() for p in path.rglob(f"*{suffix}"))
    return sorted(found, key=lambda path: str(path).lower())


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        if isinstance(content.get("parts"), list):
            return message_text(content["parts"])
        return str(content.get("text") or "").strip()
    if isinstance(content, list):
        texts = []
        for item in content:
            if isinstance(item, str):
                texts.append(item)
            elif isinstance(item, dict) and item.get("type") in (
                "text",
                "input_text",
                "output_text",
            ):
                texts.append(str(item.get("text") or ""))
        return "\n".join(text.strip() for text in texts if text.strip())
    return ""


def make_row(
    instruction: str,
    output: str,
    source: str,
    session_id: str,
    tool_name: str | None = None,
    call_id: str | None = None,
) -> tuple[dict[str, Any], int]:
    return scrub(
        {
            "instruction": instruction,
            "input": "",
            "output": output,
            "metadata": {
                "source": source,
                "session_id": stable_id(source, session_id)[:16],
                "has_tool": bool(tool_name),
                "tool_name": tool_name,
                "tool_call_id": stable_id(call_id)[:12] if call_id else None,
            },
        }
    )


def claude_rows(path: Path, limits: dict[str, int]) -> tuple[list[dict], Counter]:
    records = [record for record in read_records(path) if isinstance(record, dict)]
    stats = Counter(files=1, records=len(records))
    results: dict[str, str] = {}
    errors: set[str] = set()
    for record in records:
        message = record.get("message")
        if record.get("type") != "user" or not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            call_id = str(block.get("tool_use_id") or "")
            body = message_text(block.get("content"))
            if call_id:
                results[call_id] = body
                if block.get("is_error") or ERROR_RE.search(body[:500]):
                    errors.add(call_id)

    rows, history = [], []
    for record in records:
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if record.get("type") == "user":
            text = message_text(content)
            if text:
                history.append(("User", truncate(text, limits["context"])))
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        body = message_text(block.get("content"))
                        if body:
                            history.append(
                                ("ToolResult", truncate(body, limits["tool_result"]))
                            )
            continue
        if record.get("type") != "assistant" or not isinstance(content, list):
            continue
        lead = message_text(content)
        tool_blocks = [
            block
            for block in content
            if isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") not in SKIP_TOOLS
        ]
        calls, accepted = [], []
        for block in tool_blocks:
            call_id = str(block.get("id") or "")
            if not call_id or call_id not in results:
                stats["skipped_missing_result"] += 1
                continue
            if call_id in errors:
                stats["skipped_error"] += 1
                continue
            name = str(block.get("name") or "")
            calls.append(render_tool_call(name, block.get("input") or {}))
            accepted.append((name, call_id))
        output = "\n".join(([lead] if lead else []) + calls).strip()
        if not output or len(output) > limits["output"]:
            stats["skipped_empty_or_long"] += 1
            continue
        if tool_blocks and not accepted:
            continue
        instruction = PREAMBLE + "\n\n" + "\n\n".join(
            f"<{role}>\n{text}" for role, text in history[-limits["window"] :]
        ) + "\n\n<Assistant>"
        tool_name, call_id = accepted[0] if accepted else (None, None)
        row, changed = make_row(
            truncate(instruction, limits["context"]),
            output,
            "claude",
            path.stem,
            tool_name,
            call_id,
        )
        rows.append(row)
        stats["scrubbed"] += changed
        stats["tool_rows" if tool_name else "text_rows"] += 1
        history.append(("Assistant", truncate(output, limits["context"])))
    stats["rows"] = len(rows)
    return rows, stats


def codex_rows(path: Path, limits: dict[str, int]) -> tuple[list[dict], Counter]:
    records = [record for record in read_records(path) if isinstance(record, dict)]
    stats = Counter(files=1, records=len(records))
    recorded_cwds = [
        str(record.get("payload", {}).get("cwd") or "")
        for record in records
        if record.get("type") == "session_meta"
        and isinstance(record.get("payload"), dict)
    ]
    match = str(limits.get("match") or "").lower()
    if match and recorded_cwds and not any(
        match in cwd.lower() for cwd in recorded_cwds
    ):
        stats["skipped_out_of_scope"] += 1
        stats["rows"] = 0
        return [], stats
    calls, outputs, user_text = [], {}, ""
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "event_msg" and payload.get("type") == "user_message":
            user_text = message_text(payload.get("message"))
        if record.get("type") != "response_item":
            continue
        kind = payload.get("type")
        if kind == "message" and payload.get("role") == "user":
            user_text = message_text(payload.get("content"))
        elif kind == "function_call":
            arguments = payload.get("arguments") or {}
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {"raw": arguments}
            calls.append(
                {
                    "name": str(payload.get("name") or ""),
                    "arguments": arguments,
                    "call_id": str(payload.get("call_id") or ""),
                    "user_text": user_text,
                }
            )
        elif kind == "function_call_output":
            outputs[str(payload.get("call_id") or "")] = message_text(
                payload.get("output")
            )

    rows = []
    for call in calls:
        result = outputs.get(call["call_id"])
        if not call["call_id"] or result is None:
            stats["skipped_missing_result"] += 1
            continue
        if ERROR_RE.search(result[:500]):
            stats["skipped_error"] += 1
            continue
        if not call["user_text"]:
            stats["skipped_missing_user"] += 1
            continue
        instruction = (
            PREAMBLE
            + "\n\n<User>\n"
            + truncate(call["user_text"], limits["context"])
            + "\n\n<Assistant>"
        )
        row, changed = make_row(
            instruction,
            render_tool_call(call["name"], call["arguments"]),
            "codex",
            path.stem,
            call["name"],
            call["call_id"],
        )
        rows.append(row)
        stats["scrubbed"] += changed
        stats["tool_rows"] += 1
    stats["rows"] = len(rows)
    return rows, stats


def flatten_chatgpt(value: Any) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    mapping = value.get("mapping")
    if not isinstance(mapping, dict):
        return [value]
    nodes = [node for node in mapping.values() if isinstance(node, dict) and node.get("message")]
    nodes.sort(
        key=lambda node: (
            node.get("message", {}).get("create_time") or node.get("create_time") or 0,
            str(node.get("id") or ""),
        )
    )
    return [node["message"] for node in nodes if isinstance(node.get("message"), dict)]


def chatgpt_tool_calls(message: dict) -> list[dict]:
    calls = message.get("tool_calls")
    metadata = message.get("metadata")
    if not isinstance(calls, list) and isinstance(metadata, dict):
        calls = metadata.get("tool_calls")
    calls = list(calls) if isinstance(calls, list) else []
    if isinstance(message.get("function_call"), dict):
        calls.append({"id": message.get("id"), "function": message["function_call"]})
    content = message.get("content")
    parts = content.get("parts") if isinstance(content, dict) else content
    if isinstance(parts, list):
        calls.extend(
            part
            for part in parts
            if isinstance(part, dict)
            and part.get("type") in ("tool_call", "function_call")
        )
    normalized = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else call
        name = function.get("name") or call.get("name")
        arguments = function.get(
            "arguments", call.get("arguments", call.get("input", {}))
        )
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = {"raw": arguments}
        if name:
            normalized.append(
                {
                    "id": str(call.get("id") or call.get("call_id") or ""),
                    "name": str(name),
                    "arguments": arguments,
                }
            )
    return normalized


def chatgpt_rows(path: Path, limits: dict[str, int]) -> tuple[list[dict], Counter]:
    conversations = read_records(path)
    stats = Counter(files=1, records=len(conversations))
    rows = []
    for index, conversation in enumerate(conversations):
        messages = flatten_chatgpt(conversation)
        session_id = str(
            (conversation.get("id") if isinstance(conversation, dict) else None)
            or f"{path.stem}-{index}"
        )
        results: dict[str, str] = {}
        for message in messages:
            role = (
                message.get("role") or message.get("author", {}).get("role") or ""
            ).lower()
            if role in ("tool", "function"):
                call_id = str(
                    message.get("tool_call_id")
                    or message.get("recipient")
                    or message.get("name")
                    or ""
                )
                if call_id:
                    results[call_id] = message_text(message.get("content"))
        last_user = ""
        for message in messages:
            role = (
                message.get("role") or message.get("author", {}).get("role") or ""
            ).lower()
            if role == "user":
                last_user = message_text(message.get("content"))
                continue
            if role != "assistant":
                continue
            for call in chatgpt_tool_calls(message):
                result = results.get(call["id"]) or results.get(call["name"])
                if result is None:
                    stats["skipped_missing_result"] += 1
                    continue
                if ERROR_RE.search(result[:500]):
                    stats["skipped_error"] += 1
                    continue
                if not last_user:
                    stats["skipped_missing_user"] += 1
                    continue
                instruction = (
                    PREAMBLE
                    + "\n\n<User>\n"
                    + truncate(last_user, limits["context"])
                    + "\n\n<Assistant>"
                )
                row, changed = make_row(
                    instruction,
                    render_tool_call(call["name"], call["arguments"]),
                    "chatgpt",
                    session_id,
                    call["name"],
                    call["id"],
                )
                rows.append(row)
                stats["scrubbed"] += changed
                stats["tool_rows"] += 1
    stats["rows"] = len(rows)
    return rows, stats


def base_rows(paths: list[str]) -> tuple[list[dict], Counter]:
    rows, stats = [], Counter()
    for path in source_files(paths):
        stats["files"] += 1
        for value in read_records(path):
            if not isinstance(value, dict):
                stats["skipped_invalid"] += 1
                continue
            instruction, output = value.get("instruction"), value.get("output")
            if not isinstance(instruction, str) or not isinstance(output, str):
                stats["skipped_invalid"] += 1
                continue
            metadata = value.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            row, changed = make_row(
                instruction,
                output,
                str(metadata.get("source") or "base"),
                str(metadata.get("session_id") or path.name),
                metadata.get("tool_name"),
                metadata.get("tool_call_id"),
            )
            rows.append(row)
            stats["scrubbed"] += changed
            stats["tool_rows" if "<tool_call>" in output else "text_rows"] += 1
    stats["rows"] = len(rows)
    return rows, stats


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".json":
        path.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    else:
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def default_codex_sources() -> list[str]:
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    return [str(home / "sessions"), str(home / "archived_sessions")]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", action="append", default=[])
    parser.add_argument("--claude-source", action="append", default=[])
    parser.add_argument("--codex-source", action="append", default=[])
    parser.add_argument("--chatgpt-source", action="append", default=[])
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--report")
    parser.add_argument("--ctx-chars", type=int, default=3600)
    parser.add_argument("--out-chars", type=int, default=2200)
    parser.add_argument("--tool-result-chars", type=int, default=500)
    parser.add_argument("--window", type=int, default=8)
    parser.add_argument(
        "--match",
        default="lantern-os",
        help="automatic Claude/Codex discovery must match this repo marker",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.claude_source:
        claude_sources = args.claude_source
    else:
        claude_home = Path(
            os.environ.get("CLAUDE_PROJECTS_DIR") or Path.home() / ".claude/projects"
        )
        claude_sources = [
            str(path)
            for path in sorted(claude_home.glob("*"))
            if path.is_dir() and args.match.lower() in path.name.lower()
        ]
    codex_sources = args.codex_source or default_codex_sources()
    chatgpt_sources = list(args.chatgpt_source)
    if os.environ.get("CHATGPT_SESSION_EXPORT"):
        chatgpt_sources.append(os.environ["CHATGPT_SESSION_EXPORT"])
    limits = {
        "context": args.ctx_chars,
        "output": args.out_chars,
        "tool_result": args.tool_result_chars,
        "window": args.window,
        "match": args.match,
    }

    all_rows: list[dict] = []
    report: dict[str, Any] = {
        "format_version": 1,
        "output": args.out,
        "kaggle_path": (
            "/kaggle/input/ouro-claude-sessions/"
            "training-data.claude-combined.json"
        ),
        "sources": {},
    }
    base, stats = base_rows(args.base)
    all_rows.extend(base)
    report["sources"]["base"] = dict(stats)
    for source, files, parse in (
        ("claude", source_files(claude_sources, (".jsonl",)), claude_rows),
        ("codex", source_files(codex_sources, (".jsonl",)), codex_rows),
        ("chatgpt", source_files(chatgpt_sources), chatgpt_rows),
    ):
        source_stats = Counter()
        for path in files:
            rows, file_stats = parse(path, limits)
            all_rows.extend(rows)
            source_stats.update(file_stats)
        source_stats["discovered_files"] = len(files)
        report["sources"][source] = dict(source_stats)

    deduped: dict[str, dict] = {}
    for row in all_rows:
        fingerprint = stable_id(row["instruction"], row.get("input", ""), row["output"])
        deduped.setdefault(fingerprint, row)
    rows = [deduped[key] for key in sorted(deduped)]
    report["summary"] = {
        "before_dedup": len(all_rows),
        "deduplicated": len(all_rows) - len(rows),
        "rows": len(rows),
        "tool_rows": sum(bool(row["metadata"].get("has_tool")) for row in rows),
        "scrubbed": sum(
            int(source.get("scrubbed", 0)) for source in report["sources"].values()
        ),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    if args.dry_run:
        return 0
    out = Path(args.out)
    write_rows(out, rows)
    report_path = (
        Path(args.report)
        if args.report
        else out.with_suffix(out.suffix + ".summary.json")
    )
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
