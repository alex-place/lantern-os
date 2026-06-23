"""Adversarial round-trip + determinism test for CSF-Omni (src/csf/omni.py).

Asserts for MANY inputs across effort tiers and portable flag:
  1. decompress(compress_best(x)) == x   (losslessness, byte-equal)
  2. compress_best(x) == compress_best(x) (determinism, byte-equal)
Reports every FAIL with an exact description of the offending input/config.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csf import omni  # noqa: E402

# Pre-make some fixed blobs we reference by name in case descriptions.
_brotli_input = b"the quick brown fox jumps over the lazy dog. " * 50
try:
    import brotli as _brotli_mod
    _already_brotli = _brotli_mod.compress(_brotli_input, quality=11)
except Exception:
    import bz2 as _bz2_mod
    _already_brotli = _bz2_mod.compress(_brotli_input, 9)  # fallback "already-compressed"

# Build the input corpus: list of (description, input_object).
# Note: we keep the ORIGINAL object (incl. bytearray) so we exercise non-bytes input.
cases = []
cases.append(("empty b''", b""))
cases.append(("single byte 0x00", b"\x00"))
cases.append(("single byte 0xFF", b"\xff"))
cases.append(("two bytes 0x00 0xFF", b"\x00\xff"))
for n in (2, 7, 16, 255, 256, 257, 1024, 4096):
    cases.append((f"all-same-byte 0x00 run len={n}", b"\x00" * n))
    cases.append((f"all-same-byte 0xFF run len={n}", b"\xff" * n))
    cases.append((f"all-same-byte 0x41 run len={n}", b"A" * n))
# every single byte value 0x00..0xFF as a 1-byte input
for v in range(256):
    cases.append((f"single byte value 0x{v:02x}", bytes([v])))
# incrementing ramp (good for delta transform)
cases.append(("256-byte incrementing ramp", bytes(range(256))))
cases.append(("4096-byte repeating ramp", bytes(range(256)) * 16))
# os.urandom of several sizes (incl. > 0)
for n in (1, 2, 3, 8, 15, 31, 64, 100, 255, 256, 257, 1000, 4096, 65537):
    cases.append((f"os.urandom({n})", os.urandom(n)))
# highly repetitive text
cases.append(("repetitive text 'ab'*5000", b"ab" * 5000))
cases.append(("repetitive line JSONL-ish * 2000",
              b'{"k":"v","n":123,"flag":true}\n' * 2000))
cases.append(("repetitive whitespace * 10000", b" \t\n" * 10000))
# valid utf-8
cases.append(("valid utf-8 ascii", "Hello, world!".encode("utf-8")))
cases.append(("valid utf-8 multibyte", "héllo — 世界 — café — \U0001F680".encode("utf-8")))
cases.append(("valid utf-8 long mixed",
              ("σ₀ Convergence λ→∞ ∑ ∏ ✓ ✗ 日本語テキスト " * 300).encode("utf-8")))
# invalid utf-8 byte sequences
cases.append(("invalid utf-8 lone continuation 0x80", b"\x80"))
cases.append(("invalid utf-8 truncated 2-byte lead", b"\xc3"))
cases.append(("invalid utf-8 overlong/illegal mix", b"\xff\xfe\xc0\xc1\x80\x80abc\xed\xa0\x80"))
cases.append(("invalid utf-8 random high bytes",
              bytes((i * 37 + 200) & 0xFF for i in range(500))))
# already-brotli-compressed bytes (low entropy already removed)
cases.append(("already-brotli-compressed input", _already_brotli))
cases.append(("already-brotli, doubled", _already_brotli + _already_brotli))
# bytearray input (non-bytes container)
cases.append(("bytearray of 'mutable payload here' * 100",
              bytearray(b"mutable payload here " * 100)))
cases.append(("bytearray empty", bytearray(b"")))
cases.append(("bytearray of os.urandom(300)", bytearray(os.urandom(300))))
# 2 MB random and 2 MB repetitive blobs
cases.append(("2MB random os.urandom", os.urandom(2 * 1024 * 1024)))
cases.append(("2MB repetitive 'X'*2MB", b"X" * (2 * 1024 * 1024)))
cases.append(("2MB repetitive line block",
              (b'{"event":"tick","seq":0,"payload":"aaaaaaaaaa"}\n' *
               ((2 * 1024 * 1024) // 47 + 1))[: 2 * 1024 * 1024]))

EFFORTS = ["fast", "max", "exhaustive"]
PORTABLES = [False, True]

failures = []
total_checks = 0
roundtrip_checks = 0
determinism_checks = 0

for desc, obj in cases:
    # The "expected" bytes are bytes(obj); compress_best converts internally.
    try:
        expected = bytes(obj)
    except Exception as e:
        failures.append(f"[setup] {desc}: cannot bytes() input: {e!r}")
        continue

    for effort in EFFORTS:
        for portable in PORTABLES:
            cfg = f"effort={effort} portable={portable}"
            # --- round-trip ---
            try:
                blob1 = omni.compress_best(obj, effort=effort, portable=portable)
            except Exception as e:
                failures.append(f"[compress raised] {desc} | {cfg}: {type(e).__name__}: {e}")
                continue
            roundtrip_checks += 1
            total_checks += 1
            try:
                out = omni.decompress(blob1)
            except Exception as e:
                failures.append(f"[decompress raised] {desc} | {cfg}: {type(e).__name__}: {e}")
                continue
            if out != expected:
                failures.append(
                    f"[ROUNDTRIP MISMATCH] {desc} | {cfg}: "
                    f"in_len={len(expected)} out_len={len(out)} "
                    f"method={omni.describe(blob1)}"
                )

            # --- determinism: recompute and compare blob bytes ---
            try:
                blob2 = omni.compress_best(obj, effort=effort, portable=portable)
            except Exception as e:
                failures.append(f"[compress#2 raised] {desc} | {cfg}: {type(e).__name__}: {e}")
                continue
            determinism_checks += 1
            total_checks += 1
            if blob1 != blob2:
                failures.append(
                    f"[NONDETERMINISTIC] {desc} | {cfg}: "
                    f"blob1_len={len(blob1)} blob2_len={len(blob2)} "
                    f"method1={omni.describe(blob1)} method2={omni.describe(blob2)}"
                )

# Extra determinism stress: compress the SAME input 5 times in a row, one config.
stress_input = os.urandom(1000) + b"\x00" * 1000 + b"ab" * 1000
blobs = [omni.compress_best(stress_input, effort="exhaustive", portable=False) for _ in range(5)]
total_checks += 1
if len(set(blobs)) != 1:
    failures.append(f"[NONDETERMINISTIC x5] mixed 3k input produced {len(set(blobs))} distinct blobs")
else:
    determinism_checks += 1

# Sanity: invalid blob must raise (not silently corrupt) — not a round-trip, but
# confirms decompress doesn't accept garbage as if lossless.
bad_raised = False
try:
    omni.decompress(b"not-a-csf-omni-blob")
except ValueError:
    bad_raised = True
except Exception:
    bad_raised = True

# Report ----------------------------------------------------------------------
print(f"environment: zstd={'yes' if omni._zstd else 'no'} brotli={'yes' if omni._brotli else 'no'}")
print(f"codec ids available: {sorted(omni.CODECS.keys())}")
print(f"input cases: {len(cases)}")
print(f"configs per case: {len(EFFORTS) * len(PORTABLES)} (efforts={EFFORTS} portable={PORTABLES})")
print(f"total checks: {total_checks}")
print(f"  round-trip checks: {roundtrip_checks}")
print(f"  determinism checks: {determinism_checks}")
print(f"invalid-blob raised as expected: {bad_raised}")
print(f"FAILURES: {len(failures)}")
for f in failures[:50]:
    print("  FAIL:", f)
if len(failures) > 50:
    print(f"  ... and {len(failures) - 50} more")

print("RESULT:", "PASS" if not failures else "FAIL")
sys.exit(0 if not failures else 1)
