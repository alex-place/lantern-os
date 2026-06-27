#!/usr/bin/env python3
"""
Populate the Keystone Radio audio library from its committed manifest.

The radio playlist lives in `apps/lantern-garage/public/radio/stations.json`
(small, committed). The audio files themselves are NOT committed (they'd be
hundreds of MB) — they're gitignored and fetched locally by this script, once
per machine/worktree. After it runs, the radio plays fully OFFLINE.

For every manifest entry that has Internet-Archive source info (`ia` + `iaf`)
and whose local mp3 is missing, this downloads the Great 78 Project transfer and
re-encodes it to 64 kbps mono (transparent for these band-limited 78rpm sources,
and small). Existing files are skipped, so re-runs are cheap and resumable.

Usage:
    python scripts/fetch_radio_audio.py            # fetch all missing
    python scripts/fetch_radio_audio.py --workers 12
    python scripts/fetch_radio_audio.py --force    # re-fetch even if present

Requires: ffmpeg on PATH.
"""
import argparse, json, os, subprocess, sys, urllib.parse, urllib.request, time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RADIO_DIR = os.path.join(ROOT, "apps", "lantern-garage", "public", "radio")
MANIFEST = os.path.join(RADIO_DIR, "stations.json")
UA = {"User-Agent": "keystone-radio-fetch/1.0"}
BITRATE = "64k"


def http_get(url, tries=4, timeout=60):
    last = None
    for _ in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except Exception as e:
            last = e; time.sleep(2)
    raise last


def fetch_one(entry, force=False):
    src = entry.get("src", "")
    slug = os.path.splitext(os.path.basename(src))[0]
    if not slug:
        return ("skip", entry.get("title", "?"), "no src")
    dest = os.path.join(RADIO_DIR, slug + ".mp3")
    if os.path.exists(dest) and not force:
        return ("have", slug, "")
    ia, iaf = entry.get("ia"), entry.get("iaf")
    if not ia or not iaf:
        return ("nofetch", slug, "no ia/iaf (commit this file instead)")
    url = "https://archive.org/download/%s/%s" % (ia, urllib.parse.quote(iaf))
    try:
        data = http_get(url)
        if len(data) < 200000:
            return ("fail", slug, "short download")
        tmp = dest + ".dl"
        with open(tmp, "wb") as fh:
            fh.write(data)
        # re-encode to compact mono, preserving ID3 tags
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp,
               "-ac", "1", "-b:a", BITRATE, "-map_metadata", "0", dest]
        r = subprocess.run(cmd, capture_output=True)
        os.remove(tmp)
        if r.returncode != 0 or not os.path.exists(dest):
            return ("fail", slug, "ffmpeg: " + r.stderr.decode("utf-8", "ignore")[:120])
        return ("ok", slug, "%.1fMB" % (os.path.getsize(dest) / 1e6))
    except Exception as e:
        return ("fail", slug, str(e)[:120])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        sys.exit("manifest not found: %s" % MANIFEST)
    entries = json.load(open(MANIFEST, encoding="utf-8"))
    os.makedirs(RADIO_DIR, exist_ok=True)

    todo = [e for e in entries if e.get("ia") and e.get("iaf")]
    print("manifest: %d stations (%d fetchable)" % (len(entries), len(todo)))
    counts = {"ok": 0, "have": 0, "fail": 0, "nofetch": 0, "skip": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(fetch_one, e, args.force) for e in entries]
        done = 0
        for fu in as_completed(futs):
            status, slug, note = fu.result()
            counts[status] = counts.get(status, 0) + 1
            done += 1
            if status in ("ok", "fail"):
                print("  [%d/%d] %-5s %-40s %s" % (done, len(entries), status, slug, note), flush=True)
    print("\nDone: %d fetched, %d already present, %d failed, %d not fetchable"
          % (counts["ok"], counts["have"], counts["fail"], counts["nofetch"]))
    if counts["fail"]:
        print("(failed tracks just show as SIGNAL LOST in the player and auto-skip; re-run to retry)")


if __name__ == "__main__":
    main()
