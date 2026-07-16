### Fixed

- images: `POST /api/image/generate` and `POST /api/image/upload` responded never (they used the promise-style `collectRequestBody` as if it took a callback, so every request hung to client timeout), and generate additionally shelled out via a blocking, string-interpolated `execSync` that would have stalled the whole event loop for up to 120s (#2500). Both handlers are now async; generation runs through non-blocking `execFile` with an argv array (no shell). Verified live: generation completes while `/api/health` keeps answering in ~2ms.
