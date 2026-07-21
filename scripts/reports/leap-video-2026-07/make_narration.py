"""Generate per-scene narration for The July Leap via Gemini TTS on Vertex (ADC).

Writes assets/vo1.wav .. vo6.wav (24 kHz mono 16-bit) + prints durations as JSON.
"""
import base64, json, sys, wave
from pathlib import Path
from urllib import request as urlreq

import google.auth
import google.auth.transport.requests

HERE = Path(__file__).parent
ASSETS = HERE / "assets"
ASSETS.mkdir(exist_ok=True)

STYLE = ("Read this warmly and unhurried, like a trusted late-night radio host "
         "delivering good news calmly: ")

SCENES = [
    "Welcome to the July Leap - the monthly postcard from the unisona A I trading desk.",
    "Two thousand dollars, plus twenty a month, through every crash since the year two "
    "thousand. Tonight: ninety-one and a half thousand - versus fifty-four for the "
    "plain index.",
    "July cooled the hot chip stocks, and the champion eased six point four percent. "
    "A dip this size? Twenty-four visits in twenty-six years - and twenty-four new "
    "highs after.",
    "The next twenty dollars? The whole mix, automatically - the S and P, bonds, tech, "
    "a pinch of gold. Eight tickers, one twenty.",
    "Ahead: Alphabet and Tesla report Wednesday; the Fed meets the twenty-eighth. Our "
    "robot watches every minute - so you don't have to.",
    "Practice mode. Not advice. Keep the drip alive.",
]

creds, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
creds.refresh(google.auth.transport.requests.Request())
token = creds.token

CANDIDATES = [
    ("global", "gemini-2.5-flash-tts"),
    ("global", "gemini-2.5-flash-preview-tts"),
    ("us-central1", "gemini-2.5-flash-tts"),
    ("us-central1", "gemini-2.5-flash-preview-tts"),
]


def call(loc, model, text):
    host = "aiplatform.googleapis.com" if loc == "global" else f"{loc}-aiplatform.googleapis.com"
    url = (f"https://{host}/v1/projects/{project}/locations/{loc}"
           f"/publishers/google/models/{model}:generateContent")
    body = {
        "contents": [{"role": "user", "parts": [{"text": STYLE + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Charon"}}},
        },
    }
    req = urlreq.Request(url, data=json.dumps(body).encode(),
                         headers={"Authorization": "Bearer " + token,
                                  "Content-Type": "application/json"})
    with urlreq.urlopen(req, timeout=120) as r:
        return json.load(r)


def pick_endpoint():
    last = None
    for loc, model in CANDIDATES:
        try:
            resp = call(loc, model, "Endpoint check.")
            parts = resp["candidates"][0]["content"]["parts"]
            if any("inlineData" in p for p in parts):
                print(f"# using {loc}/{model}", file=sys.stderr)
                return loc, model
        except Exception as e:  # noqa: BLE001 - try next candidate
            last = f"{loc}/{model}: {e}"
            print("# failed", last, file=sys.stderr)
    raise SystemExit("no TTS endpoint worked; last error: %s" % last)


def save_wav(path, resp):
    parts = resp["candidates"][0]["content"]["parts"]
    blob = next(p["inlineData"] for p in parts if "inlineData" in p)
    mime = blob.get("mimeType", "")
    rate = 24000
    if "rate=" in mime:
        rate = int(mime.split("rate=")[1].split(";")[0])
    pcm = base64.b64decode(blob["data"])
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return len(pcm) / 2 / rate


loc, model = pick_endpoint()
durs = []
for i, text in enumerate(SCENES, 1):
    resp = call(loc, model, text)
    d = save_wav(ASSETS / f"vo{i}.wav", resp)
    durs.append(round(d, 2))
    print(f"# vo{i}.wav {d:.2f}s", file=sys.stderr)
print(json.dumps({"endpoint": f"{loc}/{model}", "durations": durs}))
