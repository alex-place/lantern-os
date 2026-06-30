#!/usr/bin/env python3
"""Ollama-compatible serving wrapper for keystone-sigma0-plt.

Exposes `GET /api/tags` and `POST /api/chat` so the Keystone chat (which calls
`OLLAMA_BASE_URL/api/chat`, see apps/lantern-garage/lib/dream-chat.js) can reach
the PLT model as a drop-in local backend. It is a BLACK BOX over
`from_pretrained` + `generate` — robust to any forward-internal change Colab
parity might require.

GATED — this only makes the model *reachable*. Per ADR-0011 / #1597 it must stay
`verified:false` in local-model-registry.js (it cannot LEAD) until faithful
parity + an eval win. There is no KV cache yet (full-recompute decode), so it is
SLOW; interactive chat use waits on the Stage-2 KV-cache follow-up. This wrapper
is the plumbing, deliberately off by default.

    python serve_keystone_plt.py --model D:/keystone-sigma0-ckpt --port 11435 --dtype 4bit
    # then point the chat at it (the one-flag swap, once parity is green):
    #   OLLAMA_BASE_URL=http://127.0.0.1:11435   OLLAMA_MODEL=keystone-sigma0-plt

Optional `--logprobs` makes /api/chat also return per-token surprise (−log2 p) —
the "leak" handle (docs/research/2026-06-30-pumped-lossy-resonator.md). The chat
does not consume it yet; that wiring is a separate, later step.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

MODEL_NAME = "keystone-sigma0-plt"
_TOK = None
_MODEL = None
_LOGPROBS = False


def _load(model_dir: str, dtype: str):
    global _TOK, _MODEL
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    kw = {"trust_remote_code": True}
    if dtype == "4bit":
        from transformers import BitsAndBytesConfig
        kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
        kw["device_map"] = "cuda:0"
    else:
        kw["torch_dtype"] = torch.bfloat16 if dtype == "bf16" else torch.float16
        kw["device_map"] = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"[serve] loading {model_dir} ({dtype}) …", flush=True)
    t0 = time.time()
    _TOK = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)
    _MODEL = AutoModelForCausalLM.from_pretrained(model_dir, **kw).eval()
    print(f"[serve] ready in {time.time()-t0:.0f}s — {MODEL_NAME} on /api/chat", flush=True)


def _prompt_from_messages(messages):
    """Use the tokenizer chat template when present; else a simple role concat."""
    try:
        return _TOK.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        parts = []
        for m in messages or []:
            parts.append(f"{m.get('role','user')}: {m.get('content','')}")
        parts.append("assistant:")
        return "\n".join(parts)


def _generate(messages, options):
    import torch
    prompt = _prompt_from_messages(messages)
    ids = _TOK(prompt, return_tensors="pt", return_token_type_ids=False).to(_MODEL.device)
    max_new = int((options or {}).get("num_predict", 256))
    gen_kw = dict(max_new_tokens=max_new, do_sample=False)
    if _LOGPROBS:
        gen_kw.update(output_scores=True, return_dict_in_generate=True)
    with torch.no_grad():
        out = _MODEL.generate(**ids, **gen_kw)
    seq = out.sequences[0] if _LOGPROBS else out[0]
    new = seq[ids["input_ids"].shape[-1]:]
    text = _TOK.decode(new, skip_special_tokens=True)
    logprobs = None
    if _LOGPROBS:
        logprobs = []
        for tok_id, score in zip(new.tolist(), out.scores):
            lp = torch.log_softmax(score[0].float(), dim=-1)[tok_id].item()
            logprobs.append({"token": _TOK.decode([tok_id]), "logprob": lp,
                             "bits": round(-lp / math.log(2), 4)})
    return text.strip(), logprobs


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/api/tags":
            self._send(200, {"models": [{
                "name": MODEL_NAME, "model": MODEL_NAME,
                "modified_at": "2026-06-30T00:00:00Z", "size": 0,
                "details": {"family": "keystone_plt", "parameter_size": "7.6B"},
            }]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        if self.path.rstrip("/") != "/api/chat":
            return self._send(404, {"error": "not found"})
        try:
            text, logprobs = _generate(req.get("messages", []), req.get("options"))
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        resp = {
            "model": req.get("model", MODEL_NAME),
            "created_at": "2026-06-30T00:00:00Z",
            "message": {"role": "assistant", "content": text},
            "done": True,
        }
        if logprobs is not None:
            resp["logprobs"] = logprobs  # the leak handle; chat doesn't read it yet
        self._send(200, resp)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=11435)
    ap.add_argument("--dtype", default="4bit", choices=("4bit", "bf16", "fp16"))
    ap.add_argument("--logprobs", action="store_true", help="return per-token −log2p (the leak)")
    args = ap.parse_args()
    global _LOGPROBS
    _LOGPROBS = args.logprobs
    _load(args.model, args.dtype)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[serve] listening on http://127.0.0.1:{args.port}  (Ollama-compatible)", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
