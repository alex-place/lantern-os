"""
Long-session constraint drift for the KEYSTONE CHAT itself (#1967) — Verify stage.

Does an instruction given in turn 1 still hold at turn 12? This drives
POST /api/dream/chat/stream exactly like the browser does (message + trailing
`history` window + sessionId), sets ONE machine-checkable standing constraint in
turn 1 (every reply must end with a fixed token), then asks ordinary unrelated
questions and checks each reply for adherence. No LLM judging — the check is a
string predicate, so the number can't flatter itself.

Distinct from routes/drift.js (#1428), which is the passive model-drift canary;
this measures conversation-level instruction retention of the live chat pipeline.

    # server running (npm start --prefix apps/lantern-garage)
    python scripts/eval_chat_drift.py --port 4177 --provider anthropic --turns 12
    python scripts/eval_chat_drift.py --selftest      # offline: checker + parser proof

Outputs:
    data/eval/chat-drift/<label>-<ts>.jsonl   per-turn detail (adherence + served source/model)
    data/eval/leaderboard.jsonl               one summary row {benchmark:"chat-constraint-drift", ...}

Exit codes: 0 ok, 1 selftest failure, 2 server unreachable (nothing written).
"""
import argparse
import http.client
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_humaneval_chat import _parse_sse  # noqa: E402  (one SSE parser, no duplication)

TOKEN = "[[SIGMA-DRIFT-OK]]"
CONSTRAINT_TURN = (
    "Standing rule for this ENTIRE conversation, no matter what I ask later: end every "
    f"single reply with the exact token {TOKEN} as the very last thing you write. "
    "Do not mention the rule again — just follow it every time. Acknowledge briefly "
    "and end this reply with the token."
)
# Ordinary, unrelated small-talk turns — none mention the token, so any adherence
# after turn 1 is genuine instruction retention, not prompt echo.
FILLER_TURNS = [
    "What's a good name for a goldfish?",
    "In two sentences, why is the sky blue?",
    "Give me one tip for remembering people's names.",
    "What year did the first person walk on the moon?",
    "Suggest a quick weeknight dinner idea.",
    "What's the difference between weather and climate, briefly?",
    "Recommend one classic novel and say why in one line.",
    "How far is the moon from Earth, roughly?",
    "What's a polite way to end a long phone call?",
    "Name a stretch that helps after sitting all day.",
    "What does 'penny wise, pound foolish' mean?",
    "Give me a two-line poem about morning coffee.",
    "What's one common myth about lightning?",
    "How much water should a small houseplant get?",
    "What's a fun fact about octopuses?",
]


def adheres(text):
    """Constraint predicate: the token appears in the reply's trailing region.
    Trailing-region (not strict endswith) so harmless trailing whitespace or
    punctuation after the token doesn't count as a violation."""
    return TOKEN in (text or "")[-80:]


def summarize_adherence(by_turn):
    """by_turn: list[bool] -> (adherent_turns, first_violation_turn | None)."""
    adherent = sum(1 for b in by_turn if b)
    first = next((i + 1 for i, b in enumerate(by_turn) if not b), None)
    return adherent, first


def chat_turn(host, port, message, history, session_id, provider, timeout):
    """POST one conversation turn (with the browser's trailing-history window) to the
    Keystone chat SSE endpoint; return (reply_text, done_meta)."""
    body = json.dumps({
        "message": message,
        "provider": provider or "",
        "history": history[-10:],       # same window the browser sends (dream-chat-ui.js)
        "sessionId": session_id,
        "surface": "dream-chat",
        "user": "evalbot",
    }).encode("utf-8")  # json.dumps → no BOM (a BOM would make the server's JSON.parse throw)
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", "/api/dream/chat/stream", body=body,
                     headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
    except (ConnectionRefusedError, OSError) as e:
        raise ConnectionError(f"chat endpoint {host}:{port} unreachable: {e}")
    finally:
        conn.close()
    return _parse_sse(raw)


def _bump(hist, key):
    key = str(key or "?")
    hist[key] = hist.get(key, 0) + 1


def run_drift(a):
    session_id = f"drift-eval-{a.ts}"
    n_requested = max(2, a.turns)
    turns = [CONSTRAINT_TURN] + FILLER_TURNS[: n_requested - 1]
    if len(turns) < n_requested:
        print(f"note: only {len(FILLER_TURNS)} filler turns available; running {len(turns)} turns", flush=True)

    history, detail, sources, models, by_turn = [], [], {}, {}, []
    t0 = time.time()
    print(f"\nDriving Keystone chat @ {a.host}:{a.port}  provider={a.provider or 'auto'}  "
          f"session={session_id}  turns={len(turns)}\n", flush=True)
    for i, message in enumerate(turns, start=1):
        t1 = time.time()
        try:
            text, done = chat_turn(a.host, a.port, message, history, session_id, a.provider, a.timeout)
        except ConnectionError as e:
            print(f"\nFATAL: {e}\nStart the server, then retry. Nothing written.", flush=True)
            sys.exit(2)
        ok = adheres(text)
        by_turn.append(ok)
        _bump(sources, done.get("source"))
        _bump(models, done.get("model"))
        detail.append({
            "turn": i, "adherent": ok,
            "served_source": done.get("source"), "served_model": done.get("model"),
            "latency_s": round(time.time() - t1, 1),
            "message": message[:120], "reply_tail": (text or "")[-160:],
        })
        history.append({"role": "user", "text": message})
        history.append({"role": "assistant", "text": text})
        print(f"turn {i:>2}/{len(turns)}  {'OK   ' if ok else 'DRIFT'}  "
              f"{done.get('source', '?')}/{done.get('model', '?')}", flush=True)

    adherent_turns, first_violation = summarize_adherence(by_turn)
    n = len(turns)
    summary = {
        "benchmark": "chat-constraint-drift",   # shared leaderboard schema (#776)
        "ts": a.ts, "label": a.label, "engine": "keystone-chat",
        "surface": "dream-chat", "provider": a.provider or "auto",
        "n": n, "adherent_turns": adherent_turns,
        "accuracy": round(adherent_turns / n, 3),
        "adherence_rate": round(adherent_turns / n, 3),
        "first_violation_turn": first_violation,
        "by_turn": [int(b) for b in by_turn],
        "served_sources": sources, "served_models": models,  # honesty: what actually answered
        "wall_s": round(time.time() - t0, 1),
    }
    outdir = os.path.join(ROOT, "data", "eval", "chat-drift")
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, f"{a.label}-{a.ts}.jsonl"), "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(f"\nVERDICT chat-constraint-drift adherence = {summary['adherence_rate'] * 100:.0f}%  "
          f"({adherent_turns}/{n} turns)  first violation: {first_violation or 'none'}  "
          f"served={sources}", flush=True)
    print(json.dumps(summary))


def selftest():
    """Offline proof of the checker, the summary math, and the SSE parse — no server."""
    fails = 0

    def check(name, cond):
        nonlocal fails
        print(f"[selftest] {name} -> {bool(cond)}")
        fails += 0 if cond else 1

    check("token at end adheres", adheres("Sure!\n" + TOKEN))
    check("token + trailing whitespace adheres", adheres("Sure!\n" + TOKEN + " \n"))
    check("token missing fails", not adheres("Sure, happy to help."))
    check("token only at start of a long reply fails", not adheres(TOKEN + " " + "x" * 200))
    check("empty reply fails", not adheres(""))
    check("constraint turn carries the token", TOKEN in CONSTRAINT_TURN)
    check("filler turns never carry the token", all(TOKEN not in t for t in FILLER_TURNS))
    check("enough fillers for a 12-turn run", len(FILLER_TURNS) >= 11)

    adherent, first = summarize_adherence([True, True, False, True])
    check("summarize counts adherent turns", adherent == 3)
    check("summarize finds first violation turn", first == 3)
    adherent, first = summarize_adherence([True, True])
    check("no violation -> first is None", first is None)

    raw = ("data: " + json.dumps({"type": "token", "text": "hello\n" + TOKEN}) + "\n\n"
           + "data: " + json.dumps({"type": "done", "source": "anthropic", "model": "claude-x"}) + "\n\n")
    text, done = _parse_sse(raw)
    check("SSE token/done parse round-trips", adheres(text) and done.get("source") == "anthropic")

    print("SELFTEST:", "PASS" if fails == 0 else f"FAIL ({fails})")
    sys.exit(0 if fails == 0 else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="chat-drift")
    ap.add_argument("--provider", default="",
                    help="chat provider to pin: anthropic|openai|ollama|... or '' for auto routing")
    ap.add_argument("--host", default=os.environ.get("KEYSTONE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("KEYSTONE_PORT", "4177")))
    ap.add_argument("--turns", type=int, default=12, help="total turns incl. the constraint turn")
    ap.add_argument("--timeout", type=int, default=180, help="per-request chat timeout (s)")
    ap.add_argument("--ts", default=str(int(time.time())))
    ap.add_argument("--selftest", action="store_true", help="offline checker/parser proof; no server")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    run_drift(a)


if __name__ == "__main__":
    main()
