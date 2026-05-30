param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$Source,
    [string]$Output,
    [string]$RemoteUrl = "https://github.com/alex-place/lantern-os",
    [string]$ArtDir = "skills/lantern-rag-dollhouse/assets/images/comet-leap-30day",
    [string]$ChartDir = "skills/lantern-rag-dollhouse/assets/images/charts"
)

$ErrorActionPreference = "Stop"

if (-not $Source) { throw "Source is required." }
if (-not $Output) { throw "Output is required." }

$sourcePath = Join-Path $Root $Source
$outputPath = Join-Path $Root $Output
$outputDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$python = @"
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.utils import ImageReader
import math

root = Path(r"$Root")
source = root / r"$Source"
output = root / r"$Output"
remote = r"$RemoteUrl"
art_dir = root / r"$ArtDir"
chart_dir = root / r"$ChartDir"

art_paths = sorted([p for p in art_dir.glob("*.png") if p.is_file()])
chart_paths = sorted([p for p in chart_dir.glob("*.png") if p.is_file()])
visual_paths = chart_paths + art_paths

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Small", parent=styles["BodyText"], fontSize=9.4, leading=12.4))
styles.add(ParagraphStyle(name="Codeish", parent=styles["BodyText"], fontName="Courier", fontSize=9.0, leading=12.0))
styles.add(ParagraphStyle(name="Callout", parent=styles["BodyText"], fontSize=11.2, leading=14.5, textColor=colors.white))
styles["Title"].fontName = "Helvetica-Bold"
styles["Title"].fontSize = 24
styles["Title"].leading = 28
styles["Heading1"].fontName = "Helvetica-Bold"
styles["Heading1"].fontSize = 17
styles["Heading1"].leading = 21
styles["Heading2"].fontName = "Helvetica-Bold"
styles["Heading2"].fontSize = 13
styles["Heading2"].leading = 17
styles["BodyText"].fontName = "Helvetica"
styles["BodyText"].fontSize = 11
styles["BodyText"].leading = 14.5
styles["BodyText"].textColor = colors.white
styles["Heading1"].textColor = colors.white
styles["Heading2"].textColor = colors.white
styles["Title"].textColor = colors.white
styles["Small"].textColor = colors.white
styles["Codeish"].textColor = colors.white

def safe(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("`", "")

def para(text, style="BodyText"):
    return Paragraph(safe(text), styles[style])

def draw_image_cover(canvas, image_path, x, y, w, h):
    try:
        img = ImageReader(str(image_path))
        iw, ih = img.getSize()
        scale = max(w / iw, h / ih)
        sw, sh = iw * scale, ih * scale
        canvas.drawImage(img, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh, mask="auto")
    except Exception:
        return

def draw_page_art(canvas, doc):
    width, height = letter
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#0b1220"))
    canvas.rect(0, 0, width, height, fill=1, stroke=0)

    if visual_paths:
        art = visual_paths[(doc.page - 1) % len(visual_paths)]
        if hasattr(canvas, "setFillAlpha"):
            canvas.setFillAlpha(0.18)
        draw_image_cover(canvas, art, 0, 0, width, height)
        if hasattr(canvas, "setFillAlpha"):
            canvas.setFillAlpha(1)

        canvas.setStrokeColor(colors.white)
        canvas.setLineWidth(0.8)
        canvas.roundRect(6.38 * inch, 0.48 * inch, 1.05 * inch, 1.05 * inch, 8, fill=0, stroke=1)
        draw_image_cover(canvas, art, 6.38 * inch, 0.48 * inch, 1.05 * inch, 1.05 * inch)

    # Tesseract dot-line overlay: tuned for B&W laser printing
    if hasattr(canvas, "setStrokeAlpha"):
        canvas.setStrokeAlpha(0.35)
    if hasattr(canvas, "setFillAlpha"):
        canvas.setFillAlpha(0.40)
    canvas.setStrokeColor(colors.white)
    canvas.setFillColor(colors.white)
    cx, cy = width * 0.5, height * 0.52
    layers = [220, 165, 118, 82]
    points = []
    for ridx, r in enumerate(layers):
        ring = []
        for i in range(12):
            a = (math.pi * 2 * i / 12.0) + (ridx * 0.19)
            x = cx + math.cos(a) * r
            y = cy + math.sin(a) * r
            ring.append((x, y))
            canvas.circle(x, y, 1.5 if ridx < 2 else 1.2, stroke=0, fill=1)
        points.append(ring)
    canvas.setLineWidth(0.45)
    for ring in points:
        for i in range(len(ring)):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % len(ring)]
            canvas.line(x1, y1, x2, y2)
    for i in range(12):
        for ridx in range(len(points) - 1):
            x1, y1 = points[ridx][i]
            x2, y2 = points[ridx + 1][(i + 2) % 12]
            canvas.line(x1, y1, x2, y2)
    if hasattr(canvas, "setStrokeAlpha"):
        canvas.setStrokeAlpha(1)
    if hasattr(canvas, "setFillAlpha"):
        canvas.setFillAlpha(1)

    canvas.setFillColor(colors.HexColor("#0f1a2b"))
    if hasattr(canvas, "setFillAlpha"):
        canvas.setFillAlpha(0.92)
    canvas.roundRect(0.38 * inch, 0.42 * inch, 7.74 * inch, 10.12 * inch, 8, fill=1, stroke=0)
    if hasattr(canvas, "setFillAlpha"):
        canvas.setFillAlpha(1)

    canvas.setStrokeColor(colors.white)
    canvas.setLineWidth(1.5)
    canvas.line(0.55 * inch, 10.33 * inch, 7.95 * inch, 10.33 * inch)
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.setFillColor(colors.white)
    canvas.drawString(0.55 * inch, 10.43 * inch, "Lantern OS / COMET LEAP / !perfect art edition")
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(colors.white)
    canvas.drawString(0.55 * inch, 0.30 * inch, f"Local: {root}")
    canvas.drawRightString(7.95 * inch, 0.30 * inch, f"Remote: {remote} | p. {doc.page}")
    canvas.restoreState()

story = []
lines = source.read_text(encoding="utf-8").splitlines()
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        story.append(Spacer(1, 0.055 * inch))
        i += 1
        continue
    if line.strip().lower() in ("<!-- pagebreak -->", "<!-- page break -->", "\\pagebreak"):
        story.append(PageBreak())
        i += 1
        continue
    if line.startswith("# "):
        story.append(Paragraph(safe(line[2:]), styles["Title"]))
        story.append(Spacer(1, 0.12 * inch))
        i += 1
        continue
    if line.startswith("## "):
        story.append(Spacer(1, 0.08 * inch))
        story.append(Paragraph(safe(line[3:]), styles["Heading1"]))
        i += 1
        continue
    if line.startswith("### "):
        story.append(Spacer(1, 0.05 * inch))
        story.append(Paragraph(safe(line[4:]), styles["Heading2"]))
        i += 1
        continue
    if line.startswith("|") and i + 1 < len(lines) and lines[i+1].startswith("|"):
        table_lines = []
        while i < len(lines) and lines[i].startswith("|"):
            table_lines.append(lines[i])
            i += 1
        rows = []
        for idx, tline in enumerate(table_lines):
            cells = [c.strip() for c in tline.strip("|").split("|")]
            if idx == 1 and all(set(c) <= set("-: ") for c in cells):
                continue
            rows.append([para(c, "Small") for c in cells])
        if rows:
            widths = [7.05 * inch / len(rows[0])] * len(rows[0])
            tbl = Table(rows, colWidths=widths, repeatRows=1)
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#2c3e50")),
                ("TEXTCOLOR", (0,0), (-1,0), colors.white),
                ("BACKGROUND", (0,1), (-1,-1), colors.HexColor("#1a252f")),
                ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#1a252f"), colors.HexColor("#2c3e50")]),
                ("GRID", (0,0), (-1,-1), 0.45, colors.white),
                ("TEXTCOLOR", (0,1), (-1,-1), colors.white),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LEFTPADDING", (0,0), (-1,-1), 3),
                ("RIGHTPADDING", (0,0), (-1,-1), 3),
                ("TOPPADDING", (0,0), (-1,-1), 3),
                ("BOTTOMPADDING", (0,0), (-1,-1), 3),
            ]))
            story.append(tbl)
            story.append(Spacer(1, 0.08 * inch))
        continue
    if line.startswith("```"):
        block = []
        i += 1
        while i < len(lines) and not lines[i].startswith("```"):
            block.append(lines[i])
            i += 1
        i += 1
        story.append(para("<br/>".join(block), "Codeish"))
        continue
    story.append(para(line, "BodyText"))
    i += 1

doc = SimpleDocTemplate(
    str(output),
    pagesize=letter,
    rightMargin=0.58 * inch,
    leftMargin=0.58 * inch,
    topMargin=0.72 * inch,
    bottomMargin=0.72 * inch,
)
doc.build(story, onFirstPage=draw_page_art, onLaterPages=draw_page_art)
print(output)
"@

$temp = Join-Path $env:TEMP ("build-lantern-perfect-art-pdf-{0}-{1}.py" -f $PID, ([guid]::NewGuid().ToString("N")))
$python | Set-Content -LiteralPath $temp -Encoding UTF8
try {
    python $temp
}
finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}
