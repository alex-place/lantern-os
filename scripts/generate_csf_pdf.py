#!/usr/bin/env python3
"""Generate CSF-FORMAT-SPECIFICATION.pdf from CSF-FORMAT-SPECIFICATION.md using reportlab."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.colors import black, grey, white, HexColor

import os

# Read the spec from the repo; write the generated PDF to the user's Documents
# (override the docs target with LANTERN_DOCS_DIR).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS_DIR = os.environ.get("LANTERN_DOCS_DIR", os.path.join(os.path.expanduser("~"), "Documents", "Lantern"))
os.makedirs(DOCS_DIR, exist_ok=True)
INPUT = os.path.join(REPO_ROOT, 'docs', 'CSF-FORMAT-SPECIFICATION.md')
OUTPUT = os.path.join(DOCS_DIR, 'CSF-FORMAT-SPECIFICATION.pdf')

with open(INPUT, 'r', encoding='utf-8') as f:
    lines = f.readlines()

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=26,
    leading=32,
    alignment=TA_CENTER,
    spaceAfter=24,
    textColor=black,
)

heading1_style = ParagraphStyle(
    'CustomH1',
    parent=styles['Heading1'],
    fontSize=18,
    leading=24,
    spaceAfter=12,
    spaceBefore=16,
    textColor=black,
    borderPadding=(0, 0, 4, 0),
)

heading2_style = ParagraphStyle(
    'CustomH2',
    parent=styles['Heading2'],
    fontSize=14,
    leading=20,
    spaceAfter=10,
    spaceBefore=14,
    textColor=black,
)

body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['BodyText'],
    fontSize=10,
    leading=14,
    spaceAfter=6,
    textColor=black,
)

code_style = ParagraphStyle(
    'CustomCode',
    parent=styles['Code'],
    fontSize=8,
    leading=12,
    leftIndent=16,
    spaceAfter=8,
    textColor=grey,
    backColor=white,
)

bullet_style = ParagraphStyle(
    'CustomBullet',
    parent=styles['BodyText'],
    fontSize=10,
    leading=14,
    leftIndent=16,
    spaceAfter=4,
    textColor=black,
    bulletIndent=8,
    bulletFontSize=10,
)

story = []

in_code_block = False

def escape_xml(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def format_inline(text):
    while '**' in text:
        text = text.replace('**', '<b>', 1).replace('**', '</b>', 1)
    while '`' in text:
        parts = text.split('`', 2)
        if len(parts) >= 3:
            text = parts[0] + '<font face="Courier" size="8">' + escape_xml(parts[1]) + '</font>' + parts[2]
        else:
            break
    import re
    text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)
    return text

for raw_line in lines:
    line = raw_line.rstrip('\n')
    stripped = line.strip()

    if not stripped:
        if in_code_block:
            continue
        story.append(Spacer(1, 6))
        continue

    if stripped.startswith('```'):
        in_code_block = not in_code_block
        continue

    if in_code_block:
        story.append(Paragraph(escape_xml(stripped), code_style))
        continue

    if line.startswith('# '):
        text = format_inline(line[2:].strip())
        story.append(Paragraph(text, title_style))
        story.append(Spacer(1, 8))
    elif line.startswith('## '):
        text = format_inline(line[3:].strip())
        story.append(Paragraph(text, heading1_style))
    elif line.startswith('### '):
        text = format_inline(line[4:].strip())
        story.append(Paragraph(text, heading2_style))
    elif line.startswith('#### '):
        text = format_inline(line[5:].strip())
        story.append(Paragraph(text, heading2_style))
    elif line.startswith('>'):
        text = '<i>' + format_inline(line[1:].strip()) + '</i>'
        story.append(Paragraph(text, body_style))
    elif stripped == '---':
        story.append(Spacer(1, 8))
    elif stripped.startswith('- '):
        text = format_inline(stripped[2:])
        story.append(Paragraph('• ' + text, bullet_style))
    elif len(stripped) > 2 and stripped[0].isdigit() and stripped[1] == '.':
        text = format_inline(stripped[stripped.find('.')+1:].strip())
        story.append(Paragraph(text, bullet_style))
    else:
        text = format_inline(line)
        story.append(Paragraph(text, body_style))

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    rightMargin=60,
    leftMargin=60,
    topMargin=60,
    bottomMargin=18,
)

doc.build(story)
print(f'PDF created: {OUTPUT}')
