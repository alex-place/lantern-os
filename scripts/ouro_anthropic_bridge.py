"""
Anthropic Messages API -> Ouro (Ollama API) bridge, WITH prompted tool-calling.

Lets **Claude Code** (which only speaks the Anthropic /v1/messages API) drive the
local Σ₀ Ouro coder, which `scripts/ouro_serve.py` serves over the *Ollama* API.

    Claude Code --/v1/messages(+tools)--> THIS bridge --/api/chat--> ouro_serve (:11434) --> Ouro-1.4B

Ouro-1.4B has NO native tool-calling training, so tool calling is THIS proxy's job
(the same trick LiteLLM / claude-code-router use for non-tool-native models):

  1. INJECT the request's `tools` into the system prompt with an explicit, copyable
     single-line `<tool_call>{"name":...,"input":{...}}</tool_call>` format.
  2. BUFFER the model's reply, PARSE the first <tool_call>, validate the name against
     the request's tool set, and synthesize an Anthropic `tool_use` content block +
     stop_reason "tool_use" (streaming SSE or non-streaming JSON).
  3. If no valid tool call -> return the text as a normal end_turn answer.

The single-line format is chosen because ouro_serve's stop-strings ("\n```", "\n\n\n")
would truncate a fenced ```json block. Run ouro_serve with OURO_NO_STOP=1 for safety.

Config (env):
  OURO_OLLAMA_URL   upstream Ollama base (default http://127.0.0.1:11434)
  OURO_MODEL_NAME   model name to send upstream (default ouro:latest)
  BRIDGE_PORT       default 8788
  BRIDGE_MAX_TOOLS  cap tools injected into the prompt (default 8, keeps context small)
"""
import json
import os
import re
import sys
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OLLAMA = os.environ.get("OURO_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL_NAME = os.environ.get("OURO_MODEL_NAME", "ouro:latest")
PORT = int(os.environ.get("BRIDGE_PORT", "8788"))
MAX_TOOLS = int(os.environ.get("BRIDGE_MAX_TOOLS", "8"))


def log(*a):
    print("[bridge]", *a, file=sys.stdout, flush=True)


# ---------------------------------------------------------------- content flatten
def _text_from_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for b in content:
        if not isinstance(b, dict):
            out.append(str(b)); continue
        t = b.get("type")
        if t == "text":
            out.append(b.get("text", ""))
        elif t == "tool_result":
            inner = b.get("content", "")
            out.append(f"[tool_result {b.get('tool_use_id','')}]\n{_text_from_content(inner)}")
        elif t == "tool_use":
            out.append(f"<tool_call>{json.dumps({'name': b.get('name',''), 'input': b.get('input', {})})}</tool_call>")
        # images dropped
    return "\n".join(x for x in out if x)


# ---------------------------------------------------------------- tool injection
def _render_tools(tools):
    """Anthropic tools[] -> a compact, copyable system preamble (single-line format)."""
    lines = [
        "You can use tools. To answer the user directly, reply in plain text.",
        "When you need a tool, respond with EXACTLY ONE tool call on a SINGLE LINE, "
        "nothing else, in this exact format (no code fences, no blank lines):",
        '<tool_call>{"name": "TOOL_NAME", "input": {"ARG": "VALUE"}}</tool_call>',
        'Rules: "name" must be one of the tools below, spelled exactly. "input" is a '
        'JSON object of arguments (use {} if none). Double quotes only, no trailing commas. '
        "Emit the call and STOP; do not explain it. Only call a tool if needed.",
        "",
        "Available tools:",
    ]
    for t in tools[:MAX_TOOLS]:
        name = t.get("name", "")
        desc = re.sub(r"\s+", " ", (t.get("description") or "")).strip()[:300]
        schema = json.dumps(t.get("input_schema", {}), separators=(",", ":"))
        req = (t.get("input_schema", {}) or {}).get("required", [])
        example_input = {k: "..." for k in req[:2]} if req else {}
        ex = json.dumps({"name": name, "input": example_input})
        lines.append(f"Tool: {name}")
        lines.append(f"Description: {desc}")
        lines.append(f"Input (JSON schema): {schema}")
        lines.append(f"Example: <tool_call>{ex}</tool_call>")
    lines.append("")
    lines.append("Remember: plain text OR exactly one single-line <tool_call>...</tool_call>. Never both.")
    return "\n".join(lines)


def _to_ollama_messages(body):
    msgs = []
    system = body.get("system")
    if isinstance(system, list):
        system = "\n".join(_text_from_content([s]) if isinstance(s, dict) else str(s) for s in system)
    system = system or ""
    tools = body.get("tools") or []
    if tools:
        preamble = _render_tools(tools)
        system = (preamble + "\n\n" + system).strip() if system else preamble
    if system:
        msgs.append({"role": "system", "content": system})
    for m in body.get("messages", []):
        msgs.append({"role": m.get("role", "user"), "content": _text_from_content(m.get("content", ""))})
    return msgs


# ---------------------------------------------------------------- tool-call parse
def parse_tool_call(text):
    """Free-text reply -> {"name","input"} or None (normal answer). Std lib only.
    Tolerant of missing closing tag, prose, single quotes, trailing commas, truncation."""
    if not text or not isinstance(text, str):
        return None
    candidate = None
    m = re.search(r"<\s*tool_call\s*>", text, re.IGNORECASE)
    if m:
        rest = text[m.end():]
        close = re.search(r"<\s*/\s*tool_call\s*>", rest, re.IGNORECASE)
        if close:
            rest = rest[:close.start()]
        candidate = _extract_first_json_object(rest)
    if candidate is None:
        for obj_str in _iter_json_objects(text):
            if '"name"' in obj_str or "'name'" in obj_str or '"input"' in obj_str:
                candidate = obj_str
                break
    if candidate is None:
        return None
    parsed = _loads_lenient(candidate)
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    tool_input = parsed.get("input")
    if not isinstance(tool_input, dict):
        for alt in ("arguments", "parameters", "args"):
            if isinstance(parsed.get(alt), dict):
                tool_input = parsed[alt]; break
        else:
            tool_input = {}
    return {"name": name.strip(), "input": tool_input}


def _extract_first_json_object(s):
    start = s.find("{")
    if start == -1:
        return None
    depth = 0; in_str = False; esc = False; quote = ""
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == quote: in_str = False
            continue
        if c in ('"', "'"): in_str = True; quote = c
        elif c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    return s[start:]


def _iter_json_objects(s):
    idx = 0; n = len(s)
    while idx < n:
        start = s.find("{", idx)
        if start == -1:
            return
        chunk = _extract_first_json_object(s[start:])
        if chunk is None:
            return
        yield chunk
        idx = start + max(len(chunk), 1)


def _loads_lenient(raw):
    if raw is None:
        return None
    raw = raw.strip()
    try:
        return json.loads(raw)
    except Exception:
        pass
    repaired = re.sub(r",\s*([}\]])", r"\1", raw)
    try:
        return json.loads(repaired)
    except Exception:
        pass
    converted = _fix_bad_escapes(_single_to_double_quotes(repaired))
    try:
        return json.loads(converted)
    except Exception:
        pass
    balanced = re.sub(r",\s*([}\]])", r"\1", _balance_brackets(converted))
    try:
        return json.loads(balanced)
    except Exception:
        return None


def _fix_bad_escapes(s):
    """Double any backslash inside a JSON string that isn't a valid escape, so
    weak-model output like {"pattern":"*\\.py"} or a single-backslash Windows path
    parses instead of raising 'invalid \\escape'. String-aware; preserves \\n \\t \\" \\\\ \\uXXXX."""
    out = []; in_str = False; quote = ""; i = 0; n = len(s)
    while i < n:
        c = s[i]
        if not in_str:
            if c in ('"', "'"):
                in_str = True; quote = c
            out.append(c); i += 1; continue
        if c == "\\":
            nxt = s[i + 1] if i + 1 < n else ""
            if nxt in '"\\/bfnrtu':
                out.append(c)
                if nxt:
                    out.append(nxt); i += 2
                else:
                    i += 1
                continue
            out.append("\\\\"); i += 1; continue  # invalid escape -> literal backslash
        if c == quote:
            in_str = False
        out.append(c); i += 1
    return "".join(out)


def _single_to_double_quotes(s):
    out = []; in_dq = False; in_sq = False; esc = False
    for c in s:
        if in_dq:
            out.append(c)
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_dq = False
            continue
        if in_sq:
            if esc: esc = False; out.append(c)
            elif c == "\\": esc = True; out.append(c)
            elif c == "'": in_sq = False; out.append('"')
            elif c == '"': out.append('\\"')
            else: out.append(c)
            continue
        if c == '"': in_dq = True; out.append(c)
        elif c == "'": in_sq = True; out.append('"')
        else: out.append(c)
    if in_sq:
        out.append('"')
    return "".join(out)


def _balance_brackets(s):
    stack = []; in_str = False; esc = False
    for c in s:
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
            continue
        if c == '"': in_str = True
        elif c in "{[": stack.append(c)
        elif c == "}":
            if stack and stack[-1] == "{": stack.pop()
        elif c == "]":
            if stack and stack[-1] == "[": stack.pop()
    tail = s
    if in_str: tail += '"'
    for opener in reversed(stack):
        tail += "}" if opener == "{" else "]"
    return tail


# ---------------------------------------------------------------- upstream call
def _ouro_complete(messages, max_tok):
    payload = json.dumps({
        "model": MODEL_NAME, "messages": messages, "stream": False,
        "options": {"num_predict": min(max_tok, 1024)},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = json.loads(r.read().decode())
    return (data.get("message") or {}).get("content", "") or data.get("response", "")


def _build_raw_prompt(messages, prefill):
    """Mirror ouro_serve._prompt_from_messages but end with a prefill we control,
    so we can FORCE a tool call (tool_choice any/tool) by seeding '<tool_call>...'."""
    parts = []
    for m in messages:
        role, content = m.get("role", ""), m.get("content", "")
        if role == "system":
            parts.append(content)
        elif role == "user":
            parts.append(f"### Instruction:\n{content}")
        elif role == "assistant":
            parts.append(f"### Response:\n{content}")
    return ("\n\n".join(parts) if parts else "") + "\n\n### Response:\n" + prefill


def _ouro_generate(prompt, max_tok):
    payload = json.dumps({
        "model": MODEL_NAME, "prompt": prompt, "stream": False,
        "options": {"num_predict": min(max_tok, 512)},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/generate", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = json.loads(r.read().decode())
    return data.get("response", "")


def _approx_tokens(body):
    chars = len(json.dumps(body.get("messages", []))) + len(json.dumps(body.get("system", "")))
    return max(1, chars // 4)


# ---------------------------------------------------------------- HTTP server
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _sse(self, event, data):
        self.wfile.write(f"event: {event}\n".encode())
        self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._send_json({"data": [{"id": MODEL_NAME, "type": "model",
                                              "display_name": "Σ₀ Ouro Coder"}]})
        return self._send_json({"status": "ok"})

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(ln) or b"{}")
        except Exception:
            return self._send_json({"type": "error", "error": {"type": "invalid_request_error",
                                                               "message": "bad json"}}, 400)

        if self.path.startswith("/v1/messages/count_tokens"):
            return self._send_json({"input_tokens": _approx_tokens(body)})
        if not self.path.startswith("/v1/messages"):
            return self._send_json({"type": "error", "error": {"type": "not_found_error",
                                                               "message": self.path}}, 404)

        tool_names = {t.get("name") for t in (body.get("tools") or []) if t.get("name")}
        messages = _to_ollama_messages(body)
        max_tok = int(body.get("max_tokens", 512))
        stream = bool(body.get("stream", False))
        in_tok = _approx_tokens(body)

        # Forced tool calling: tool_choice {type:any} or {type:tool,name:X}. The Σ₀
        # coder won't *spontaneously* emit a tool call (no tool training), but it will
        # COMPLETE one when handed the scaffold — so we prefill '<tool_call>' (or a
        # specific tool) via /api/generate and parse what it fills in.
        choice = body.get("tool_choice") or {}
        forced = tool_names and isinstance(choice, dict) and choice.get("type") in ("any", "tool")

        try:
            if forced:
                if choice.get("type") == "tool" and choice.get("name"):
                    prefill = '<tool_call>{"name": "%s", "input": ' % choice["name"]
                else:
                    prefill = "<tool_call>"
                raw = _build_raw_prompt(messages, prefill)
                completion = _ouro_generate(raw, max_tok)
                text = prefill + completion
            else:
                text = _ouro_complete(messages, max_tok)
        except Exception as e:
            text = f"[bridge upstream error: {e}]"

        tc = parse_tool_call(text) if tool_names else None
        # In auto mode, an unknown tool name is noise -> fall back to text (CC-safe).
        # In FORCED mode the caller wants a tool, so surface it and let them validate/correct.
        if tc and tc["name"] not in tool_names and not forced:
            log(f"parsed tool call to UNKNOWN tool {tc['name']!r} (not in {sorted(tool_names)}); "
                f"falling back to text")
            tc = None
        if tc:
            log(f"TOOL_USE -> {tc['name']} input={json.dumps(tc['input'])[:200]}")
        else:
            log(f"TEXT ({len(text)} chars){' [tools offered: '+str(len(tool_names))+']' if tool_names else ''}")

        msg_id = "msg_" + uuid.uuid4().hex[:24]
        model_id = body.get("model", MODEL_NAME)

        if not stream:
            if tc:
                tool_use = {"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:24],
                            "name": tc["name"], "input": tc["input"]}
                return self._send_json({
                    "id": msg_id, "type": "message", "role": "assistant", "model": model_id,
                    "content": [tool_use], "stop_reason": "tool_use", "stop_sequence": None,
                    "usage": {"input_tokens": in_tok, "output_tokens": max(1, len(text) // 4)},
                })
            return self._send_json({
                "id": msg_id, "type": "message", "role": "assistant", "model": model_id,
                "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": in_tok, "output_tokens": max(1, len(text) // 4)},
            })

        # streaming
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        meta = {"id": msg_id, "type": "message", "role": "assistant", "model": model_id,
                "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": in_tok, "output_tokens": 0}}
        self._sse("message_start", {"type": "message_start", "message": meta})
        if tc:
            self._sse("content_block_start", {"type": "content_block_start", "index": 0,
                      "content_block": {"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:24],
                                        "name": tc["name"], "input": {}}})
            self._sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                      "delta": {"type": "input_json_delta", "partial_json": json.dumps(tc["input"])}})
            self._sse("content_block_stop", {"type": "content_block_stop", "index": 0})
            self._sse("message_delta", {"type": "message_delta",
                      "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                      "usage": {"output_tokens": max(1, len(text) // 4)}})
        else:
            self._sse("content_block_start", {"type": "content_block_start", "index": 0,
                      "content_block": {"type": "text", "text": ""}})
            self._sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                      "delta": {"type": "text_delta", "text": text}})
            self._sse("content_block_stop", {"type": "content_block_stop", "index": 0})
            self._sse("message_delta", {"type": "message_delta",
                      "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                      "usage": {"output_tokens": max(1, len(text) // 4)}})
        self._sse("message_stop", {"type": "message_stop"})


if __name__ == "__main__":
    log(f"Anthropic /v1/messages (+tools) -> {OLLAMA} (model {MODEL_NAME}) on :{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
