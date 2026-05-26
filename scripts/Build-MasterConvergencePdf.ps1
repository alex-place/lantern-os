param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$Source = "reports/COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.md",
    [string]$Output = "artifacts/COMET-LEAP-TOKEN-BURN-REVENUE-CONVERGENCE-v1.pdf",
    [string]$RemoteUrl = "https://github.com/alex-place/lantern-os"
)

$ErrorActionPreference = "Stop"

$sourcePath = Join-Path $Root $Source
$outputPath = Join-Path $Root $Output
$outputDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$python = @"
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.enums import TA_LEFT

root = Path(r"$Root")
source = root / r"$Source"
output = root / r"$Output"
remote = r"$RemoteUrl"
local = str(root)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Small", parent=styles["BodyText"], fontSize=7, leading=9))
styles.add(ParagraphStyle(name="Codeish", parent=styles["BodyText"], fontName="Courier", fontSize=7, leading=9))
styles["Title"].fontSize = 18
styles["Heading1"].fontSize = 14
styles["Heading2"].fontSize = 11
styles["BodyText"].fontSize = 8
styles["BodyText"].leading = 10

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(colors.HexColor("#555555"))
    canvas.drawString(0.55 * inch, 0.35 * inch, f"Lantern OS local: {local}")
    canvas.drawRightString(7.95 * inch, 0.35 * inch, f"Remote: {remote} | p. {doc.page}")
    canvas.restoreState()

def para(text, style="BodyText"):
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = text.replace("`", "")
    return Paragraph(text, styles[style])

story = []
lines = source.read_text(encoding="utf-8").splitlines()
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        story.append(Spacer(1, 0.06 * inch))
        i += 1
        continue
    if line.startswith("# "):
        story.append(Paragraph(line[2:], styles["Title"]))
        story.append(Spacer(1, 0.12 * inch))
        i += 1
        continue
    if line.startswith("## "):
        story.append(Spacer(1, 0.08 * inch))
        story.append(Paragraph(line[3:], styles["Heading1"]))
        i += 1
        continue
    if line.startswith("### "):
        story.append(Spacer(1, 0.05 * inch))
        story.append(Paragraph(line[4:], styles["Heading2"]))
        i += 1
        continue
    if line.startswith("|") and i + 1 < len(lines) and lines[i+1].startswith("|"):
        table_lines = []
        while i < len(lines) and lines[i].startswith("|"):
            table_lines.append(lines[i])
            i += 1
        rows = []
        for idx, tline in enumerate(table_lines):
            cells = [c.strip().replace("`", "") for c in tline.strip("|").split("|")]
            if idx == 1 and all(set(c) <= set("-: ") for c in cells):
                continue
            rows.append([para(c, "Small") for c in cells])
        if rows:
            widths = [7.2 * inch / len(rows[0])] * len(rows[0])
            tbl = Table(rows, colWidths=widths, repeatRows=1)
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#22313a")),
                ("TEXTCOLOR", (0,0), (-1,0), colors.white),
                ("GRID", (0,0), (-1,-1), 0.25, colors.HexColor("#b7c0c5")),
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
    if line.startswith("- ") or (len(line) > 2 and line[0].isdigit() and ". " in line[:4]):
        story.append(para(line, "BodyText"))
        i += 1
        continue
    story.append(para(line, "BodyText"))
    i += 1

doc = SimpleDocTemplate(str(output), pagesize=letter, rightMargin=0.45*inch, leftMargin=0.45*inch, topMargin=0.45*inch, bottomMargin=0.6*inch)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(output)
"@

$temp = Join-Path $env:TEMP "build-lantern-convergence-pdf.py"
$python | Set-Content -LiteralPath $temp -Encoding UTF8
python $temp

