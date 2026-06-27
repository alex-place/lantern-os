# Keystone Radio — Feature Backlog

**Surface:** [`apps/lantern-garage/public/fallout-radio.html`](../apps/lantern-garage/public/fallout-radio.html)
**Frequency:** `101.5 FM` · "Founder's Frequency"
**Tracks:** public-domain 78rpm transfers from the Internet Archive [Great 78 Project](https://archive.org/details/georgeblood), served locally from `/radio/`.

A single self-contained HTML page: a phosphor-green Pip-Boy / tube-radio MP3 player. No build step,
no framework, no server route. It carries its own CRT theme on purpose (a radio is its own
device, so it ignores the site light/dark theme).

Loop stage: **Act** (media playback is a first-class capability of the personal-AI cockpit —
lookup / docs / resume / code / trade / **media**). Nothing here touches Memory/Reason/Verify.

### Library architecture (300+ offline tracks, lean repo)
The playlist is a committed manifest — [`apps/lantern-garage/public/radio/stations.json`](../apps/lantern-garage/public/radio/stations.json)
(small JSON: title/artist/year/freq/lore/src + the Internet-Archive `ia`/`iaf` source for each). The
player `fetch()`es it on load (with the inline 25 as an offline fallback). The **audio files are NOT
committed** — at 300+ tracks that's hundreds of MB. They are gitignored and populated locally, once
per machine, by **[`scripts/fetch_radio_audio.py`](../scripts/fetch_radio_audio.py)**, which downloads
each Great 78 transfer and re-encodes it to 64 kbps mono. After the fetch, the radio plays fully
**offline**. Missing files degrade gracefully (the player shows `SIGNAL LOST` and auto-skips), so a
partial fetch still works. Add tracks by appending manifest rows + re-running the fetch.

---

## Shipped

### Song list — 25 → 273 tracks
Expanded into a full offline jukebox: Great 78 Project sides (creator-based harvest
across ~58 era greats — Sinatra, Crosby, the Andrews Sisters, Glenn Miller, the Ink Spots, Ella,
Billie Holiday, Ellington, Goodman, Nat King Cole, Louis Jordan, Fats Waller, Spike Jones, Roy
Brown, Doris Day, Lena Horne, Sarah Vaughan, and more), curated + **de-duplicated** into
`stations.json` (**273 total** — same-song repeats and library/canonical overlaps removed).
A **search box** in the dial filters by song / artist. The 25 hand-curated canonical tracks below
keep their lore and frequencies.

### Song list — the canonical 25
Hand-curated core (Great 78 Project / Internet Archive), committed to git so they work out of the box:

| Freq | Title | Artist | Year |
|------|-------|--------|------|
| 100.7 | Butcher Pete (Part 1) | Roy Brown & His Mighty-Mighty Men | 1949 |
| 103.9 | A String of Pearls | Glenn Miller & His Orchestra | 1941 |
| 90.9 | Stormy Weather | Cliff Lang & His All-Star Orchestra | 1946 |
| 96.5 | It's a Sin to Tell a Lie | Frank "Big Boy" Goodie et son Orchestre | 1939 |
| 99.3 | A Wonderful Guy | Joe Loss & His Orchestra | 1949 |
| 107.1 | Anything Goes | Jack Payne & His Band | 1935 |
| 94.7 | Dream a Little Dream of Me | Lawrence "Piano Roll" Cook | c.1950 |
| 102.3 | Diane | Buddy Lucas & His Band of Tomorrow | 1951 |
| 93.5 | In the Blue Evening | Tommy Dorsey & Frank Sinatra | 1943 |
| 104.5 | From the Bottom of My Heart | Harry James & Frank Sinatra | 1945 |
| 95.5 | All of Me | Dean Martin & Nat Brandwynne's Orchestra | 1946 |
| 97.7 | I Got the Sun in the Morning | Dean Martin & Nat Brandwynne's Orchestra | 1946 |
| 91.5 | A Dream Is a Wish Your Heart Makes | Perry Como | 1950 |
| 92.9 | Pennsylvania 6-5000 | Glenn Miller & His Orchestra | 1940 |
| 94.1 | Don't Sit Under the Apple Tree | Glenn Miller & His Orchestra | 1942 |
| 98.1 | Heartaches | Airlane Trio & Ted Martin | 1947 |
| 100.1 | Sentimental Journey | Paul Fenoulhet & The Skyrockets | 1945 |
| 103.1 | Blue Moon | Page Cavanaugh Trio | 1948 |
| 105.9 | I'll Be Seeing You | Geraldo & His Orchestra | 1944 |

Crooner note: these are authentic 1940s sides — Sinatra's Dorsey/James-era recordings, Dean Martin's pre-fame Brandwynne sessions, Como's early Victor side. The iconic Fallout: New Vegas Dean Martin cut, *Ain't That a Kick in the Head* (1960), is **not** in the public-domain Great 78 set, so it isn't included.

Continuous playback: a finished song now rolls straight into the next and the dial wraps past the end (a radio never stops); `repeat: one` loops the current track.

### CRT refinement
- **Screen curvature** — bulged glass via layered inset shadows + corner vignette.
- **Vignette + glare** — soft diagonal highlight and darkened edges over the screen.
- **Rolling scanline** — a bright band drifts down the tube (the classic horizontal-hold roll).
- **Chromatic aberration** — RGB split on the "now playing" title.
- **Animated static/noise** — faint phosphor grain on the screen layer.
- **Power-on flash** — CRT "turn-on" bloom the first time you press play.
- All motion respects `prefers-reduced-motion`.

### Features
- **Search the dial** — a filter box matches the full song list by song / artist / freq / year (live count, e.g. `2 / 273`).
- **Deep-link by frequency** — `fallout-radio.html#101.5` tunes straight to that station on load.
- **Persistence** — last station, volume, mute, shuffle/repeat restored from `localStorage`.
- **Keyboard transport** — Space, ←/→ (seek), ↑/↓ (volume), `[`/`]` (prev/next), `M`, `S`, `R`.
- **Shuffle** + **Repeat** (off / all / one).
- **Mute** toggle.
- **Tuning static** — a short synthesized noise burst between stations (toggleable "DX" button).
- **Media Session API** — OS / lock-screen media controls + now-playing metadata.
- **Now-playing marquee** — long titles scroll.
- **Loading / error states** — "TUNING…" while buffering; "SIGNAL LOST" auto-skips a dead track.
- **Visualizer modes** — click the VU meter to cycle bars → oscilloscope → mirrored.
- **Sleep timer** — off / 15 / 30 / 60 min, fades out and stops.

### Performance
- **Compact audio** — all tracks re-encoded to **96 kbps mono** (78rpm sources are mono and band-limited, so this is transparent). Cut the on-disk/served footprint from ~96 MB (19 tracks) to ~62 MB (25 tracks) — smaller downloads, faster track starts.
- **Idle visualizer** — the `requestAnimationFrame` loop now runs *only* while audio is playing **and** the tab is visible (Page Visibility API). Paused or backgrounded, it draws one idle frame and stops — no rAF churn, no canvas work, no battery drain. Restarts on play / tab-visible.

---

## Backlog (next)

### P1 — high value, low risk
- [ ] **Album-art / station-ident artwork** for the Media Session lock screen (generated canvas per station, or a shared Keystone Radio bug).
- [ ] **Crossfade** between tracks (2–3s gain ramp on `ended`) for a continuous-broadcast feel.
- [ ] **DJ patter / station IDs** — short spoken/synth idents between songs (the Three Dog touch). Could be Web-Speech-API TTS so no extra audio files.
- [ ] **Buffer-ahead** the next track's `<audio preload>` so auto-advance is gapless.

### P2 — content + reach
- [ ] **More tracks** — the Great 78 fetcher (`scratchpad/fetch_tracks.py` pattern) makes this a metadata-curation job. Still-wanted (not found under a clean georgeblood transfer yet): real Glenn Miller "In the Mood", Ink Spots "Maybe", Billie Holiday "Crazy He Calls Me", Roy Brown "Mighty Mighty Man", "Uranium Fever", "Atom Bomb Baby"; revisit periodically. Note many standards on georgeblood are British/dance-band covers rather than the iconic US original — verify the ID3 artist, not just the title.
- [ ] **Genre/era sub-dials** — group stations (swing / crooners / R&B / novelty) into tunable bands.
- [ ] **Surface it in Explore** as a richer card (it's already linked); consider an inline mini-player embed.

### P3 — depth
- [ ] **Real analog tuning dial** — a draggable needle across a frequency scale that snaps to stations, with static swelling between them.
- [ ] **Equalizer** — a 3-band BiquadFilter chain with a "warm tube" preset (rolled-off highs, bumped mids).
- [ ] **Request line** — let a signed-in user pin a Great 78 identifier to their own station list (writes to a per-user JSONL, dogfoods the Memory store).
- [ ] **Waveform seek bar** — render the track's peaks behind the seek slider.

### Known gaps / risks
- **Repo size — solved**: the bulk audio (300+ tracks, hundreds of MB) is no longer committed. It's gitignored and fetched locally from the committed manifest (`scripts/fetch_radio_audio.py`). The 25 canonical tracks committed earlier stay tracked; everything new is fetched, so the library can grow without touching git size.
- **Offline = fetch-once**: each new machine / worktree runs the fetch script once (online) to populate `/radio/`. After that it's fully offline. lantern-os.net (the stable worktree) needs the fetch run there once the manifest deploys.
- **Library curation**: the 276 harvested tracks are creator-based Great 78 pulls — mostly the named artist, but some are session/B-side oddities (volume over hand-curation). The 25 canonical core stays hand-picked.
- **Licensing**: framed as Great 78 Project / Internet Archive archival transfers (matching the existing footer), not asserted as cleared for any use.
- **Autoplay policy**: first play requires a user gesture (handled — the click *is* the gesture).

---

## How to add a track
1. Find a transfer on the [Great 78 Project](https://archive.org/details/georgeblood) (`collection:georgeblood`); note its item `identifier` and the `VBR MP3` filename.
2. Append a row to `apps/lantern-garage/public/radio/stations.json`: `{ "freq", "title", "artist", "year", "src": "/radio/<slug>.mp3", "lore", "ia": "<identifier>", "iaf": "<filename>" }`.
3. Run `python scripts/fetch_radio_audio.py` — it downloads + re-encodes any missing tracks to 64 kbps mono.
4. That's it — the player loads the manifest, and render / search / transport / deep-link / Media Session pick it up automatically.

(A canonical track you want committed to git can skip `ia`/`iaf`, drop its mp3 into `/radio/`, and `git add -f` it.)
