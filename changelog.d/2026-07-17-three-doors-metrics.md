### Fixed

- game: the Three Doors client called three server endpoints that never existed (404 on every play, part of the #2493 endpoint-404 epic) — resolved per #2507:
  - **`POST /api/metrics/three-doors` is now implemented** by extending `routes/metrics.js` to append the game event to the existing `data/metrics/three-doors-events.jsonl` store (no new store — reuses existing metrics infra). Validates the event name; `{ok:true}` on success, 400 on a missing event.
  - **The dead `/api/three-doors/progress` sync/load calls were removed.** Progress is already persisted in `localStorage` (the sync was best-effort and silently 404'd; `loadProgressFromBackend` was never even called). A per-user server progress store would be new architectural sprawl, so the honest fix is local-only progress + no dead network calls.
- Verified live: `POST /api/metrics/three-doors` returns 200 and appends a record; a missing-event body returns 400; the game page carries no remaining 404-generating calls.
