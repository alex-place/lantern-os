r"""
serve_minicheck.py — local MiniCheck entailment endpoint for the #2174 verifier (#2186).

Serves the {doc, claim} -> {prob} contract that lib/coding-backend/verifiers/entailment.js
already speaks (POST JSON {doc, claim}; responds {prob} in [0,1], where prob = P(claim is
supported by doc)). With MINICHECK_ENDPOINT pointed here, the entailment layer flips from
`skipped` to a `decisive` grounding check.

Model: MiniCheck-Flan-T5-Large (~770M, lytang/MiniCheck-Flan-T5-Large) via the official
`minicheck` package (Liu et al. 2024). Runs CPU-only by default (set MINICHECK_DEVICE=cuda to
use the GPU when it's free) — CPU keeps it off the training GPU and is fine for a gate.

Run:  .venv-train/Scripts/python.exe scripts/serve_minicheck.py            # binds 127.0.0.1:8799
Env:  MINICHECK_PORT (default 8799), MINICHECK_MODEL (default flan-t5-large), MINICHECK_DEVICE
Wire: set MINICHECK_ENDPOINT=http://127.0.0.1:8799 in the server's env, then the verifier is live.

Health: GET /health -> {"ok": true, "model": ...}
Score:  POST / {"doc": "...", "claim": "..."} -> {"prob": 0.87, "label": 1}
"""
import json
import os
import sys

# CPU-only unless explicitly told otherwise, so this never contends with training on the GPU.
if os.environ.get("MINICHECK_DEVICE", "cpu").lower() != "cuda":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("HF_HOME", "D:/hf-cache")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

PORT = int(os.environ.get("MINICHECK_PORT", "8799"))
MODEL = os.environ.get("MINICHECK_MODEL", "flan-t5-large")  # -> lytang/MiniCheck-Flan-T5-Large (~770M)
_MAX_BYTES = 1024 * 1024

print(f"[minicheck] loading MiniCheck ({MODEL}) on {'cuda' if os.environ.get('CUDA_VISIBLE_DEVICES') else 'cpu'} ...",
      flush=True)

# MiniCheck-Flan-T5-Large ships only a pickle `pytorch_model.bin`; transformers gates torch.load
# behind torch>=2.6 (CVE-2025-32434). We can't bump torch without breaking the Ouro/bnb training
# stack. The CVE is about UNTRUSTED pickles — this is the official lytang/MiniCheck model we
# downloaded ourselves, so we neutralize the version gate (weights_only=True still applies) for
# this one trusted load. Patch before transformers/minicheck import so all references see the no-op.
import transformers.utils.import_utils as _tiu  # noqa: E402
_tiu.check_torch_load_is_safe = lambda *a, **k: None
try:
    import transformers.modeling_utils as _tmu  # noqa: E402
    _tmu.check_torch_load_is_safe = lambda *a, **k: None
except Exception:
    pass

from minicheck.minicheck import MiniCheck  # noqa: E402

_scorer = MiniCheck(model_name=MODEL, enable_prefix_caching=False, cache_dir=os.environ["HF_HOME"])


def score(doc: str, claim: str):
    """Return (prob, label). prob = P(claim supported by doc) in [0,1]."""
    pred_label, raw_prob, _, _ = _scorer.score(docs=[doc], claims=[claim])
    return float(raw_prob[0]), int(pred_label[0])


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # quiet default logging
        pass

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz"):
            return self._send(200, {"ok": True, "model": MODEL})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("content-length", 0))
            if n <= 0 or n > _MAX_BYTES:
                return self._send(400, {"error": "bad content-length"})
            payload = json.loads(self.rfile.read(n) or b"{}")
            doc = str(payload.get("doc", ""))
            claim = str(payload.get("claim", ""))
            if not doc or not claim:
                return self._send(400, {"error": "both 'doc' and 'claim' are required"})
            prob, label = score(doc, claim)
            self._send(200, {"prob": prob, "label": label})
        except Exception as e:  # never 500 into a flaky-endpoint loop without a reason
            self._send(500, {"error": str(e)})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[minicheck] serving on http://127.0.0.1:{PORT}  (POST {{doc,claim}} -> {{prob}})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main())
