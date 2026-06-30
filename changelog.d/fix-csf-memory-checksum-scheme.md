### Fixed
- CSF memory integrity: `trading-memory.js` and `trading-news.js` computed each record's checksum with `JSON.stringify(payload, Object.keys(payload).sort())` — the array argument is a *property allowlist*, not a key sort, so nested `content.*` (the real order/signal/news payload) was excluded from the hash. Every record in `data/csf_memory/raw.jsonl` (373/373) failed `MemoryRecord.verify()` and the digest matched neither the Python nor the other JS writer. Both writers now defer to the shared, content-covering `csf-memory-writer.js` `_checksum`, and resolve the registry via `CSF_MEMORY_PATH` so they no longer write to the repo's real `data/` during tests.

### Changed
- `MemoryRecord.verify()`/`_compute_checksum()` now document that verification is **runtime-local** (Python and JS canonical forms diverge on number formatting) and is **not** wired onto any read/load path — `from_dict()`/`read()`/`query()` never re-verify. `CHECKSUM_SCHEME = "py-json-canonical/v1"` names the Python scheme. Corrected the inaccurate "`rec.verify()` on read path" claim in `docs/ANTI-COLLAPSE-HARDENING.md` (item 12).
- Added `scripts/restamp-csf-memory.js` — an opt-in, dry-run-by-default migration that re-stamps legacy records to the sound scheme (with backup) so `verify()` can be promoted to a read gate later. Not auto-run: it rewrites an append-only registry.

### Tests
- `tests/test_csf_memory_integrity.py` — over the real `data/csf_memory/raw.jsonl` sample: every checksum must attribute to a recognized scheme (`python-canonical` / `js-canonical` / `js-trading-legacy`); an unattributable digest (new incompatible writer or corruption) fails the build. Pins that `verify()` stays runtime-local and does not falsely pass JS-written records.
- `tests/test_csf_memory_writer_integrity.js` — the shared `_checksum` covers nested `content.*`; trading writers isolate to `CSF_MEMORY_PATH`, self-verify, and a source guard blocks reintroducing the broken replacer scheme.
