"""
rho_controls.py — stress-test the ρ ≈ 1.064 claim from router_sigma0_encoder.py.

Motivation: SIGMA0-COLLAPSE-CERTIFICATE.md §6 reports "Mean Jacobian spectral radius ρ =
1.064" over a 2678-turn log and reads it as a near-boundary signature. This harness re-runs
the SAME encoder + fit functions (imported from router_sigma0_encoder, not reimplemented) on
the real corpus present in this checkout, adding the controls a spectral-radius estimate needs
before it can be trusted:

  1. real corpus (data/conversations/garage-conversations.jsonl) — the certificate's
     apps/data/conversations path is dead here, which is why the original number was not
     reproducible.
  2. window-length sweep (5..40) — is ρ stable, or does it swing with the window?
  3. per-window relative fit residual — is the linear map even a good fit?
  4. ridge regularization — does ρ>1 survive mild damping, or was it noise blow-up?
  5. non-normality ‖JJ'-J'J‖/‖J‖² — is ρ the right stability summary at all?

Finding (830-turn run, 2026-07-04): the mean is a fitting artifact. Unregularized lstsq
blows up (window-8 mean ρ = 25.0, max ≈ 16,872); the median is contracting (1.00 → 0.85 as
the window grows); any ridge pushes the mean < 1; relative residual is 0.35-0.62. And the
state is four text-surface features, not model hidden states — so this ρ is not the
certificate's α regardless. See the §6 control-check note.

Run from repo root:  python experiments/rho_controls.py
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np

try:  # Windows console is cp1252; ρ would crash on print
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parent.parent
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))  # so `import router_sigma0_encoder` resolves
import router_sigma0_encoder as enc  # tokenise, state_vector, fit_jacobian, bigrams  # noqa: E402

CONV = REPO / "data" / "conversations"


def load_real_turns():
    turns = []
    for f in sorted(CONV.glob("garage-conversations.jsonl")):  # the live log, not .bak snapshots
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                import json
                obj = json.loads(line)
            except Exception:
                continue
            msgs = obj.get("messages")
            if isinstance(msgs, list):
                for m in msgs:
                    t = m.get("text") or m.get("content") or ""
                    if t:
                        turns.append({"role": m.get("role", "?"), "text": t})
            else:
                t = obj.get("text") or obj.get("content") or obj.get("message") or ""
                if t:
                    turns.append({"role": obj.get("role", "?"), "text": t})
    return turns


def synthetic_turns(n=300):
    """Deterministic fallback so the harness runs from a clean clone (the real 830-turn
    garage log is untracked runtime data). Same sentence pool as router_sigma0_encoder,
    scaled up so the window sweep has enough points. Fixed seed → reproducible."""
    import random
    rng = random.Random(42)
    pool = [
        "The lantern flickers in the dream corridor.",
        "I keep seeing the same door repeated.",
        "There is a spiral staircase that never ends.",
        "The water reflects a face I don't recognise.",
        "Something is chasing me through a forest of mirrors.",
        "I woke up inside the dream again.",
        "The light at the end keeps moving further away.",
        "Voices repeat my own words back to me.",
        "The map shows only roads I have already walked.",
        "I ask the figure a question and it answers with my question.",
    ]
    out = []
    for i in range(n):
        text = rng.choice(pool)
        if rng.random() > 0.5:
            text += " " + rng.choice(pool)
        out.append({"role": "operator" if i % 2 == 0 else "lantern", "text": text})
    return out


def encode(turns):
    all_tokens, states = [], []
    ai_roles = {"lantern", "keystone", "assistant", "ai"}
    prior_ai = None
    for turn in turns:
        toks = enc.tokenise(turn["text"])
        prev = all_tokens[-1] if all_tokens else None
        earlier = all_tokens[:-1] if len(all_tokens) > 1 else []
        states.append(enc.state_vector(toks, prev, earlier, prior_ai))
        all_tokens.append(toks)
        if turn["role"].lower() in ai_roles:
            prior_ai = toks
    return np.array(states)


def fit_with_diag(states, ridge=0.0):
    """(J, relative_residual) for a window; plain lstsq when ridge == 0."""
    if len(states) < 5:
        return None, None
    dx = np.diff(states, axis=0)
    X, Y = dx[:-1], dx[1:]
    if X.shape[0] < 4:
        return None, None
    if ridge > 0:
        JT = np.linalg.solve(X.T @ X + ridge * np.eye(X.shape[1]), X.T @ Y)
    else:
        JT, _, _, _ = np.linalg.lstsq(X, Y, rcond=None)
    rel = float(np.linalg.norm(Y - X @ JT) / (np.linalg.norm(Y) + 1e-12))
    return JT.T, rel


def non_normality(J):
    c = J @ J.T - J.T @ J
    return float(np.linalg.norm(c) / (np.linalg.norm(J) ** 2 + 1e-12))


def sweep(states, window, ridge=0.0):
    rhos, resids, nn = [], [], []
    for i in range(len(states)):
        J, rel = fit_with_diag(states[max(0, i - window + 1): i + 1], ridge=ridge)
        if J is None:
            continue
        rhos.append(float(np.max(np.abs(np.linalg.eigvals(J)))))
        resids.append(rel)
        nn.append(non_normality(J))
    if not rhos:
        return None
    a, r = np.array(rhos), np.array(resids)
    clean = a[r < 0.5]  # windows where the linear fit actually explains the data
    return dict(window=window, ridge=ridge, n=len(a), mean=a.mean(), median=float(np.median(a)),
                mx=a.max(), f1=float((a > 1).mean()), resid=float(r.mean()),
                nclean=int(clean.size), mclean=float(clean.mean()) if clean.size else float("nan"),
                f1clean=float((clean > 1).mean()) if clean.size else float("nan"),
                nn=float(np.mean(nn)))


def main():
    turns = load_real_turns()
    if len(turns) >= 20:
        source = f"REAL corpus ({len(turns)} turns, {CONV})"
    else:
        turns = synthetic_turns()
        source = (f"SYNTHETIC ({len(turns)} turns) — the real garage log is untracked runtime "
                  f"data absent from a clean checkout; the certificate's 2678-turn corpus is "
                  f"likewise not reproducible. The controls' *pattern* is dataset-independent.")
    print(f"data source: {source}")
    states = encode(turns)
    print(f"encoded states: {states.shape}\n")
    print(f"{'win':>4}{'ridge':>8}{'n':>6}{'mean':>8}{'median':>8}{'max':>10}"
          f"{'f>1':>6}{'resid':>7}{'ncln':>6}{'mcln':>8}{'f>1cl':>7}{'nonnrm':>8}")
    for window in (5, 8, 10, 15, 20, 40):
        for ridge in (0.0, 1e-3, 1e-2):
            s = sweep(states, window, ridge)
            if s:
                print(f"{s['window']:>4}{s['ridge']:>8.0e}{s['n']:>6}{s['mean']:>8.3f}"
                      f"{s['median']:>8.3f}{s['mx']:>10.2f}{s['f1']:>6.2f}{s['resid']:>7.2f}"
                      f"{s['nclean']:>6}{s['mclean']:>8.3f}{s['f1clean']:>7.2f}{s['nn']:>8.3f}")


if __name__ == "__main__":
    main()
