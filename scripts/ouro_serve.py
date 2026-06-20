"""
Ouro server — runs the real Ouro LoopLM (weight-tied recurrent transformer with
adaptive depth) locally and speaks the **Ollama HTTP API**, so Lantern OS's
existing chat path works unchanged with NO Ollama binary. This replaces Ollama
for local inference.

Endpoints (Ollama-compatible):
  GET  /api/tags        list the served model
  GET  /api/version
  POST /api/chat        {model, messages, stream}  -> NDJSON stream or single JSON
  POST /api/generate    {model, prompt, stream}

Config (env):
  OURO_MODEL     HF id or local path (default ByteDance/Ouro-1.4B-Thinking)
  OURO_ADAPTER   optional LoRA adapter dir (our Claude-session tune) — applied if set
  OURO_PORT      default 11434 (drop-in for Ollama; stop the Ollama binary first)
  OURO_UT_STEPS  recurrent steps override (else model default)
  HF_HOME        default D:/hf-cache

Run:  .venv-train/Scripts/python scripts/ouro_serve.py
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer  # noqa: E402

MODEL_ID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
ADAPTER = os.environ.get("OURO_ADAPTER", "")
PORT = int(os.environ.get("OURO_PORT", "11434"))
MODEL_NAME = "ouro:latest"  # what the Ollama API advertises
# #811: gate on model name — only answer models Ouro can serve. Legacy persona names
# (lantern-csf-dream, lantern-convergance, lantern-pcsf) are listed as aliases so
# existing .env files or requests using the old Ollama model names still hit Ouro
# rather than falling through to cloud. Extend further via OURO_MODEL_ALIASES (comma-sep).
_SERVED_MODELS = {
    "ouro:latest", "ouro-1.4b",
    "lantern-sigma0-coder", "lantern-sigma0-coder-v2", "lantern-sigma0-coder-loop",
    # legacy persona names (Ollama sunset — all surfaces now served by Ouro)
    "lantern-csf-dream", "lantern-convergance", "lantern-pcsf",
}.union(set(filter(None, os.environ.get("OURO_MODEL_ALIASES", "").split(","))))
# Serving mode. Product DEFAULT = fast cached generate (Ouro's UniversalTransformerCache).
# The native Σ₀ adaptive Q-exit loop is a no-cache research/"deep" mode — opt in with
# OURO_NATIVE=1. It is far slower (~1 s/token) so it is NOT the chat default.
NATIVE = os.environ.get("OURO_NATIVE", "0") == "1"
NATIVE_Q = float(os.environ.get("OURO_Q", "0.5"))
NATIVE_MAX = int(os.environ.get("OURO_NATIVE_MAX", "80"))
# Decode quality (both paths): repetition penalty + no-repeat n-gram kill the small-model
# degeneration (e.g. "✅✅✅…"). Greedy by default for reproducibility; set OURO_SAMPLE=1 for chat-natural sampling.
REP_PENALTY = float(os.environ.get("OURO_REP_PENALTY", "1.3"))
NO_REPEAT_NGRAM = int(os.environ.get("OURO_NO_REPEAT_NGRAM", "3"))
DO_SAMPLE = os.environ.get("OURO_SAMPLE", "0") == "1"
TEMPERATURE = float(os.environ.get("OURO_TEMPERATURE", "0.7"))
TOP_P = float(os.environ.get("OURO_TOP_P", "0.9"))

# Speed levers (measured on the leaderboard): merge the LoRA into the base (kills
# per-forward LoRA matmuls) and pick the attention kernel. Merge+SDPA measured ~2.8×
# faster (65.8s -> 23.7s avg/prompt) at equal accuracy on RTX 3070 8GB (#775).
# Defaults: SDPA on unconditionally; merge on by default when an adapter is configured.
MERGE = os.environ.get("OURO_MERGE", "1") == "1"   # was "0" — safe: gated at :69-75 behind ADAPTER check
ATTN = os.environ.get("OURO_ATTN", "sdpa")         # was "" — safe: try/except fallback at :62-67

print(f"[ouro] loading {MODEL_ID} (cuda={torch.cuda.is_available()})…", flush=True)
_tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
_load_kw = dict(trust_remote_code=True, dtype=torch.float16, device_map="auto")
if ATTN:
    _load_kw["attn_implementation"] = ATTN
try:
    _model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **_load_kw)
except (ValueError, TypeError) as e:
    print(f"[ouro] attn_implementation={ATTN!r} unsupported ({e}); retrying default", flush=True)
    _load_kw.pop("attn_implementation", None)
    _model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **_load_kw)
print(f"[ouro] attention: {getattr(_model.config, '_attn_implementation', '?')}", flush=True)
if ADAPTER:
    from peft import PeftModel
    _model = PeftModel.from_pretrained(_model, ADAPTER)
    print(f"[ouro] LoRA adapter applied: {ADAPTER}", flush=True)
    if MERGE:
        _model = _model.merge_and_unload()
        print("[ouro] LoRA merged into base (merge_and_unload)", flush=True)
_steps = os.environ.get("OURO_UT_STEPS")
if _steps:
    for attr in ("total_ut_steps", "num_recurrent_steps"):
        if hasattr(_model.config, attr):
            setattr(_model.config, attr, int(_steps))
_model.eval()

# Wrap the already-loaded model in the native Σ₀ Q-exit loop (no second load).
_loop = None
if NATIVE:
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
    from sigma0.loop_lm import Sigma0LoopLM
    _bb = _model.get_base_model() if hasattr(_model, "get_base_model") else _model
    _steps_n = int(getattr(_bb.config, "total_ut_steps", 4) or 4)
    _loop = Sigma0LoopLM(model=_model, tok=_tok, max_steps=_steps_n)
    print(f"[ouro] native Sigma0 adaptive Q-exit loop ON (q={NATIVE_Q}, max_steps={_steps_n})", flush=True)

print(f"[ouro] ready on :{PORT} as '{MODEL_NAME}' (native={NATIVE})", flush=True)


def _prompt_from_messages(messages):
    # #810: use the QLoRA training template byte-exactly — apply_chat_template adds
    # special tokens that misalign with the "### Instruction / ### Response" training
    # format and cost ~11pts accuracy (served 0.23 vs raw 0.34 on HumanEval).
    parts = []
    for m in messages:
        role, content = m.get("role", ""), m.get("content", "")
        if role == "system":
            parts.append(content)
        elif role == "user":
            parts.append(f"### Instruction:\n{content}")
        elif role == "assistant":
            parts.append(f"### Response:\n{content}")
    return ("\n\n".join(parts) if parts else "") + "\n\n### Response:\n"


def _persist_loop_meta(out: dict) -> None:
    """Append DEEP-mode realized depth + contraction to the eval leaderboard (#777)."""
    try:
        import pathlib
        lb = pathlib.Path(__file__).resolve().parents[1] / "data" / "eval" / "leaderboard.jsonl"
        lb.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "benchmark": "ouro-deep",
            "ts": str(int(time.time())),
            "mode": out.get("mode", "qexit"),
            "mean_depth": out.get("mean_depth"),
            "exit_reason": out.get("exit_reason"),
            "tokens": out.get("tokens"),
            "q": NATIVE_Q,
            "mean_contraction": out.get("mean_contraction"),
        }
        with lb.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except Exception:
        pass  # never crash the serving path over telemetry


def _generate(prompt, max_new_tokens=512, stream_cb=None):
    # Native Σ₀ adaptive loop: one-shot (no token streamer); emit whole text.
    if _loop is not None:
        out = _loop.generate(prompt, q=NATIVE_Q, max_new_tokens=min(max_new_tokens, NATIVE_MAX))
        text = out["text"]
        _persist_loop_meta(out)  # #777: persist depth/contraction to leaderboard
        if stream_cb is not None and text:
            stream_cb(text)
        return text, out  # also return meta for x-ouro-depth header
    ids = _tok(prompt, return_tensors="pt").to(_model.device)
    # #774/fix-5: stop-strings cut 15-40% of tokens on coding tasks (HumanEval proves
    # the pattern); tokenizer= is required for stop_strings support in transformers.
    _STOP = ["\ndef ", "\nclass ", "\nif __name__", "\n\n\n", "\n```"]
    kw = dict(max_new_tokens=max_new_tokens, pad_token_id=_tok.eos_token_id,
              repetition_penalty=REP_PENALTY, no_repeat_ngram_size=NO_REPEAT_NGRAM,
              do_sample=DO_SAMPLE, stop_strings=_STOP, tokenizer=_tok)
    if DO_SAMPLE:
        kw.update(temperature=TEMPERATURE, top_p=TOP_P)
    if stream_cb is None:
        with torch.no_grad():
            out = _model.generate(**ids, **kw)
        return _tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True), None
    streamer = TextIteratorStreamer(_tok, skip_prompt=True, skip_special_tokens=True)
    th = threading.Thread(target=lambda: _model.generate(**ids, streamer=streamer, **kw))
    th.start()
    full = []
    for piece in streamer:
        full.append(piece)
        stream_cb(piece)
    th.join()
    return "".join(full), None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/tags"):
            return self._json({"models": [{"name": MODEL_NAME, "model": MODEL_NAME,
                "details": {"family": "ouro-looplm", "parameter_size": "1.4B"}}]})
        if self.path.startswith("/api/version"):
            return self._json({"version": "ouro-shim-0.1"})
        if self.path in ("/", "/api/health"):
            return self._json({"status": "ok", "model": MODEL_ID})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(ln) or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)
        # #811: gate on model name — only answer coding/ouro models; 404 for dream/pcsf/
        # convergance so the Lantern provider chain falls back to cloud for those surfaces.
        req_model = (body.get("model") or "").lower().strip()
        if req_model and req_model not in _SERVED_MODELS:
            return self._json({"error": f"model not found: {body.get('model')}"}, 404)
        is_chat = self.path.startswith("/api/chat")
        prompt = _prompt_from_messages(body.get("messages", [])) if is_chat else body.get("prompt", "")
        stream = body.get("stream", True)
        max_tok = int((body.get("options") or {}).get("num_predict", 512))

        def pack(content, done):
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            return (json.dumps({"model": MODEL_NAME, "created_at": now,
                **({"message": {"role": "assistant", "content": content}} if is_chat else {"response": content}),
                "done": done}) + "\n").encode()

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            try:
                _generate(prompt, max_tok, stream_cb=lambda p: (self.wfile.write(pack(p, False)), self.wfile.flush()))
                self.wfile.write(pack("", True)); self.wfile.flush()
            except Exception as e:
                try: self.wfile.write(pack(f"[ouro error: {e}]", True))
                except Exception: pass
        else:
            try:
                text, loop_meta = _generate(prompt, max_tok)
                b = json.dumps(json.loads(pack(text, True).decode())).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                if loop_meta:
                    # #777: expose realized DEEP-mode depth in response header
                    depth_str = json.dumps({k: loop_meta.get(k) for k in
                                            ("mean_depth", "exit_reason", "mean_contraction")
                                            if loop_meta.get(k) is not None})
                    self.send_header("x-ouro-depth", depth_str)
                self.end_headers()
                self.wfile.write(b)
            except Exception as e:
                self._json({"error": str(e)}, 500)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
