"""
Harvest arXiv AI/LLM paper metadata (title + abstract + categories + date) into a
local append-only corpus on drive F:, so the Keystone chat assistant can answer
AI/model/LLM questions with research published *after* the model's knowledge cutoff.

Metadata only — no PDFs, no full text. Uses arXiv's sanctioned OAI-PMH bulk route
(https://export.arxiv.org/oai2), the mechanism arXiv asks harvesters to use.
Respects flow control (503 + Retry-After) and rate limits.

Storage layout (root = $ARXIV_CORPUS_DIR, default F:\\arxiv-corpus):

    raw\\<YYYY-MM>.jsonl   # one record per line, deduped by arXiv id, sharded by publish month
    state\\harvest.json    # last harvest datestamp for --delta runs

Run:
    python scripts/arxiv_harvest.py --backfill --from 2025-07-01      # one-time backfill
    python scripts/arxiv_harvest.py --backfill --from 2025-07-01 --max 300   # smoke test
    python scripts/arxiv_harvest.py --delta                          # daily incremental

Then rebuild the retrieval index:
    python scripts/arxiv_build_index.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

# Windows consoles default to cp1252 and choke on unicode in log output.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

OAI_ENDPOINT = "https://export.arxiv.org/oai2"
OAI_NS = "http://www.openarchives.org/OAI/2.0/"
ARXIV_NS = "http://arxiv.org/OAI/arXiv/"

# Sets to harvest (coarse arXiv OAI sets). Fine-grained category filtering is done
# client-side against TARGET_CATEGORIES below.
SETS = ["cs", "stat"]

# Only keep papers tagged with at least one of these categories — the AI/ML/LLM core.
TARGET_CATEGORIES = {"cs.CL", "cs.LG", "cs.AI", "cs.NE", "stat.ML"}

USER_AGENT = "keystone-os-arxiv-harvester/1.0 (https://lantern-os.net; founder@lantern-os.net)"

DEFAULT_ROOT = Path(os.environ.get("ARXIV_CORPUS_DIR", r"F:\arxiv-corpus"))


def corpus_root() -> Path:
    return Path(os.environ.get("ARXIV_CORPUS_DIR", str(DEFAULT_ROOT)))


def log(msg: str) -> None:
    print(f"[arxiv-harvest {datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# OAI-PMH fetch with flow-control + retry
# ---------------------------------------------------------------------------

def _http_get(params: dict, *, max_retries: int = 6) -> bytes:
    url = f"{OAI_ENDPOINT}?{urlencode(params)}"
    attempt = 0
    while True:
        req = Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(req, timeout=60) as resp:
                return resp.read()
        except HTTPError as e:
            # arXiv uses 503 + Retry-After for flow control; also back off on 5xx.
            if e.code in (503, 500, 502, 504) and attempt < max_retries:
                retry_after = e.headers.get("Retry-After")
                delay = int(retry_after) if (retry_after and retry_after.isdigit()) else min(30, 5 * (attempt + 1))
                log(f"HTTP {e.code}; retry in {delay}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                attempt += 1
                continue
            raise
        except URLError as e:
            if attempt < max_retries:
                delay = min(30, 5 * (attempt + 1))
                log(f"network error {e.reason!r}; retry in {delay}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                attempt += 1
                continue
            raise


def _q(tag: str) -> str:
    return f"{{{OAI_NS}}}{tag}"


def _a(tag: str) -> str:
    return f"{{{ARXIV_NS}}}{tag}"


def _text(el, tag: str, ns=ARXIV_NS) -> str:
    child = el.find(f"{{{ns}}}{tag}")
    return (child.text or "").strip() if child is not None and child.text else ""


def parse_records(xml_bytes: bytes):
    """Yield (record_dict_or_None, ...) and return the resumptionToken (str|None).

    A record dict is None when the item is deleted or missing metadata.
    """
    root = ET.fromstring(xml_bytes)

    # Surface OAI errors (badArgument, noRecordsMatch, etc.) to the caller.
    err = root.find(_q("error"))
    if err is not None:
        code = err.get("code", "unknown")
        return [], None, (code, (err.text or "").strip())

    list_records = root.find(_q("ListRecords"))
    records = []
    token = None
    if list_records is not None:
        for rec in list_records.findall(_q("record")):
            header = rec.find(_q("header"))
            if header is not None and header.get("status") == "deleted":
                continue
            meta = rec.find(_q("metadata"))
            if meta is None:
                continue
            arx = meta.find(_a("arXiv"))
            if arx is None:
                continue
            records.append(_record_from_arxiv(arx))
        tok_el = list_records.find(_q("resumptionToken"))
        if tok_el is not None and tok_el.text and tok_el.text.strip():
            token = tok_el.text.strip()
    return records, token, None


# The arXiv id encodes the original submission year-month (YYMM.NNNNN since 2007) —
# this is the authoritative publication date. The OAI <created> field is NOT reliable
# here: the datestamp window surfaces old papers re-touched recently with misleading
# <created> values (e.g. 1709.08894 came back with created=2026-05-29), so we date
# papers by their id, not by <created>.
_ID_YM_RE = re.compile(r"^(\d{2})(\d{2})\.\d{4,5}")


def id_to_ym(arxiv_id: str) -> str:
    """Return 'YYYY-MM' from a modern arXiv id, or '' if it isn't the YYMM scheme."""
    m = _ID_YM_RE.match(arxiv_id or "")
    if not m:
        return ""  # pre-2007 scheme (e.g. hep-th/9901001) — out of scope for a recent corpus
    yy, mm = int(m.group(1)), int(m.group(2))
    if not (1 <= mm <= 12):
        return ""
    return f"20{yy:02d}-{mm:02d}"


def _record_from_arxiv(arx) -> dict:
    arxiv_id = _text(arx, "id")
    categories = _text(arx, "categories").split()
    authors = []
    authors_el = arx.find(_a("authors"))
    if authors_el is not None:
        for a in authors_el.findall(_a("author")):
            keyname = _text(a, "keyname")
            forenames = _text(a, "forenames")
            name = " ".join(p for p in [forenames, keyname] if p).strip()
            if name:
                authors.append(name)
    return {
        "id": arxiv_id,
        "title": " ".join(_text(arx, "title").split()),
        "authors": authors,
        "abstract": " ".join(_text(arx, "abstract").split()),
        "categories": categories,
        "primary_category": categories[0] if categories else "",
        "published": id_to_ym(arxiv_id),       # YYYY-MM, derived from the id (authoritative)
        "updated": _text(arx, "updated"),      # OAI last-modified datestamp (reference only)
        "arxiv_url": f"https://arxiv.org/abs/{arxiv_id}",
        "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}",
    }


# ---------------------------------------------------------------------------
# Corpus IO (dedup + monthly sharding)
# ---------------------------------------------------------------------------

def load_seen_ids(raw_dir: Path) -> set:
    seen = set()
    if not raw_dir.exists():
        return seen
    for f in raw_dir.glob("*.jsonl"):
        try:
            with f.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        seen.add(json.loads(line)["id"])
                    except (json.JSONDecodeError, KeyError):
                        continue
        except OSError:
            continue
    return seen


def shard_path(raw_dir: Path, published: str) -> Path:
    # published is YYYY-MM-DD; shard by month. Fall back to 'unknown'.
    ym = published[:7] if len(published) >= 7 and published[4] == "-" else "unknown"
    return raw_dir / f"{ym}.jsonl"


class ShardWriter:
    """Append records to monthly JSONL shards, keeping file handles open."""

    def __init__(self, raw_dir: Path):
        self.raw_dir = raw_dir
        self._handles: dict[str, object] = {}

    def write(self, rec: dict) -> None:
        p = shard_path(self.raw_dir, rec.get("published", ""))
        fh = self._handles.get(p.name)
        if fh is None:
            fh = p.open("a", encoding="utf-8")
            self._handles[p.name] = fh
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def close(self) -> None:
        for fh in self._handles.values():
            try:
                fh.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Harvest driver
# ---------------------------------------------------------------------------

def keep(rec: dict, from_date: str | None) -> bool:
    if not rec.get("id"):
        return False
    if not (set(rec.get("categories", [])) & TARGET_CATEGORIES):
        return False
    # Date on the id-derived submission month (YYYY-MM). Records we can't date (pre-2007
    # id scheme) are excluded — a corpus of *recent* research shouldn't include undatable
    # papers. from_date may be YYYY-MM-DD; compare on the YYYY-MM prefix.
    pub = rec.get("published", "")
    if not pub:
        return False
    if from_date and pub < from_date[:7]:
        return False
    return True


def harvest(from_date: str, until_date: str | None, max_records: int | None) -> dict:
    root = corpus_root()
    raw_dir = root / "raw"
    state_dir = root / "state"
    raw_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    seen = load_seen_ids(raw_dir)
    log(f"corpus root {root} — {len(seen)} papers already stored")

    writer = ShardWriter(raw_dir)
    fetched = kept = 0
    try:
        for set_spec in SETS:
            token = None
            first = True
            log(f"harvesting set={set_spec} from={from_date} until={until_date or 'now'}")
            while True:
                if token:
                    params = {"verb": "ListRecords", "resumptionToken": token}
                else:
                    params = {"verb": "ListRecords", "metadataPrefix": "arXiv", "set": set_spec, "from": from_date}
                    if until_date:
                        params["until"] = until_date
                xml_bytes = _http_get(params)
                records, token, err = parse_records(xml_bytes)
                if err:
                    code, text = err
                    if code == "noRecordsMatch":
                        log(f"set={set_spec}: no records match window")
                        break
                    raise RuntimeError(f"OAI error {code}: {text}")
                for rec in records:
                    fetched += 1
                    if rec["id"] in seen:
                        continue
                    if not keep(rec, from_date):
                        continue
                    writer.write(rec)
                    seen.add(rec["id"])
                    kept += 1
                    if max_records and kept >= max_records:
                        log(f"reached --max {max_records}; stopping")
                        token = None
                        break
                if first:
                    first = False
                log(f"set={set_spec}: fetched={fetched} kept={kept}" + (" (more…)" if token else ""))
                if not token:
                    break
                # Be polite between pages (arXiv asks harvesters to go easy).
                time.sleep(3)
                if max_records and kept >= max_records:
                    break
            if max_records and kept >= max_records:
                break
    finally:
        writer.close()

    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "last_from": from_date,
        "last_until": until_date or date.today().isoformat(),
        "fetched": fetched,
        "kept_new": kept,
        "total_stored": len(seen),
    }
    (state_dir / "harvest.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    log(f"done — {kept} new papers kept ({fetched} scanned); {len(seen)} total stored")
    return state


def read_state() -> dict:
    p = corpus_root() / "state" / "harvest.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Harvest arXiv AI/LLM metadata into a local corpus.")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--backfill", action="store_true", help="One-time backfill from --from.")
    mode.add_argument("--delta", action="store_true", help="Incremental: from last harvest datestamp.")
    ap.add_argument("--from", dest="from_date", default="2025-07-01", help="Backfill start (YYYY-MM-DD).")
    ap.add_argument("--until", dest="until_date", default=None, help="Optional end date (YYYY-MM-DD).")
    ap.add_argument("--overlap-days", type=int, default=2, help="Delta re-fetch overlap to catch late updates.")
    ap.add_argument("--max", dest="max_records", type=int, default=None, help="Cap new records (smoke test).")
    args = ap.parse_args(argv)

    if args.delta:
        state = read_state()
        base = state.get("last_until") or args.from_date
        try:
            from_date = (datetime.strptime(base, "%Y-%m-%d") - timedelta(days=args.overlap_days)).strftime("%Y-%m-%d")
        except ValueError:
            from_date = args.from_date
        log(f"delta mode: harvesting from {from_date}")
    else:
        from_date = args.from_date

    try:
        harvest(from_date, args.until_date, args.max_records)
    except KeyboardInterrupt:
        log("interrupted; partial corpus saved")
        return 130
    except Exception as e:  # noqa: BLE001 — top-level: report and non-zero exit
        log(f"ERROR: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
