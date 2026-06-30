"""
CSF-Slot — per-column *best-in-slot* encoding (improvisation on CSF-Omni's envelope).

The convergence finding (docs/research/2026-06-29-csf-vs-category-convergence.md): the
columnar frontier — BtrBlocks, FastLanes, CLP-S — wins by **per-column scheme selection**
(a cascade/panel of lightweight encoders, the smallest chosen per column), not by one
clever codec. CSF-Omni already does exactly this *selection* — but only over WHOLE-BLOB
codecs. CSF-Slot pushes the same self-describing, lossless-verified best-fit idea down to
the column: each column independently picks the smallest of a panel and stamps the method.

This is a measurement prototype with a FULL lossless round-trip (it reuses CSF-Col's exact
skeleton machinery, so reassembly is byte-identical to the shipping transform; only the
per-column entropy backend changes). It reports CSF-Slot vs zstd-19, vs the shipping
CSF-Col->brotli, and shows which sector picked which encoder.

    PYTHONPATH=src python experiments/csf_slot_prototype.py
"""
from __future__ import annotations

import os
import sys
import bz2
import lzma

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import brotli
import zstandard as zstd
from csf import col_transform as ct

SEP = ct._SEP          # b"\n" — never appears inside a JSON token
_VER = 7


def _join(strs) -> bytes:
    return "\n".join(strs).encode("utf-8")


def _br(b: bytes) -> bytes:
    return brotli.compress(b, quality=11)


def _zs(b: bytes) -> bytes:
    return zstd.ZstdCompressor(level=19).compress(b)


# --------------------------------------------------------------------------
# Per-column encoder panel. Each: enc(list[str]) -> bytes ; dec(bytes) -> list[str].
# Every payload round-trips its own column exactly (asserted at pack time).
# --------------------------------------------------------------------------
def enc_brotli(col):
    return _br(_join(col))

def dec_brotli(p, n):
    return brotli.decompress(p).decode("utf-8").split("\n") if n else []


def enc_zstd(col):
    return _zs(_join(col))

def dec_zstd(p, n):
    return zstd.ZstdDecompressor().decompress(p).decode("utf-8").split("\n") if n else []


def _wv(out, x):
    while True:
        b = x & 0x7F; x >>= 7
        out.append(b | (0x80 if x else 0))
        if not x:
            return

def _rv(buf, pos):
    sh = n = 0
    while True:
        b = buf[pos]; pos += 1
        n |= (b & 0x7F) << sh
        if not (b & 0x80):
            return n, pos
        sh += 7


def enc_dict(col):
    """Dictionary: unique values + a varint index stream, each brotli'd. Wins on
    low-cardinality sectors (enum/source/agent/actor) — the classic columnar codec."""
    uniq, idx = [], []
    pos = {}
    for v in col:
        if v not in pos:
            pos[v] = len(uniq); uniq.append(v)
        idx.append(pos[v])
    dict_blob = _br(_join(uniq))
    istream = bytearray()
    for i in idx:
        _wv(istream, i)
    idx_blob = _br(bytes(istream))
    out = bytearray()
    _wv(out, len(uniq)); _wv(out, len(dict_blob))
    out += dict_blob; out += idx_blob
    return bytes(out)

def dec_dict(p, n):
    nu, pos = _rv(p, 0)
    dlen, pos = _rv(p, pos)
    uniq = brotli.decompress(p[pos:pos + dlen]).decode("utf-8").split("\n") if nu else []
    pos += dlen
    istream = brotli.decompress(p[pos:])
    out, ip = [], 0
    for _ in range(n):
        i, ip = _rv(istream, ip)
        out.append(uniq[i])
    return out


def _all_fixed_hex(col):
    if not col:
        return 0
    L = len(col[0])
    if L == 0 or L % 2:
        return 0
    for v in col:
        if len(v) != L or any(c not in "0123456789abcdef" for c in v):
            return 0
    return L

def enc_unhex(col):
    """For incompressible fixed-length lowercase-hex sectors (sha-256 checksums): pack
    two hex chars -> one byte. brotli can't shrink a hash; storing the raw bytes drops
    the 2x hex inflation that brotli only partly recovers."""
    L = _all_fixed_hex(col)
    raw = b"".join(bytes.fromhex(v) for v in col)
    body = _br(raw)
    if len(body) >= len(raw):
        body, flag = raw, 0
    else:
        flag = 1
    out = bytearray()
    _wv(out, L); out.append(flag); out += body
    return bytes(out)

def dec_unhex(p, n):
    L, pos = _rv(p, 0)
    flag = p[pos]; pos += 1
    raw = brotli.decompress(p[pos:]) if flag else p[pos:]
    bl = L // 2
    return [raw[i * bl:(i + 1) * bl].hex() for i in range(n)]


def enc_store(col):
    return _join(col)

def dec_store(p, n):
    return p.decode("utf-8").split("\n") if n else []


PANEL = [
    (0, "brotli", enc_brotli, dec_brotli),
    (1, "zstd19", enc_zstd, dec_zstd),
    (2, "dict",   enc_dict,  dec_dict),
    (3, "unhex",  enc_unhex, dec_unhex),
    (4, "store",  enc_store, dec_store),
]
DEC = {m: d for m, _n, _e, d in PANEL}
NAME = {m: n for m, n, _e, _d in PANEL}


def best_in_slot(col):
    best = None
    for m, name, enc, dec in PANEL:
        try:
            payload = enc(col)
        except Exception:
            continue
        if dec(payload, len(col)) != col:        # lossless gate, per column
            continue
        if best is None or len(payload) < best[2]:
            best = (m, name, len(payload), payload)
    return best


# --------------------------------------------------------------------------
# Pack / unpack — reuses CSF-Col's skeleton so the row reassembly is byte-exact.
# --------------------------------------------------------------------------
def pack(data: bytes, record_methods=None):
    if not data or data[0:1] != b"{":
        raise ct.NotApplicable("not JSONL")
    text = data.decode("utf-8")
    if "\x00" in text:
        raise ct.NotApplicable("contains NUL")
    trailing_nl = text.endswith("\n")
    body = text[:-1] if trailing_nl else text
    lines = body.split("\n")

    skeletons, columns = [], []
    for line in lines:
        parsed = ct._split_line(line)
        if parsed is None:
            raise ct.NotApplicable("non-flat line")
        spans, _end = parsed
        parts, prev = [], 0
        for ci, (vs, ve) in enumerate(spans):
            parts.append(line[prev:vs]); parts.append("\x00"); prev = ve
            if ci == len(columns):
                columns.append([])
            columns[ci].append(line[vs:ve])
        parts.append(line[prev:])
        skeletons.append("".join(parts))

    out = bytearray()
    out.append(_VER); out.append(1 if trailing_nl else 0)
    _wv(out, len(lines)); _wv(out, len(columns))
    sk = _br(_join(skeletons))
    _wv(out, len(sk)); out += sk
    for col in columns:
        m, name, plen, payload = best_in_slot(col)
        if record_methods is not None:
            record_methods.append((name, plen, len(col)))
        out.append(m); _wv(out, len(col)); _wv(out, len(payload)); out += payload
    return bytes(out)


def unpack(buf: bytes) -> bytes:
    pos = 0
    assert buf[pos] == _VER; pos += 1
    trailing_nl = buf[pos] == 1; pos += 1
    n_lines, pos = _rv(buf, pos)
    n_cols, pos = _rv(buf, pos)
    sklen, pos = _rv(buf, pos)
    skeletons = brotli.decompress(buf[pos:pos + sklen]).decode("utf-8").split("\n") if n_lines else []
    pos += sklen
    cols = []
    for _ in range(n_cols):
        m = buf[pos]; pos += 1
        n, pos = _rv(buf, pos)
        plen, pos = _rv(buf, pos)
        cols.append(DEC[m](buf[pos:pos + plen], n)); pos += plen
    cur = [0] * n_cols
    out_lines = []
    for sk in skeletons:
        seg = sk.split("\x00")
        rebuilt = [seg[0]]
        for ci in range(len(seg) - 1):
            rebuilt.append(cols[ci][cur[ci]]); cur[ci] += 1
            rebuilt.append(seg[ci + 1])
        out_lines.append("".join(rebuilt))
    res = "\n".join(out_lines)
    if trailing_nl:
        res += "\n"
    return res.encode("utf-8")


def csf_col_brotli(data: bytes) -> int:
    try:
        return len(_br(ct.forward(data)))
    except ct.NotApplicable:
        return len(_br(data))


# --------------------------------------------------------------------------
# CSF-Slot-v2 — the CORRECT best-in-slot: per-column reversible TRANSFORM (the
# lever brotli structurally lacks), then ONE brotli over the whole buffer. This
# keeps single-stream context *and* gains per-sector fit (BtrBlocks/CLP-S recipe).
# --------------------------------------------------------------------------
import re
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_INT = re.compile(r"^-?(0|[1-9]\d*)$")


def _zig(n):           # zigzag so deltas of either sign stay small varints
    return (n << 1) ^ (n >> 63) if n < 0 else (n << 1)

def _unzig(z):
    return (z >> 1) ^ -(z & 1)


def _t_identity(col):
    return _join(col)

def _u_identity(blob, n):
    return blob.decode("utf-8").split("\n") if n else []


def _quoted(col):
    return bool(col) and all(len(v) >= 2 and v[0] == '"' and v[-1] == '"' for v in col)

def _t_unhex(col):
    q = _quoted(col)
    inner = [v[1:-1] for v in col] if q else col
    L = _all_fixed_hex(inner)
    if not L:
        return None
    out = bytearray(); out.append(1 if q else 0); _wv(out, L)
    out += b"".join(bytes.fromhex(v) for v in inner)
    return bytes(out)

def _u_unhex(blob, n):
    q = blob[0]; pos = 1
    L, pos = _rv(blob, pos); bl = L // 2
    raw = blob[pos:]
    vals = [raw[i*bl:(i+1)*bl].hex() for i in range(n)]
    return [f'"{v}"' for v in vals] if q else vals


def _iso_us(s):  # ISO -> epoch microseconds (UTC, ms precision)
    import datetime
    d = datetime.datetime(int(s[0:4]), int(s[5:7]), int(s[8:10]), int(s[11:13]),
                          int(s[14:16]), int(s[17:19]), int(s[20:23]) * 1000,
                          tzinfo=datetime.timezone.utc)
    return int(d.timestamp() * 1_000_000)

def _us_iso(us):
    import datetime
    d = datetime.datetime.fromtimestamp(us / 1_000_000, tz=datetime.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"

def _t_delta_iso(col):
    q = _quoted(col)
    inner = [v[1:-1] for v in col] if q else col
    if not inner or not all(_ISO.match(v) for v in inner):
        return None
    vals = [_iso_us(v) for v in inner]
    out = bytearray(); out.append(1 if q else 0); prev = 0
    for x in vals:
        _wv(out, _zig(x - prev)); prev = x
    return bytes(out)

def _u_delta_iso(blob, n):
    q = blob[0]; pos = 1; out = []; prev = 0
    for _ in range(n):
        z, pos = _rv(blob, pos); prev += _unzig(z)
        s = _us_iso(prev)
        out.append(f'"{s}"' if q else s)
    return out


def _t_delta_int(col):
    if not col or not all(_INT.match(v) for v in col):
        return None
    vals = [int(v) for v in col]
    out = bytearray(); prev = 0
    for x in vals:
        _wv(out, _zig(x - prev)); prev = x
    return bytes(out)

def _u_delta_int(blob, n):
    out, pos, prev = [], 0, 0
    for _ in range(n):
        z, pos = _rv(blob, pos); prev += _unzig(z)
        out.append(str(prev))
    return out


TRANSFORMS = [
    (0, "identity", _t_identity, _u_identity),
    (1, "unhex",    _t_unhex,    _u_unhex),
    (2, "delta-iso", _t_delta_iso, _u_delta_iso),
    (3, "delta-int", _t_delta_int, _u_delta_int),
]
TDEC = {t: u for t, _n, _e, u in TRANSFORMS}
TNAME = {t: n for t, n, _e, _u in TRANSFORMS}


def best_transform(col):
    """Pick the transform whose output is smallest under a standalone brotli proxy,
    among those that round-trip this column exactly."""
    best = None
    for t, name, enc, dec in TRANSFORMS:
        blob = enc(col)
        if blob is None or dec(blob, len(col)) != col:
            continue
        proxy = len(_br(blob))
        if best is None or proxy < best[0]:
            best = (proxy, t, name, blob)
    return best


def pack_v2(data, record=None):
    text = data.decode("utf-8")
    trailing_nl = text.endswith("\n")
    lines = (text[:-1] if trailing_nl else text).split("\n")
    skeletons, columns = [], []
    for line in lines:
        spans, _e = ct._split_line(line)
        parts, prev = [], 0
        for ci, (vs, ve) in enumerate(spans):
            parts.append(line[prev:vs]); parts.append("\x00"); prev = ve
            if ci == len(columns):
                columns.append([])
            columns[ci].append(line[vs:ve])
        parts.append(line[prev:])
        skeletons.append("".join(parts))

    buf = bytearray()
    buf.append(1 if trailing_nl else 0)
    _wv(buf, len(lines)); _wv(buf, len(columns))
    skb = _join(skeletons)
    _wv(buf, len(skb)); buf += skb
    for col in columns:
        _proxy, t, name, blob = best_transform(col)
        if record is not None:
            record.append((name, len(_br(blob)), len(col)))
        buf.append(t); _wv(buf, len(blob)); buf += blob
    return _br(bytes(buf))           # ONE brotli over the whole transformed buffer


def unpack_v2(packed):
    buf = brotli.decompress(packed); pos = 0
    trailing_nl = buf[pos]; pos += 1
    n_lines, pos = _rv(buf, pos)
    n_cols, pos = _rv(buf, pos)
    skl, pos = _rv(buf, pos)
    skeletons = buf[pos:pos+skl].decode("utf-8").split("\n") if n_lines else []
    pos += skl
    cols = []
    for _ in range(n_cols):
        t = buf[pos]; pos += 1
        blen, pos = _rv(buf, pos)
        cols.append(TDEC[t](buf[pos:pos+blen], n_lines)); pos += blen
    cur = [0] * n_cols; out = []
    for sk in skeletons:
        seg = sk.split("\x00"); reb = [seg[0]]
        for ci in range(len(seg)-1):
            reb.append(cols[ci][cur[ci]]); cur[ci] += 1; reb.append(seg[ci+1])
        out.append("".join(reb))
    res = "\n".join(out) + ("\n" if trailing_nl else "")
    return res.encode("utf-8")


def _highbpb_hex(col):
    """True if the column is fixed-length quoted-hex AND ~incompressible (a hash/uuid):
    the one sector worth pulling out of the shared brotli stream into a raw sidecar."""
    if not _quoted(col):
        return False
    inner = [v[1:-1] for v in col]
    if not _all_fixed_hex(inner):
        return False
    blob = _join(col)
    return len(_br(blob)) * 8 / max(1, len(blob)) >= 3.0


def pack_v3(data, record=None):
    """CSF-Slot v3 — isolate incompressible hash/uuid sectors into a raw (unhexed)
    sidecar; everything else stays in ONE shared brotli (full cross-column context).
    Captures the only real win on hash-saturated logs without the v1/v2 regressions."""
    text = data.decode("utf-8")
    trailing_nl = text.endswith("\n")
    lines = (text[:-1] if trailing_nl else text).split("\n")
    skeletons, columns = [], []
    for line in lines:
        spans, _e = ct._split_line(line)
        parts, prev = [], 0
        for ci, (vs, ve) in enumerate(spans):
            parts.append(line[prev:vs]); parts.append("\x00"); prev = ve
            if ci == len(columns):
                columns.append([])
            columns[ci].append(line[vs:ve])
        parts.append(line[prev:])
        skeletons.append("".join(parts))

    placement = [1 if _highbpb_hex(c) else 0 for c in columns]
    if record is not None:
        record.append(sum(placement))
    pre = bytearray()
    skb = _join(skeletons)
    _wv(pre, len(skb)); pre += skb
    for ci, col in enumerate(columns):
        if placement[ci] == 0:
            blob = _join(col)
            _wv(pre, len(blob)); pre += blob
    shared = _br(bytes(pre))

    out = bytearray()
    out.append(_VER + 1); out.append(1 if trailing_nl else 0)
    _wv(out, len(lines)); _wv(out, len(columns))
    out += bytes(placement)
    _wv(out, len(shared)); out += shared
    for ci, col in enumerate(columns):
        if placement[ci] == 1:
            payload = _t_unhex(col)
            _wv(out, len(payload)); out += payload
    return bytes(out)


def unpack_v3(buf):
    pos = 0
    assert buf[pos] == _VER + 1; pos += 1
    trailing_nl = buf[pos]; pos += 1
    n_lines, pos = _rv(buf, pos)
    n_cols, pos = _rv(buf, pos)
    placement = list(buf[pos:pos + n_cols]); pos += n_cols
    slen, pos = _rv(buf, pos)
    pre = brotli.decompress(buf[pos:pos + slen]); pos += slen
    ppos = 0
    skl, ppos = _rv(pre, ppos)
    skeletons = pre[ppos:ppos + skl].decode("utf-8").split("\n") if n_lines else []
    ppos += skl
    cols = [None] * n_cols
    for ci in range(n_cols):
        if placement[ci] == 0:
            blen, ppos = _rv(pre, ppos)
            cols[ci] = pre[ppos:ppos + blen].decode("utf-8").split("\n") if n_lines else []
            ppos += blen
    for ci in range(n_cols):
        if placement[ci] == 1:
            plen, pos = _rv(buf, pos)
            cols[ci] = _u_unhex(buf[pos:pos + plen], n_lines); pos += plen
    cur = [0] * n_cols; out = []
    for sk in skeletons:
        seg = sk.split("\x00"); reb = [seg[0]]
        for k in range(len(seg) - 1):
            reb.append(cols[k][cur[k]]); cur[k] += 1; reb.append(seg[k + 1])
        out.append("".join(reb))
    return ("\n".join(out) + ("\n" if trailing_nl else "")).encode("utf-8")


def report(name: str, data: bytes):
    m1 = []
    packed = pack(data, m1)
    assert unpack(packed) == data, "CSF-Slot v1 ROUND-TRIP FAILED"
    m2 = []
    packed2 = pack_v2(data, m2)
    assert unpack_v2(packed2) == data, "CSF-Slot v2 ROUND-TRIP FAILED"
    m3 = []
    packed3 = pack_v3(data, m3)
    assert unpack_v3(packed3) == data, "CSF-Slot v3 ROUND-TRIP FAILED"
    raw = len(data)
    z19 = len(_zs(data))
    colbr = csf_col_brotli(data)
    slot, slot2, slot3 = len(packed), len(packed2), len(packed3)
    print(f"\n### {name}  — raw {raw:,} B  ({len(m2)} columns)")
    print(f"| codec | size (B) | ratio | vs zstd-19 | vs CSF-Col→brotli |")
    print(f"|---|--:|--:|--:|--:|")
    print(f"| zstd-19 (standard) | {z19:,} | {raw/z19:.2f}× | — | — |")
    print(f"| CSF-Col → brotli (ships) | {colbr:,} | {raw/colbr:.2f}× | {(z19/colbr-1)*100:+.1f}% | — |")
    print(f"| CSF-Slot v1 (per-col separate streams) | {slot:,} | {raw/slot:.2f}× | "
          f"{(z19/slot-1)*100:+.1f}% | {(colbr/slot-1)*100:+.1f}% |")
    print(f"| CSF-Slot v2 (per-col transform + 1 brotli) | {slot2:,} | {raw/slot2:.2f}× | "
          f"{(z19/slot2-1)*100:+.1f}% | {(colbr/slot2-1)*100:+.1f}% |")
    print(f"| **CSF-Slot v3 (isolate incompressible sector)** | **{slot3:,}** | **{raw/slot3:.2f}×** | "
          f"**{(z19/slot3-1)*100:+.1f}%** | **{(colbr/slot3-1)*100:+.1f}%** |")
    from collections import Counter
    tally = Counter(n for n, _pl, _c in m2)
    print(f"\nv2 transform tally: {dict(tally)}  ·  v3 isolated {m3[0]} incompressible sector(s)")
    return {"raw": raw, "zstd19": z19, "col_brotli": colbr,
            "slot_v1": slot, "slot_v2": slot2, "slot_v3": slot3}


def main():
    print("# CSF-Slot — per-column best-in-slot (improvisation prototype, lossless-verified)\n")
    mem = os.path.join(os.path.dirname(__file__), "..", "data", "csf_memory")
    import glob
    files = sorted(glob.glob(os.path.join(mem, "*.jsonl")), key=os.path.getsize, reverse=True)
    # individual realistic log + the concatenated corpus
    big = next((f for f in files if os.path.getsize(f) > 100_000), files[0])
    report(f"raw.jsonl (realistic memory log)", open(big, "rb").read())
    concat = b"".join(open(f, "rb").read() for f in files)
    report("all memory logs concatenated", concat)
    print("\n_CSF-Slot reuses CSF-Col's skeleton, so row reassembly is byte-identical; "
          "only the per-column entropy backend is chosen best-in-slot. Round-trip asserted == original._")


if __name__ == "__main__":
    main()
