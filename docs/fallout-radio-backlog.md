# Keystone Radio — Feature Backlog

**Surface:** [`apps/lantern-garage/public/fallout-radio.html`](../apps/lantern-garage/public/fallout-radio.html)
**Frequency:** `101.5 FM` · "Founder's Frequency"
**Tracks:** public-domain 78rpm transfers from the Internet Archive [Great 78 Project](https://archive.org/details/georgeblood), served locally from `/radio/`.

A single self-contained HTML page: a phosphor-green Pip-Boy / tube-radio MP3 player. No build step,
no framework, no server route — drop an `.mp3` in `/radio/` and add a row to the `STATIONS`
array at the bottom of the file. It carries its own CRT theme on purpose (a radio is its own
device, so it ignores the site light/dark theme).

Loop stage: **Act** (media playback is a first-class capability of the personal-AI cockpit —
lookup / docs / resume / code / trade / **media**). Nothing here touches Memory/Reason/Verify.

---

## Shipped (this PR)

### Song list — 6 → 19 tracks
Added 13 period tracks (all Great 78 Project / Internet Archive, served locally):

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

---

## Backlog (next)

### P1 — high value, low risk
- [ ] **Album-art / station-ident artwork** for the Media Session lock screen (generated canvas per station, or a shared Keystone Radio bug).
- [ ] **Crossfade** between tracks (2–3s gain ramp on `ended`) for a continuous-broadcast feel.
- [ ] **DJ patter / station IDs** — short spoken/synth idents between songs (the Three Dog touch). Could be Web-Speech-API TTS so no extra audio files.
- [ ] **Buffer-ahead** the next track's `<audio preload>` so auto-advance is gapless.

### P2 — content + reach
- [ ] **More tracks** to ~24 — the Great 78 fetcher (`scratchpad/fetch_tracks.py` pattern) makes this a metadata-curation job. Wishlist: real Glenn Miller "In the Mood", "Maybe" (Ink Spots), "Crazy He Calls Me", "Uranium Fever", "Atom Bomb Baby" — none currently in the georgeblood collection under a clean transfer; revisit periodically.
- [ ] **Genre/era sub-dials** — group stations (swing / crooners / R&B / novelty) into tunable bands.
- [ ] **Surface it in Explore** as a richer card (it's already linked); consider an inline mini-player embed.

### P3 — depth
- [ ] **Real analog tuning dial** — a draggable needle across a frequency scale that snaps to stations, with static swelling between them.
- [ ] **Equalizer** — a 3-band BiquadFilter chain with a "warm tube" preset (rolled-off highs, bumped mids).
- [ ] **Request line** — let a signed-in user pin a Great 78 identifier to their own station list (writes to a per-user JSONL, dogfoods the Memory store).
- [ ] **Waveform seek bar** — render the track's peaks behind the seek slider.

### Known gaps / risks
- **Repo size**: 14 mp3s ≈ 69 MB committed raw (no LFS — the LFS endpoint is unprovisioned). Past ~24 tracks, consider a CSF audio shard or a CDN.
- **Licensing**: framed as Great 78 Project / Internet Archive archival transfers (matching the existing footer), not asserted as cleared for any use.
- **Autoplay policy**: first play requires a user gesture (handled — the click *is* the gesture).

---

## How to add a track
1. Find a transfer on the [Great 78 Project](https://archive.org/details/georgeblood) (`collection:georgeblood`).
2. Download its `VBR MP3` derivative into `apps/lantern-garage/public/radio/<slug>.mp3`.
3. Add one row to the `STATIONS` array at the bottom of `fallout-radio.html` (freq, title, artist, year, src, lore).
4. That's it — render, transport, deep-link, and Media Session all pick it up automatically.
