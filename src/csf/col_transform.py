"""
CSF-Col — lossless columnar transform for JSONL records (CSF Technique 1, issue #1593).

An *invertible byte→byte pre-pass* (same contract as the transforms in :mod:`csf.omni`):
it transposes append-only JSONL — where every line is a flat-ish JSON object — from
row-major into column-major, so a downstream entropy coder (zstd/brotli) sees long runs
of like-typed values (all timestamps together, all `confidence` floats together, the
near-constant `reasoner`/`verified` fields collapsing to almost nothing) instead of
high-entropy interleaved rows. zstd's LZ77 window can't reach across rows to find that
structure; column-major hands it to the coder directly.

Why this can beat zstd-19 AND CSF-Omni: Omni only swaps *whole-blob* entropy coders —
none of them reshape records. See docs/research/2026-06-29-csf-beating-zstd.md.

Losslessness is guaranteed two ways: (1) values are captured as *raw source substrings*
(the transform never re-serializes JSON, so number/string/escape formatting is preserved
byte-for-byte); (2) ``forward`` runs ``inverse`` on its own output and raises
``NotApplicable`` unless it reproduces the input exactly. Omni then re-verifies the full
round-trip before selecting any candidate, so a bug here can at worst cause the transform
to be skipped — never to corrupt output.

Placeholder/separator safety: in valid JSON text a raw NUL (0x00) and a raw newline (0x0A)
never appear inside a token (control chars are \\uXXXX-escaped), so NUL is used as the
value placeholder in the skeleton and \\n as the column/line separator.
"""
from __future__ import annotations

import json

_VER = 1                     # legacy reader (existing archives embed v1 payloads)
_VER2 = 2                    # current writer: per-line passthrough + shape-keyed columns
_PLACEHOLDER = 0x00          # marks a value slot in a line skeleton
_SEP = b"\n"                 # column / line separator (never inside a JSON token)
_dec = json.JSONDecoder()


class NotApplicable(Exception):
    """Raised when the input is not column-transposable JSONL (so Omni skips it)."""


def _wvarint(out: bytearray, n: int) -> None:
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return


def _rvarint(buf: bytes, pos: int) -> tuple[int, int]:
    shift = n = 0
    while True:
        b = buf[pos]
        pos += 1
        n |= (b & 0x7F) << shift
        if not (b & 0x80):
            return n, pos
        shift += 7


def _split_line(s: str) -> tuple[list[tuple[int, int]], list[str], int] | None:
    """For a line whose JSON object starts at index 0, return (value_spans, keys,
    obj_end) where value_spans = [(start, end)] of each value's raw source substring,
    keys = the decoded key names in order (the line's *shape signature*), and obj_end
    is the index just past the closing '}'. Bytes after obj_end (e.g. a trailing '\\r')
    are preserved verbatim by the caller. Returns None if not a flat object."""
    if not s or s[0] != "{":
        return None
    n = len(s)
    i = 1
    spans: list[tuple[int, int]] = []
    keys: list[str] = []
    # skip optional space then '}' for empty object
    j0 = i
    while j0 < n and s[j0] in " \t":
        j0 += 1
    if j0 < n and s[j0] == "}":
        return [], [], j0 + 1
    while True:
        while i < n and s[i] in " \t":
            i += 1
        if i >= n or s[i] != '"':
            return None
        try:
            key, j = _dec.raw_decode(s, i)         # key string
        except Exception:
            return None
        while j < n and s[j] in " \t":
            j += 1
        if j >= n or s[j] != ":":
            return None
        vstart = j + 1
        while vstart < n and s[vstart] in " \t":
            vstart += 1
        try:
            _val, k = _dec.raw_decode(s, vstart)   # value (any JSON value)
        except Exception:
            return None
        spans.append((vstart, k))
        keys.append(key)
        while k < n and s[k] in " \t":
            k += 1
        if k >= n:
            return None
        c = s[k]
        if c == ",":
            i = k + 1
            continue
        if c == "}":
            return spans, keys, k + 1
        return None


def forward(data: bytes) -> bytes:
    """Row-major JSONL -> column-major byte layout (invertible). Raises NotApplicable.

    v2 (this writer) fixes the two measured v1 weaknesses on real ledgers:
      1. **Per-line passthrough** — a line that is not a flat JSON object no longer
         disables the transform for the whole corpus (v1 was all-or-nothing, which
         declined the entire 2 MB ``data/csf_memory/raw.jsonl``); such lines are
         carried verbatim in a passthrough stream, in order.
      2. **Shape-keyed columns** — columns are keyed by the line's *shape signature*
         (its ordered tuple of key names), so mixed-schema ledgers (records.jsonl
         carries 3+ record shapes) no longer interleave different fields into the
         same positional column.

    Neither layout dominates measured corpora — shape-keying wins on mixed-schema
    ledgers (+2.0 pp on records.jsonl) but *loses* on near-single-shape streams
    whose optional fields fragment columns (−1.3 pp on conversations). So when
    every line is flat (v1 also applicable), ``forward`` builds BOTH layouts and
    keeps whichever probe-compresses smaller (fast zstd-3, falling back to zlib-6).
    ``inverse`` dispatches on the version byte, so mixed archives are fine; the
    mandatory forward self-check is unchanged.
    """
    if not data or data[0:1] != b"{":
        raise NotApplicable("not JSONL (does not start with '{')")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise NotApplicable("not utf-8") from e
    if "\x00" in text:
        raise NotApplicable("contains NUL")

    trailing_nl = text.endswith("\n")
    body = text[:-1] if trailing_nl else text
    lines = body.split("\n")

    parsed_lines = [_split_line(line) for line in lines]
    if all(p is None for p in parsed_lines):
        raise NotApplicable("no transposable lines")

    candidates = [_build_v2(lines, parsed_lines, trailing_nl)]
    if all(p is not None for p in parsed_lines):
        candidates.append(_build_v1(lines, parsed_lines, trailing_nl))
    result = min(candidates, key=_probe_size) if len(candidates) > 1 else candidates[0]

    # Mandatory self-check: never hand back something that doesn't round-trip.
    if inverse(result) != data:
        raise NotApplicable("round-trip self-check failed")
    return result


def _probe_size(payload: bytes) -> int:
    """Fast proxy for post-entropy-coding size, used only to pick a layout."""
    try:
        import zstandard as _z
        return len(_z.ZstdCompressor(level=3).compress(payload))
    except Exception:
        import zlib as _zl
        return len(_zl.compress(payload, 6))


def _build_v2(lines, parsed_lines, trailing_nl: bool) -> bytes:
    line_tags: list[int] = []            # per line: 0 = passthrough, else shape_id + 1
    passthrough: list[str] = []
    skeletons: list[str] = []            # object lines only, in line order
    shape_ids: dict[tuple[str, ...], int] = {}
    shape_cols: list[list[list[str]]] = []   # per shape -> per field -> values

    for line, parsed in zip(lines, parsed_lines):
        if parsed is None:
            line_tags.append(0)
            passthrough.append(line)
            continue
        spans, keys, _obj_end = parsed
        sig = tuple(keys)
        sid = shape_ids.get(sig)
        if sid is None:
            sid = len(shape_cols)
            shape_ids[sig] = sid
            shape_cols.append([[] for _ in spans])
        cols = shape_cols[sid]
        # skeleton: the EXACT line with each value substring replaced by one NUL,
        # so every other literal byte (keys, separators, trailing '\r', spacing) is kept.
        sk_parts: list[str] = []
        prev = 0
        for ci, (vs, ve) in enumerate(spans):
            sk_parts.append(line[prev:vs])
            sk_parts.append("\x00")
            prev = ve
            cols[ci].append(line[vs:ve])
        sk_parts.append(line[prev:])
        skeletons.append("".join(sk_parts))
        line_tags.append(sid + 1)

    out = bytearray()
    out.append(_VER2)
    out.append(1 if trailing_nl else 0)
    _wvarint(out, len(lines))
    for tag in line_tags:
        _wvarint(out, tag)
    pt_blob = _SEP.join(p.encode("utf-8") for p in passthrough)
    _wvarint(out, len(passthrough))
    _wvarint(out, len(pt_blob))
    out += pt_blob
    sk_blob = _SEP.join(s.encode("utf-8") for s in skeletons)
    _wvarint(out, len(sk_blob))
    out += sk_blob
    _wvarint(out, len(shape_cols))
    for cols in shape_cols:
        _wvarint(out, len(cols))
        for col in cols:
            _wvarint(out, len(col))
            blob = _SEP.join(v.encode("utf-8") for v in col)
            _wvarint(out, len(blob))
            out += blob
    return bytes(out)


def _build_v1(lines, parsed_lines, trailing_nl: bool) -> bytes:
    """The original positional layout — only valid when every line is flat."""
    skeletons: list[str] = []
    columns: list[list[str]] = []
    for line, parsed in zip(lines, parsed_lines):
        spans, _keys, _obj_end = parsed
        sk_parts: list[str] = []
        prev = 0
        for ci, (vs, ve) in enumerate(spans):
            sk_parts.append(line[prev:vs])
            sk_parts.append("\x00")
            prev = ve
            if ci == len(columns):
                columns.append([])
            columns[ci].append(line[vs:ve])
        sk_parts.append(line[prev:])
        skeletons.append("".join(sk_parts))

    out = bytearray()
    out.append(_VER)
    out.append(1 if trailing_nl else 0)
    _wvarint(out, len(lines))
    _wvarint(out, len(columns))
    sk_blob = _SEP.join(s.encode("utf-8") for s in skeletons)
    _wvarint(out, len(sk_blob))
    out += sk_blob
    for col in columns:
        _wvarint(out, len(col))
        blob = _SEP.join(v.encode("utf-8") for v in col)
        _wvarint(out, len(blob))
        out += blob
    return bytes(out)


def inverse(buf: bytes) -> bytes:
    """Version-dispatching reader: v2 (current writer) and v1 (existing archives)."""
    if not buf:
        raise ValueError("CSF-Col: empty payload")
    if buf[0] == _VER2:
        return _inverse_v2(buf)
    if buf[0] == _VER:
        return _inverse_v1(buf)
    raise ValueError("CSF-Col: bad version")


def _inverse_v2(buf: bytes) -> bytes:
    pos = 2
    trailing_nl = buf[1] == 1
    n_lines, pos = _rvarint(buf, pos)
    tags: list[int] = []
    for _ in range(n_lines):
        t, pos = _rvarint(buf, pos)
        tags.append(t)
    n_pt, pos = _rvarint(buf, pos)
    pt_len, pos = _rvarint(buf, pos)
    pt_blob = buf[pos:pos + pt_len]
    pos += pt_len
    passthrough = pt_blob.split(_SEP) if n_pt else []
    sk_len, pos = _rvarint(buf, pos)
    sk_blob = buf[pos:pos + sk_len]
    pos += sk_len
    n_obj = sum(1 for t in tags if t)
    skeletons = sk_blob.split(_SEP) if n_obj else []
    n_shapes, pos = _rvarint(buf, pos)
    shape_cols: list[list[list[bytes]]] = []
    for _ in range(n_shapes):
        n_cols, pos = _rvarint(buf, pos)
        cols: list[list[bytes]] = []
        for _c in range(n_cols):
            cnt, pos = _rvarint(buf, pos)
            blen, pos = _rvarint(buf, pos)
            blob = buf[pos:pos + blen]
            pos += blen
            cols.append(blob.split(_SEP) if cnt else [])
        shape_cols.append(cols)

    pt_cur = 0
    sk_cur = 0
    cursors = [[0] * len(cols) for cols in shape_cols]
    out_lines: list[bytes] = []
    for tag in tags:
        if tag == 0:
            out_lines.append(passthrough[pt_cur])
            pt_cur += 1
            continue
        sid = tag - 1
        sk = skeletons[sk_cur]
        sk_cur += 1
        parts = sk.split(b"\x00")
        rebuilt = bytearray(parts[0])
        for ci in range(len(parts) - 1):
            rebuilt += shape_cols[sid][ci][cursors[sid][ci]]
            cursors[sid][ci] += 1
            rebuilt += parts[ci + 1]
        out_lines.append(bytes(rebuilt))

    result = _SEP.join(out_lines)
    if trailing_nl:
        result += b"\n"
    return result


def _inverse_v1(buf: bytes) -> bytes:
    pos = 0
    if buf[pos] != _VER:
        raise ValueError("CSF-Col: bad version")
    pos += 1
    trailing_nl = buf[pos] == 1
    pos += 1
    n_lines, pos = _rvarint(buf, pos)
    n_cols, pos = _rvarint(buf, pos)
    sk_len, pos = _rvarint(buf, pos)
    sk_blob = buf[pos:pos + sk_len]
    pos += sk_len
    skeletons = sk_blob.split(_SEP) if n_lines else []

    columns: list[list[bytes]] = []
    for _ in range(n_cols):
        cnt, pos = _rvarint(buf, pos)
        blen, pos = _rvarint(buf, pos)
        blob = buf[pos:pos + blen]
        pos += blen
        columns.append(blob.split(_SEP) if cnt else [])

    cursors = [0] * n_cols
    out_lines: list[bytes] = []
    for sk in skeletons:
        parts = sk.split(b"\x00")
        # k placeholders -> k+1 literal parts; pull one value per gap, column by column
        rebuilt = bytearray(parts[0])
        for ci in range(len(parts) - 1):
            rebuilt += columns[ci][cursors[ci]]
            cursors[ci] += 1
            rebuilt += parts[ci + 1]
        out_lines.append(bytes(rebuilt))

    result = _SEP.join(out_lines)
    if trailing_nl:
        result += b"\n"
    return result
