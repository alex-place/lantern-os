"""
Add a curated set of arXiv papers to the local corpus by id — the manual companion
to arxiv_harvest.py for papers OUTSIDE the harvested category/date window (e.g. the
event-/self-triggered control canon, eess.SY / math.OC, 2008+), so chat retrieval
can cite them like any harvested paper.

Metadata is fetched from arXiv's sanctioned API (export.arxiv.org/api/query) — the
caller supplies only ids, never titles/abstracts — and records are written in the
exact harvester schema via arxiv_harvest.ShardWriter (same monthly sharding, same
id-derived dating, deduped against the whole raw corpus). Optionally downloads the
PDFs to pdfs\<id>.pdf (the curated-tranche precedent).

Run (PowerShell — the sandboxed Bash tool has no network egress):
    python scripts/arxiv_add_papers.py --ids 0806.0709,1301.2182 --pdfs --reindex
    python scripts/arxiv_add_papers.py --file tranche.json --pdfs           # ["id", ...] or [{"arxiv_id": ...}, ...]
    python scripts/arxiv_add_papers.py --ids 0806.0709 --dry-run
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

# Same-dir import: works when run as `python scripts/arxiv_add_papers.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import arxiv_harvest as ah  # noqa: E402  (ShardWriter, load_seen_ids, id_to_ym, corpus_root)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

API_ENDPOINT = "http://export.arxiv.org/api/query"
ATOM_NS = "http://www.w3.org/2005/Atom"
ARXIV_ATOM_NS = "http://arxiv.org/schemas/atom"
BATCH = 20
SLEEP_BETWEEN_CALLS = 3  # arXiv asks bulk clients to go easy
SLEEP_BETWEEN_PDFS = 2


def log(msg: str) -> None:
    print(f"[arxiv-add] {msg}", flush=True)


def norm_id(s: str) -> str:
    s = (s or "").strip()
    if s.lower().startswith("arxiv:"):
        s = s[6:]
    # strip version suffix (0806.0709v3 -> 0806.0709)
    if "v" in s:
        base, _, ver = s.rpartition("v")
        if base and ver.isdigit():
            s = base
    return s


def _t(el, tag: str, ns: str = ATOM_NS) -> str:
    child = el.find(f"{{{ns}}}{tag}")
    return " ".join((child.text or "").split()) if child is not None and child.text else ""


def fetch_metadata(ids: list[str]) -> dict[str, dict]:
    """Fetch authoritative metadata for the ids from the arXiv API. Returns {id: record}."""
    out: dict[str, dict] = {}
    for i in range(0, len(ids), BATCH):
        batch = ids[i:i + BATCH]
        params = {"id_list": ",".join(batch), "max_results": str(len(batch))}
        req = Request(f"{API_ENDPOINT}?{urlencode(params)}", headers={"User-Agent": ah.USER_AGENT})
        with urlopen(req, timeout=60) as resp:
            root = ET.fromstring(resp.read())
        for entry in root.findall(f"{{{ATOM_NS}}}entry"):
            raw_id = _t(entry, "id")  # http://arxiv.org/abs/0806.0709v3
            arxiv_id = norm_id(raw_id.rsplit("/abs/", 1)[-1]) if "/abs/" in raw_id else ""
            title = _t(entry, "title")
            if not arxiv_id or not title:
                continue  # the API emits a stub entry for unknown ids
            categories = [c.get("term", "") for c in entry.findall(f"{{{ATOM_NS}}}category") if c.get("term")]
            primary = entry.find(f"{{{ARXIV_ATOM_NS}}}primary_category")
            primary_category = primary.get("term", "") if primary is not None else (categories[0] if categories else "")
            authors = [_t(a, "name") for a in entry.findall(f"{{{ATOM_NS}}}author")]
            out[arxiv_id] = {
                "id": arxiv_id,
                "title": title,
                "authors": [a for a in authors if a],
                "abstract": _t(entry, "summary"),
                "categories": categories,
                "primary_category": primary_category,
                "published": ah.id_to_ym(arxiv_id),   # id-derived, authoritative (see ARXIV-CORPUS.md)
                "updated": _t(entry, "updated")[:10],
                "arxiv_url": f"https://arxiv.org/abs/{arxiv_id}",
                "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}",
            }
        if i + BATCH < len(ids):
            time.sleep(SLEEP_BETWEEN_CALLS)
    return out


def download_pdf(arxiv_id: str, pdf_dir: Path) -> str:
    dest = pdf_dir / f"{arxiv_id}.pdf"
    if dest.exists() and dest.stat().st_size > 0:
        return f"already present ({dest.stat().st_size} bytes)"
    req = Request(f"https://arxiv.org/pdf/{arxiv_id}", headers={"User-Agent": ah.USER_AGENT})
    with urlopen(req, timeout=120) as resp:
        data = resp.read()
    if not data.startswith(b"%PDF"):
        return f"SKIPPED — response is not a PDF ({len(data)} bytes)"
    dest.write_bytes(data)
    return f"saved ({len(data)} bytes)"


def load_requested_ids(args) -> list[str]:
    ids: list[str] = []
    if args.ids:
        ids += [norm_id(s) for s in args.ids.split(",")]
    if args.file:
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        for item in payload:
            ids.append(norm_id(item if isinstance(item, str) else item.get("arxiv_id") or item.get("id") or ""))
    seen: set[str] = set()
    ordered = []
    for i in ids:
        if i and i not in seen:
            seen.add(i)
            ordered.append(i)
    return ordered


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Add curated arXiv papers to the local corpus by id.")
    ap.add_argument("--ids", help="Comma-separated arXiv ids (modern YYMM.NNNNN scheme).")
    ap.add_argument("--file", help='JSON file: ["id", ...] or [{"arxiv_id": "..."}, ...].')
    ap.add_argument("--pdfs", action="store_true", help="Also download pdfs\\<id>.pdf for every requested id.")
    ap.add_argument("--reindex", action="store_true", help="Run arxiv_build_index.py after adding.")
    ap.add_argument("--dry-run", action="store_true", help="Fetch + report, write nothing.")
    args = ap.parse_args(argv)

    requested = load_requested_ids(args)
    if not requested:
        ap.error("no ids given — use --ids and/or --file")

    bad = [i for i in requested if not ah.id_to_ym(i)]
    if bad:
        log(f"REJECTED (not modern YYMM.NNNNN ids, can't be dated): {', '.join(bad)}")
    requested = [i for i in requested if ah.id_to_ym(i)]
    if not requested:
        return 1

    root = ah.corpus_root()
    raw_dir = root / "raw"
    pdf_dir = root / "pdfs"
    raw_dir.mkdir(parents=True, exist_ok=True)

    log(f"fetching metadata for {len(requested)} ids from the arXiv API…")
    meta = fetch_metadata(requested)
    missing = [i for i in requested if i not in meta]
    for i in missing:
        log(f"NOT FOUND on arXiv API: {i}")

    seen = ah.load_seen_ids(raw_dir)
    new = [meta[i] for i in requested if i in meta and i not in seen]
    dup = [i for i in requested if i in meta and i in seen]
    log(f"{len(new)} new, {len(dup)} already in corpus, {len(missing)} not found")

    if args.dry_run:
        for rec in new:
            log(f"would add {rec['id']} [{rec['primary_category']}] ({rec['published']}) {rec['title'][:80]}")
        return 0

    if new:
        writer = ah.ShardWriter(raw_dir)
        try:
            for rec in new:
                writer.write(rec)
                log(f"added {rec['id']} [{rec['primary_category']}] ({rec['published']}) {rec['title'][:80]}")
        finally:
            writer.close()

    if args.pdfs:
        pdf_dir.mkdir(parents=True, exist_ok=True)
        fetchable = [i for i in requested if i in meta]
        for n, arxiv_id in enumerate(fetchable):
            if n:
                time.sleep(SLEEP_BETWEEN_PDFS)
            try:
                log(f"pdf {arxiv_id}: {download_pdf(arxiv_id, pdf_dir)}")
            except Exception as e:  # noqa: BLE001 — per-file: report and keep going
                log(f"pdf {arxiv_id}: FAILED — {e}")

    if args.reindex:
        log("rebuilding BM25 index…")
        rc = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "arxiv_build_index.py")]).returncode
        if rc != 0:
            log(f"index rebuild exited {rc}")
            return rc
    elif new:
        log("remember: python scripts/arxiv_build_index.py to make the new papers retrievable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
