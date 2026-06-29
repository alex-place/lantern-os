#!/usr/bin/env python3
"""
Level the Keystone Radio library — write a per-track `gain` (dB) into the manifest.

The 78rpm transfers vary wildly in loudness, so the dial jumps from a whisper to a
blast as it rolls. This measures each LOCAL mp3 with ffmpeg's EBU R128 loudnorm
analysis and stores the dB adjustment needed to reach a common target integrated
loudness (default -16 LUFS) into its `apps/lantern-garage/public/radio/stations.json`
entry. The player (fallout-radio.html) applies that gain at playback with a
Web-Audio GainNode — so leveling is **lossless** (the mp3s are never re-encoded)
and lives in the committed manifest (shared across machines).

The gain is clip-safe: it never boosts a track's measured true peak past -1 dBFS,
and is clamped to +/-12 dB. Entries whose mp3 isn't present locally are left
untouched (the player treats a missing `gain` as unity / 0 dB), so it's safe to
run on a partially-fetched library and re-run after fetching more tracks.

Usage:
    python scripts/normalize_radio_levels.py            # measure tracks missing a gain
    python scripts/normalize_radio_levels.py --force    # re-measure everything present
    python scripts/normalize_radio_levels.py --target -18
Requires: ffmpeg on PATH (same dependency as scripts/fetch_radio_audio.py).
"""
import argparse, json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RADIO_DIR = os.path.join(ROOT, "apps", "lantern-garage", "public", "radio")
MANIFEST = os.path.join(RADIO_DIR, "stations.json")


def measure(path):
    """Integrated loudness + true peak via ffmpeg loudnorm analysis -> (input_i, input_tp) or None."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
           "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    m = re.search(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return float(d["input_i"]), float(d["input_tp"])
    except Exception:
        return None


def compute_gain(input_i, input_tp, target):
    gain = target - input_i               # ReplayGain: bring this track up/down to the target
    gain = min(gain, -1.0 - input_tp)     # but never push the true peak past -1 dBFS (clip-safe)
    return round(max(-12.0, min(12.0, gain)), 1)


def run(target=-16.0, force=False, quiet=False):
    raw = open(MANIFEST, encoding="utf-8").read()
    trailing_nl = raw.endswith("\n")
    entries = json.loads(raw)

    present = measured = skipped = 0
    befores = []
    for e in entries:
        slug = os.path.splitext(os.path.basename(e.get("src", "")))[0]
        mp3 = os.path.join(RADIO_DIR, slug + ".mp3")
        if not slug or not os.path.exists(mp3):
            continue
        present += 1
        if "gain" in e and not force:
            skipped += 1
            continue
        res = measure(mp3)
        if not res:
            if not quiet:
                print("  ?? could not measure %s" % slug)
            continue
        input_i, input_tp = res
        e["gain"] = compute_gain(input_i, input_tp, target)
        befores.append(input_i)
        measured += 1
        if not quiet:
            print("  %-44s %6.1f LUFS  ->  gain %+5.1f dB" % (slug[:44], input_i, e["gain"]))

    out = json.dumps(entries, ensure_ascii=False, indent=0) + ("\n" if trailing_nl else "")
    open(MANIFEST, "w", encoding="utf-8", newline="\n").write(out)

    if not quiet:
        print("\n%d entries with local audio, %d measured, %d already leveled (skipped)."
              % (present, measured, skipped))
        if befores:
            print("loudness spread BEFORE: %.1f .. %.1f LUFS (range %.1f dB)  ->  all leveled to %.0f LUFS"
                  % (min(befores), max(befores), max(befores) - min(befores), target))
        miss = len(entries) - present
        if miss:
            print("%d entries have no local mp3 yet (left at 0 dB; re-run after fetching them)." % miss)
    return measured


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=float, default=-16.0, help="target integrated loudness, LUFS")
    ap.add_argument("--force", action="store_true", help="re-measure entries that already have a gain")
    args = ap.parse_args()
    run(target=args.target, force=args.force)


if __name__ == "__main__":
    main()
