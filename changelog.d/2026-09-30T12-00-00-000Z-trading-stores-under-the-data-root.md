### Fixed

- trading: per-user trading stores (broker credentials, trader and account mode, broker preference, tradelists, journal layout, trade notes, engine state, trade journal, heartbeat) now live under the data root, which is the persistent volume on the hosted deployment, so a deploy no longer wipes them; a store found at its old location is copied across once and never overwritten, and the kill switch is honoured on the volume as well as in the repo folder (ADR-0035 step 1)
