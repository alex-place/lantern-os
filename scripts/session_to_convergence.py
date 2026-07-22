#!/usr/bin/env python3
"""
session_to_convergence.py — turn Claude Code session history into ConvergenceRecords.

Every session with Claude is a stream of CLAIMS the assistant made and OUTCOMES reality
returned: a tool result, a test, a grep, a user correction verified or refuted each one.
Those (claim, evidence, verified/refuted) tuples are exactly the ledger the convergence
loop calibrates and selects on — both-class, objective-labeled, source-grounded. This
mines that ledger out of session history instead of letting it evaporate.

Two modes:
  --records <file.json>   Append a pre-extracted list of records. Used for the CURRENT
                          session, whose honest labels are supplied by the Claude that
                          lived it (no second model call needed — it IS the extractor).
  --transcript <s.jsonl>  Read a Claude Code session transcript and extract records via a
                          Claude model (ANTHROPIC_API_KEY) — for PAST sessions. [--model]

Honesty discipline (the whole point — do NOT recreate the laundering this fixes):
  * verified=true ONLY when the session shows a real resolution (tool/test/grep/user).
  * refutations are KEPT (verified=false, refuted=true) — both classes, on purpose.
  * corrected=true when a record overturns an earlier claim from the same session.
  * confidence is capped by allowed_max_confidence (weak/single-method grounding -> lower).
  * provenance tagged (reasoner=claude-code-session, source cites the session, tags carry id).
  * deterministic id from (session_id, claim) -> idempotent; re-runs never double-write.

Writes JSONL to data/convergence/records.jsonl (canonical ledger; --out to override).
Schema mirrors the live ledger families (claim/hypothesis + verified/refuted/corrected +
allowed_max_confidence + grounding fields), loadable by src/convergence/objects.py.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_LEDGER = REPO / "data" / "convergence" / "records.jsonl"


def clamp01(x, default=0.5):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def rec_id(session_id: str, claim: str) -> str:
    h = hashlib.sha1(f"{session_id}\x1f{claim}".encode("utf-8")).hexdigest()[:12]
    return f"cr-sess-{h}"


def normalize(rec: dict, session_id: str) -> dict:
    """One raw extraction -> a canonical, honesty-disciplined ConvergenceRecord."""
    claim = str(rec.get("claim") or rec.get("hypothesis") or "").strip()
    if not claim:
        return None
    conf = clamp01(rec.get("confidence", 0.5))
    amc = rec.get("allowed_max_confidence")
    if amc is not None:
        amc = clamp01(amc, default=1.0)
        conf = min(conf, amc)  # grounding cap enforced (no confidence laundering)
    verified = bool(rec.get("verified", False))
    refuted = bool(rec.get("refuted", False))
    # a claim cannot be both verified-true and refuted-true
    if verified and refuted:
        verified = False
    # HARD verification artifacts (schema: ConvergenceRecord.verified_by). A checkable
    # ref anyone can re-open: "pr:2737", "commit:<sha>", "test:<path::name>", "exec:<id>".
    # Normalize bare PR numbers / "#2737" to the "pr:" form. verified=True is legitimate
    # ONLY with such an artifact — this is the concrete External Reality Rule (the
    # strongest artifact for a self-coding loop is a MERGED PR), matching objects.py.
    verified_by = []
    for a in (rec.get("verified_by") or []):
        s = str(a).strip()
        if not s:
            continue
        if s.isdigit():
            s = f"pr:{s}"
        elif s.startswith("#") and s[1:].isdigit():
            s = f"pr:{s[1:]}"
        verified_by.append(s)
    if verified and not verified_by:
        # no receipt → cannot claim reality confirmed it (foreclose laundering at the source)
        verified = False
    return {
        "id": rec_id(session_id, claim),
        "timestamp": rec.get("timestamp") or _now_iso(),
        "claim": claim,
        "hypothesis": claim,  # mirror for the emit-family readers
        "type": rec.get("type", "session_extract"),
        "evidence": str(rec.get("evidence") or ""),
        "evidence_ids": list(rec.get("evidence_ids") or []),
        "result": rec.get("result"),
        "confidence": conf,
        "allowed_max_confidence": amc,
        "verified": verified,
        "refuted": refuted,
        "corrected": bool(rec.get("corrected", False)),
        "verification_notes": rec.get("verification_notes"),
        "source": rec.get("source"),
        "sources": list(rec.get("sources") or []),
        "grounding_signals": list(rec.get("grounding_signals") or []),
        "verified_by": verified_by,  # hard, checkable artifacts (pr:/commit:/test:/exec:)
        "applied_evidence": [],  # empty at emit; Verify stage fills it (#764 G9)
        "loop_stage": rec.get("loop_stage", "Verify"),
        "reasoner": "claude-code-session",
        "agent": "claude-code",
        "tags": sorted(set(["session-extract", "claude-code", session_id] + list(rec.get("tags") or []))),
        "session_id": session_id,
    }


def existing_ids(ledger: Path) -> set:
    ids = set()
    if ledger.exists():
        for line in ledger.open(encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                ids.add(json.loads(line).get("id"))
            except json.JSONDecodeError:
                pass
    return ids


def append_records(records, ledger: Path, session_id: str, dry_run=False):
    seen = existing_ids(ledger)
    fresh, dup = [], 0
    for raw in records:
        norm = normalize(raw, session_id)
        if not norm:
            continue
        if norm["id"] in seen:
            dup += 1
            continue
        seen.add(norm["id"])
        fresh.append(norm)
    v = sum(1 for r in fresh if r["verified"])
    ref = sum(1 for r in fresh if r["refuted"])
    print(f"[session->convergence] session={session_id} new={len(fresh)} "
          f"(verified={v} refuted={ref} open={len(fresh)-v-ref}) dup-skipped={dup}")
    if dry_run:
        for r in fresh:
            flag = "VERIFIED" if r["verified"] else "REFUTED" if r["refuted"] else "open"
            print(f"  [{flag:8}] c={r['confidence']:.2f} {r['claim'][:88]}")
        return fresh
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a", encoding="utf-8") as fh:
        for r in fresh:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[session->convergence] appended {len(fresh)} -> {ledger}")
    return fresh


EXTRACT_SYSTEM = (
    "You extract ConvergenceRecords from a Claude Code session transcript. A record is a "
    "CLAIM the assistant asserted AND the OUTCOME the session actually returned for it. "
    "Return ONLY records where the transcript shows real resolution — a tool result, test, "
    "grep, file read, or user correction that verified or refuted the claim. Rules: "
    "verified=true ONLY with in-transcript proof; keep refutations (verified=false, "
    "refuted=true); corrected=true when it overturns an earlier claim in the SAME session; "
    "cap confidence by grounding strength (single-source/one-method -> allowed_max_confidence<=0.85). "
    "NEVER invent a claim or a verification. Output a JSON array of "
    "{claim, evidence, verified, refuted, corrected, confidence, allowed_max_confidence, "
    "source, loop_stage} and nothing else."
)


def extract_via_claude(transcript: Path, model: str, max_chars: int):
    try:
        import anthropic  # noqa
    except ImportError:
        sys.exit("--transcript needs the `anthropic` package (pip install anthropic).")
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("--transcript needs ANTHROPIC_API_KEY. (For the CURRENT session use --records instead.)")
    text = transcript.read_text(encoding="utf-8", errors="replace")[:max_chars]
    client = anthropic.Anthropic(api_key=key)
    msg = client.messages.create(
        model=model, max_tokens=4096, system=EXTRACT_SYSTEM,
        messages=[{"role": "user", "content": f"Transcript:\n\n{text}\n\nReturn the JSON array."}],
    )
    body = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    body = body[body.find("["): body.rfind("]") + 1]
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        sys.exit(f"model did not return valid JSON: {e}")


def main():
    ap = argparse.ArgumentParser(description="Claude Code session history -> ConvergenceRecords")
    ap.add_argument("--records", help="JSON file: list of pre-extracted records (current session)")
    ap.add_argument("--transcript", help="Claude Code session .jsonl to extract from (past session)")
    ap.add_argument("--session-id", default=None, help="provenance id (defaults to file stem)")
    ap.add_argument("--out", default=str(DEFAULT_LEDGER), help="ledger path")
    ap.add_argument("--model", default="claude-opus-4-8")
    ap.add_argument("--max-chars", type=int, default=120000)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.records and not args.transcript:
        ap.error("pass --records <json> or --transcript <session.jsonl>")

    if args.records:
        raws = json.loads(Path(args.records).read_text(encoding="utf-8"))
        sid = args.session_id or Path(args.records).stem
    else:
        raws = extract_via_claude(Path(args.transcript), args.model, args.max_chars)
        sid = args.session_id or Path(args.transcript).stem

    append_records(raws, Path(args.out), sid, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
