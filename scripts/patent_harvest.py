"""
Harvest worldwide-patent metadata (title + abstract + classifications + dates +
applicant) into a local append-only corpus on drive F:, so the unisona.ai chat
assistant can answer prior-art / IP / "who holds the patent on X" questions grounded
in real patents from ~90+ patent offices.

Source: EPO Open Patent Services (OPS) — the European Patent Office's free REST API.
It is the only free API with genuinely worldwide coverage (DOCDB bibliographic across
90+ countries + INPADOC families). Metadata + abstract only for most offices; full text
(claims/description) is free only for EP / WO / US, so the corpus grounds on title +
abstract worldwide (that is the honest limit of "worldwide + free" — see docs/PATENT-CORPUS.md).

  ⚠️ ONE FREE ONBOARDING STEP (Alex): register a free OPS account and create an app to get
     a Consumer Key + Consumer Secret at  https://developers.epo.org/  (no credit card).
     Then set them in .env.local (or the environment):
         EPO_OPS_KEY=<consumer key>
         EPO_OPS_SECRET=<consumer secret>

  ⚠️ LIVE-VALIDATION NOTE: the OPS JSON shapes below are coded from the published API docs
     but have NOT been run against a live key in this environment. Validate incrementally:
         python scripts/patent_harvest.py --dry-run                       # auth only
         python scripts/patent_harvest.py --keywords "solid state battery electrolyte" --max 20
     then inspect F:\patent-corpus\raw\*.jsonl before a full harvest. The retrieval side
     (lib/patent-index.js) is fail-safe: a missing/empty corpus never blocks chat.

Storage layout (root = $PATENT_CORPUS_DIR, default F:\\patent-corpus):

    raw\\<YYYY>.jsonl     # one patent per line, deduped by publication number, sharded by publication year
    state\\harvest.json   # last harvest parameters for --delta runs

Run:
    python scripts/patent_harvest.py --dry-run
    python scripts/patent_harvest.py --keywords "solid state battery electrolyte" --from 2018 --max 200
    python scripts/patent_harvest.py --cpc H01M10/0525 --from 2015
    python scripts/patent_harvest.py --query 'txt="graphene transistor" and pd within "2019 2026"'   # raw CQL

Then rebuild the retrieval index:
    python scripts/patent_build_index.py
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

# Windows consoles default to cp1252 and choke on unicode in log output.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken"
REST_BASE = "http://ops.epo.org/3.2/rest-services"
USER_AGENT = "keystone-os-patent-harvester/1.0 (https://lantern-os.net; founder@lantern-os.net)"

DEFAULT_ROOT = Path(os.environ.get("PATENT_CORPUS_DIR", r"F:\patent-corpus"))
PAGE = 100          # OPS max results per search request (Range window)
OPS_MAX_TOTAL = 2000  # OPS caps a single search's reachable results at 2000


def corpus_root() -> Path:
    return Path(os.environ.get("PATENT_CORPUS_DIR", str(DEFAULT_ROOT)))


def log(msg: str) -> None:
    print(f"[patent-harvest {datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# OPS auth (OAuth2 client-credentials) + throttled GET
# ---------------------------------------------------------------------------

class QuotaExceeded(Exception):
    """Raised on OPS weekly/anonymous quota exhaustion so the driver stops cleanly."""


def get_token(key: str, secret: str) -> str:
    basic = base64.b64encode(f"{key}:{secret}".encode()).decode()
    body = urlencode({"grant_type": "client_credentials"}).encode()
    req = Request(AUTH_URL, data=body, headers={
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    with urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    tok = payload.get("access_token")
    if not tok:
        raise RuntimeError(f"OPS auth returned no access_token: {payload}")
    return tok


def ops_get(path: str, token: str, *, key: str, secret: str,
            token_box: dict, params: dict | None = None, max_retries: int = 6) -> dict:
    """GET an OPS REST path as JSON, refreshing the token on 401 and backing off on
    throttle (403/429) or transient 5xx. `token_box` holds the live token so a refresh
    propagates to the caller."""
    url = f"{REST_BASE}/{path}"
    if params:
        url += "?" + urlencode(params, quote_via=quote)
    attempt = 0
    while True:
        req = Request(url, headers={
            "Authorization": f"Bearer {token_box['token']}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        })
        try:
            with urlopen(req, timeout=60) as resp:
                return json.loads(resp.read() or b"{}")
        except HTTPError as e:
            detail = ""
            try:
                detail = (e.read() or b"").decode(errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            # OPS signals quota exhaustion in the body / a dedicated fault code.
            if "QuotaPerWeekExceeded" in detail or "AnonymousQuota" in detail:
                raise QuotaExceeded(detail) from e
            if e.code == 401 and attempt < max_retries:
                log("token expired; refreshing")
                token_box["token"] = get_token(key, secret)
                attempt += 1
                continue
            if e.code in (403, 429):
                # Throttled. Respect Retry-After when present, else exponential backoff.
                retry_after = e.headers.get("Retry-After")
                delay = int(retry_after) if (retry_after and str(retry_after).isdigit()) else min(60, 10 * (attempt + 1))
                if attempt < max_retries:
                    log(f"throttled HTTP {e.code}; retry in {delay}s (attempt {attempt + 1}/{max_retries}) {detail[:120]}")
                    time.sleep(delay)
                    attempt += 1
                    continue
                raise
            if e.code in (500, 502, 503, 504) and attempt < max_retries:
                delay = min(30, 5 * (attempt + 1))
                log(f"HTTP {e.code}; retry in {delay}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                attempt += 1
                continue
            raise RuntimeError(f"OPS GET {path} failed: HTTP {e.code} {detail[:200]}") from e
        except URLError as e:
            if attempt < max_retries:
                delay = min(30, 5 * (attempt + 1))
                log(f"network error {e.reason!r}; retry in {delay}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                attempt += 1
                continue
            raise


# ---------------------------------------------------------------------------
# Defensive JSON navigation (OPS returns dict-or-list depending on cardinality)
# ---------------------------------------------------------------------------

def _as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _text(node) -> str:
    """OPS text nodes are often {"$": "value"} or {"$": "value", "@lang": "en"}."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node.strip()
    if isinstance(node, dict):
        return str(node.get("$", "")).strip()
    return ""


def _pick_lang(nodes, prefer=("en",)) -> str:
    """From a list of language-tagged text nodes, prefer English, else the first."""
    items = _as_list(nodes)
    for lang in prefer:
        for n in items:
            if isinstance(n, dict) and n.get("@lang", "").lower() == lang:
                return _text(n)
    return _text(items[0]) if items else ""


# ---------------------------------------------------------------------------
# CQL search -> publication references
# ---------------------------------------------------------------------------

def build_cql(args) -> str:
    if args.query:
        return args.query
    clauses = []
    if args.keywords:
        clauses.append(f'txt="{args.keywords}"')
    if args.cpc:
        clauses.append(f"cpc={args.cpc}")
    if args.ipc:
        clauses.append(f"ipc={args.ipc}")
    if args.applicant:
        clauses.append(f'pa="{args.applicant}"')
    if not clauses:
        raise SystemExit("nothing to search: pass --keywords, --cpc, --ipc, --applicant, or a raw --query")
    if args.from_year or args.until_year:
        lo = args.from_year or "1900"
        hi = args.until_year or str(datetime.now(timezone.utc).year)
        clauses.append(f'pd within "{lo} {hi}"')
    return " and ".join(clauses)


def search_pubrefs(cql: str, token_box: dict, *, key: str, secret: str, max_records: int | None):
    """Yield epodoc publication numbers (e.g. 'US11289701B2') matching the CQL query."""
    begin = 1
    limit = min(max_records or OPS_MAX_TOTAL, OPS_MAX_TOTAL)
    yielded = 0
    while begin <= limit:
        end = min(begin + PAGE - 1, limit)
        data = ops_get("published-data/search", None, key=key, secret=secret,
                       token_box=token_box, params={"q": cql, "Range": f"{begin}-{end}"})
        # ops:world-patent-data -> ops:biblio-search -> ops:search-result -> ops:publication-reference[]
        try:
            result = (data.get("ops:world-patent-data", {})
                          .get("ops:biblio-search", {})
                          .get("ops:search-result", {}))
            total = int(data.get("ops:world-patent-data", {})
                            .get("ops:biblio-search", {}).get("@total-result-count", 0) or 0)
        except (AttributeError, ValueError):
            result, total = {}, 0
        refs = _as_list(result.get("ops:publication-reference"))
        if not refs:
            break
        for ref in refs:
            num = epodoc_from_ref(ref)
            if num:
                yield num
                yielded += 1
                if max_records and yielded >= max_records:
                    return
        log(f"search page {begin}-{end}: {len(refs)} refs (total matched ~{total}, kept {yielded})")
        if end >= min(total or limit, limit):
            break
        begin = end + 1
        time.sleep(1)  # be polite between search pages


def epodoc_from_ref(ref: dict) -> str:
    """Extract the epodoc publication number (country+docnumber+kind) from a search ref."""
    for did in _as_list(ref.get("document-id")):
        if not isinstance(did, dict):
            continue
        if did.get("@document-id-type") == "epodoc":
            c = _text(did.get("country"))
            n = _text(did.get("doc-number"))
            k = _text(did.get("kind"))
            if n:
                return f"{c}{n}{k}"
    return ""


# ---------------------------------------------------------------------------
# Biblio + abstract fetch -> record
# ---------------------------------------------------------------------------

def fetch_record(epodoc: str, token_box: dict, *, key: str, secret: str) -> dict | None:
    data = ops_get(f"published-data/publication/epodoc/{quote(epodoc)}/biblio,abstract",
                   None, key=key, secret=secret, token_box=token_box)
    try:
        docs = _as_list(data.get("ops:world-patent-data", {})
                            .get("exchange-documents", {}).get("exchange-document"))
    except AttributeError:
        docs = []
    if not docs:
        return None
    doc = docs[0]
    country = doc.get("@country", "")
    docnum = doc.get("@doc-number", "")
    kind = doc.get("@kind", "")
    pub_number = f"{country}-{docnum}-{kind}".strip("-")
    biblio = doc.get("bibliographic-data", {}) if isinstance(doc, dict) else {}

    # Title (prefer English).
    title = _pick_lang((biblio.get("invention-title") if isinstance(biblio, dict) else None))

    # Abstract (prefer English) — abstract lives on the exchange-document.
    abstract = ""
    for ab in _as_list(doc.get("abstract")):
        if isinstance(ab, dict):
            paras = " ".join(_text(p) for p in _as_list(ab.get("p")))
            if ab.get("@lang", "").lower() == "en" and paras:
                abstract = paras
                break
            abstract = abstract or paras

    # Publication date (YYYYMMDD -> YYYY-MM-DD) from the publication-reference.
    published = ""
    for pref in _as_list((biblio.get("publication-reference", {}) or {}).get("document-id")):
        d = _text(pref.get("date")) if isinstance(pref, dict) else ""
        if len(d) == 8 and d.isdigit():
            published = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
            break

    # CPC classifications.
    cpc = []
    for c in _as_list((biblio.get("patent-classifications", {}) or {}).get("patent-classification")):
        if not isinstance(c, dict):
            continue
        section = _text(c.get("section")); cls = _text(c.get("class"))
        subcls = _text(c.get("subclass")); mg = _text(c.get("main-group")); sg = _text(c.get("subgroup"))
        code = f"{section}{cls}{subcls}{mg}/{sg}" if section else ""
        if code:
            cpc.append(code)

    # Applicant / assignee (prefer the epodoc-format name).
    assignee = ""
    for party in _as_list((biblio.get("parties", {}) or {}).get("applicants", {}) if isinstance(biblio, dict) else None):
        for app in _as_list((party or {}).get("applicant")):
            if isinstance(app, dict) and app.get("@data-format") == "epodoc":
                assignee = _text((app.get("applicant-name", {}) or {}).get("name"))
                if assignee:
                    break
        if assignee:
            break

    if not pub_number or (not title and not abstract):
        return None
    compact = f"{country}{docnum}{kind}"
    return {
        "id": pub_number,
        "title": title,
        "abstract": abstract,
        "country": country,
        "assignee": assignee,
        "cpc": cpc,
        "published": published,
        "patent_url": f"https://patents.google.com/patent/{compact}/en",
    }


# ---------------------------------------------------------------------------
# Corpus IO (dedup + yearly sharding) — mirrors arxiv_harvest.py
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
    year = published[:4] if len(published) >= 4 and published[:4].isdigit() else "unknown"
    return raw_dir / f"{year}.jsonl"


def harvest(args) -> dict:
    key = os.environ.get("EPO_OPS_KEY", "").strip()
    secret = os.environ.get("EPO_OPS_SECRET", "").strip()
    if not key or not secret:
        raise SystemExit(
            "EPO_OPS_KEY / EPO_OPS_SECRET not set. Register a free key at "
            "https://developers.epo.org/ and put both in .env.local (see docs/PATENT-CORPUS.md)."
        )

    log("authenticating with EPO OPS…")
    token_box = {"token": get_token(key, secret)}
    log("auth OK")

    if args.dry_run:
        cql = build_cql(args) if (args.keywords or args.cpc or args.ipc or args.applicant or args.query) else 'txt="test"'
        log(f"dry-run: verifying a 1-result search for CQL: {cql}")
        gen = search_pubrefs(cql, token_box, key=key, secret=secret, max_records=1)
        first = next(gen, None)
        log(f"dry-run OK — credentials valid; sample publication number: {first or '(none matched)'}")
        return {"dry_run": True, "sample": first}

    cql = build_cql(args)
    log(f"CQL: {cql}")

    root = corpus_root()
    raw_dir = root / "raw"
    state_dir = root / "state"
    raw_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    seen = load_seen_ids(raw_dir)
    log(f"corpus root {root} — {len(seen)} patents already stored")

    handles: dict[str, object] = {}
    fetched = kept = 0
    try:
        for epodoc in search_pubrefs(cql, token_box, key=key, secret=secret, max_records=args.max_records):
            fetched += 1
            try:
                rec = fetch_record(epodoc, token_box, key=key, secret=secret)
            except QuotaExceeded:
                raise
            except Exception as e:  # noqa: BLE001 — one bad doc shouldn't abort the run
                log(f"skip {epodoc}: {e}")
                rec = None
            if not rec or rec["id"] in seen:
                continue
            p = shard_path(raw_dir, rec.get("published", ""))
            fh = handles.get(p.name)
            if fh is None:
                fh = p.open("a", encoding="utf-8")
                handles[p.name] = fh
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            seen.add(rec["id"])
            kept += 1
            if kept % 25 == 0:
                log(f"fetched={fetched} kept={kept}")
            time.sleep(0.5)  # stay under the OPS per-minute throttle
    except QuotaExceeded:
        log("OPS weekly quota reached — stopping cleanly; partial corpus saved. Resume next week.")
    finally:
        for fh in handles.values():
            try:
                fh.close()
            except OSError:
                pass

    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "cql": cql,
        "fetched": fetched,
        "kept_new": kept,
        "total_stored": len(seen),
    }
    (state_dir / "harvest.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    log(f"done — {kept} new patents kept ({fetched} scanned); {len(seen)} total stored")
    return state


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Harvest worldwide patents from EPO OPS into a local corpus.")
    ap.add_argument("--keywords", help='Free-text query, wrapped as CQL txt="...".')
    ap.add_argument("--cpc", help="CPC classification (e.g. H01M10/0525).")
    ap.add_argument("--ipc", help="IPC classification.")
    ap.add_argument("--applicant", help='Applicant / assignee name (CQL pa="...").')
    ap.add_argument("--query", help="Raw OPS CQL expression (overrides the built query).")
    ap.add_argument("--from", dest="from_year", help="Publication year lower bound (YYYY).")
    ap.add_argument("--until", dest="until_year", help="Publication year upper bound (YYYY).")
    ap.add_argument("--max", dest="max_records", type=int, default=None, help="Cap patents fetched (smoke test).")
    ap.add_argument("--dry-run", action="store_true", help="Auth + one search only — validate the key, write nothing.")
    args = ap.parse_args(argv)

    try:
        harvest(args)
    except KeyboardInterrupt:
        log("interrupted; partial corpus saved")
        return 130
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — top-level: report and non-zero exit
        log(f"ERROR: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
