"""Synthesize the July Leap ambient bed: 66.5s warm pad, Am9-Fmaj7-Cmaj7-Gadd9.

Deterministic (no randomness). Writes assets/music.wav (44.1kHz mono 16-bit).
"""
import math, wave
from pathlib import Path

import numpy as np

SR = 44100
DUR = 66.5
N = int(SR * DUR)
t = np.arange(N) / SR

NOTE = {"A2":110.0,"F2":87.31,"C3":130.81,"G2":98.0,"A3":220.0,"F3":174.61,"C4":261.63,
        "G3":196.0,"B3":246.94,"E4":329.63,"G4":392.0,"D4":293.66,"B4":493.88,"A4":440.0,
        "E3":164.81}

CHORDS = [
    ["A2","A3","C4","E4","B3"],      # Am(add9)
    ["F2","F3","A3","C4","E4"],      # Fmaj7
    ["C3","G3","C4","E4","G4"],      # C
    ["G2","G3","B3","D4","A4"],      # G(add9)
]
SEG = DUR / len(CHORDS)              # ~16.6s per chord
XFADE = 3.0

mix = np.zeros(N)
for i, chord in enumerate(CHORDS):
    t0, t1 = i * SEG, (i + 1) * SEG
    env = np.clip((t - (t0 - XFADE / 2)) / XFADE, 0, 1) * np.clip(((t1 + XFADE / 2) - t) / XFADE, 0, 1)
    if i == 0:
        env = np.clip(t / 2.5, 0, 1) * np.clip(((t1 + XFADE / 2) - t) / XFADE, 0, 1)
    layer = np.zeros(N)
    for k, name in enumerate(chord):
        f = NOTE[name]
        amp = 1.0 / (1.6 + k)
        wob = 1.0 + 0.006 * np.sin(2 * math.pi * (0.07 + 0.013 * k) * t + k * 1.7)
        for det in (-0.0012, 0.0012):
            layer += amp * np.sin(2 * math.pi * f * (1 + det) * t * wob + k * 0.9)
        layer += 0.35 * amp * np.sin(2 * math.pi * 2 * f * t + k)          # soft octave
    root = NOTE[chord[0]]
    layer += 0.8 * np.sin(2 * math.pi * (root / 2) * t)                     # sub
    mix += env * layer

# gentle shimmer: slow high pentatonic swells (deterministic schedule)
for j, (start, note) in enumerate([(6,"E4"),(14,"A4"),(23,"G4"),(31,"B4"),(39,"E4"),
                                    (47,"A4"),(55,"G4"),(61,"B4")]):
    f = NOTE[note] * 2
    seg = np.clip((t - start) / 2.5, 0, 1) * np.clip((start + 6 - t) / 3.5, 0, 1)
    mix += 0.05 * seg * np.sin(2 * math.pi * f * t + j)

mix = np.tanh(mix * 0.24)                                # soft glue
mix *= np.clip(t / 2.0, 0, 1) * np.clip((DUR - t) / 4.0, 0, 1)   # edge fades
mix = mix / np.max(np.abs(mix)) * 0.55
pcm = (mix * 32767).astype(np.int16)

out = Path(__file__).parent / "assets" / "music.wav"
with wave.open(str(out), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", out, f"{DUR}s")
