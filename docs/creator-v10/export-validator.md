# ExportValidator

A hard gate that runs **before** any final render is accepted. It uses `ffprobe` (real measurement) to verify the output meets short-form spec. On any failure the export is **blocked** with a concrete reason — no silent pass.

This is the one V10 component that is fully implementable and honest on day one, because it operates entirely on a real output file. It ships with its flag **on** by default (`exportValidator` / `LANTERN_CI_EXPORT_VALIDATOR`).

## Checks

| Check | Source | Pass condition |
|---|---|---|
| resolution | `ffprobe` stream width/height | exactly `1080×1920` (configurable target) |
| fps | `ffprobe` avg/r_frame_rate | ≥ `minFps` (default 30; target 60) |
| video codec | `ffprobe` codec_name | in allowlist (`h264` default) |
| audio present | `ffprobe` audio stream exists | at least one audio stream |
| duration | `ffprobe` format.duration | `15 ≤ d ≤ 60` seconds |
| captions rendered | caption-burn manifest + frame check | if captions requested, burned-in track/region confirmed |
| file integrity | `ffprobe` exit code | probes cleanly (not truncated/corrupt) |

`captions rendered` is verified against the editor's own burn manifest (did we ask for captions, and did the burn step run); a deeper OCR confirmation is a later enhancement and is explicitly labeled as not-yet-implemented rather than assumed.

## Result shape

```json
{
  "ok": false,
  "checks": [
    { "name": "resolution", "ok": true,  "expected": "1080x1920", "actual": "1080x1920" },
    { "name": "duration",   "ok": false, "expected": "5-60s",      "actual": "72.4s" },
    { "name": "audio",      "ok": true,  "actual": "aac stereo" }
  ],
  "blockedReasons": ["duration 72.4s exceeds 60s limit"],
  "probedAt": "ISO-8601"
}
```

`actual` values come straight from ffprobe — every verdict is traceable to a measurement.

## Behavior

- `ok: true` → export proceeds.
- `ok: false` → export is blocked; `blockedReasons[]` is surfaced in the UI verbatim.
- ffprobe unavailable → `{ ok:false, blockedReasons:["ffprobe not available — cannot validate export"] }`. We block rather than pass-through, because an unvalidated export must not be presented as validated.

## API

```js
const { validateExport } = require("../../src/creator-intelligence"); // re-exported
const result = await validateExport(outputPath, {
  targetWidth: 1080, targetHeight: 1920, minFps: 30,
  minDuration: 5, maxDuration: 60, videoCodecAllow: ["h264"],
  requireAudio: true, captionsExpected: true
});
if (!result.ok) { /* block + show result.blockedReasons */ }
```

## Integration

Called in `routes/creator-entries.js` (and any export job in `job-worker.js`) immediately after the final ffmpeg render completes and before the render path is saved to the entry / exposed via `/media/`.
