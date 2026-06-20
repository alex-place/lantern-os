#!/usr/bin/env python3
"""Real face detection for facecam localization (OpenCV).

Samples frames (via ffmpeg, fast) from the first ~45s of a video, runs Haar
frontal + profile face detection, clusters the most persistent face, and reports
JSON on stdout:

    ok, detection_rate, stability, face_box, facecam_box, samples, hits

- detection_rate : fraction of sampled frames with a face in the dominant cluster
- stability      : 1 - normalized spread of face centres (1 = rock-steady)
- face_box       : median face rect (normalized x,y,w,h)
- facecam_box    : face box expanded to a webcam-sized region, edge-snapped

This replaces the heuristic skin/motion guess with an actual face model so the
facecam confidence gate (>=0.85) fires on real cams and stays silent otherwise.
No model download required — uses the cascades bundled with opencv-python.

Usage: python facecam_face_detect.py <video> [max_samples]
"""
import sys
import os
import json
import glob
import tempfile
import shutil
import subprocess
import statistics as st


def emit(obj):
    print(json.dumps(obj))


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "reason": "no video path"}); return
    path = sys.argv[1]
    max_samples = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    try:
        import cv2
    except Exception as e:
        emit({"ok": False, "reason": "opencv unavailable: %s" % e}); return

    # Fast frame sampling with ffmpeg: ~1 fps, 640px wide, first 45s.
    tmp = tempfile.mkdtemp(prefix="facedet_")
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-t", "32",
             "-vf", "fps=1,scale=640:-1", "-q:v", "3", os.path.join(tmp, "f_%03d.jpg")],
            timeout=90, check=False,
        )
        frames = sorted(glob.glob(os.path.join(tmp, "f_*.jpg")))[:max_samples]
        if not frames:
            emit({"ok": False, "reason": "no frames extracted (ffmpeg)"}); return

        front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")

        samples = 0
        boxes = []  # (cx, cy, w, h) normalized — largest face per frame
        for fp in frames:
            img = cv2.imread(fp)
            if img is None:
                continue
            samples += 1
            gh, gw = img.shape[0], img.shape[1]
            g = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
            found = list(front.detectMultiScale(g, 1.1, 6, minSize=(24, 24)))
            found += list(profile.detectMultiScale(g, 1.1, 6, minSize=(24, 24)))
            found += [(gw - (x + w), y, w, h) for (x, y, w, h) in profile.detectMultiScale(cv2.flip(g, 1), 1.1, 6, minSize=(24, 24))]
            if found:
                x, y, w, h = max(found, key=lambda b: b[2] * b[3])
                boxes.append(((x + w / 2) / gw, (y + h / 2) / gh, w / gw, h / gh))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if not boxes:
        emit({"ok": True, "detection_rate": 0.0, "stability": 0.0, "samples": samples, "hits": 0, "face_box": None, "facecam_box": None})
        return

    # Cluster to the dominant location: boxes near the median centre.
    mcx, mcy = st.median([b[0] for b in boxes]), st.median([b[1] for b in boxes])
    near = [b for b in boxes if abs(b[0] - mcx) < 0.12 and abs(b[1] - mcy) < 0.18]
    if len(near) < max(1, len(boxes) // 3):
        near = boxes
    detection_rate = len(near) / max(1, samples)
    sx = st.pstdev([b[0] for b in near]) if len(near) > 1 else 0.0
    sy = st.pstdev([b[1] for b in near]) if len(near) > 1 else 0.0
    stability = max(0.0, 1.0 - (sx + sy) / 0.12)

    cx, cy = st.median([b[0] for b in near]), st.median([b[1] for b in near])
    fw, fh = st.median([b[2] for b in near]), st.median([b[3] for b in near])
    face_box = {"x": round(cx - fw / 2, 3), "y": round(cy - fh / 2, 3), "width": round(fw, 3), "height": round(fh, 3)}

    ew, eh = min(1.0, fw * 1.7), min(1.0, fh * 2.1)
    ex = min(max(0.0, cx - ew / 2), 1 - ew)
    ey = min(max(0.0, cy - eh * 0.42), 1 - eh)  # face sits in the upper part of a cam
    # Snap edge-hugging cams to the frame edge (webcams usually touch an edge).
    if ex < 0.10: ex = 0.0
    elif ex + ew > 0.90: ex = max(0.0, 1 - ew)
    if ey < 0.08: ey = 0.0
    elif ey + eh > 0.92: ey = max(0.0, 1 - eh)
    facecam_box = {"x": round(ex, 3), "y": round(ey, 3), "width": round(ew, 3), "height": round(eh, 3)}

    emit({
        "ok": True,
        "detection_rate": round(detection_rate, 3),
        "stability": round(stability, 3),
        "samples": samples,
        "hits": len(near),
        "face_box": face_box,
        "facecam_box": facecam_box,
    })


if __name__ == "__main__":
    main()
