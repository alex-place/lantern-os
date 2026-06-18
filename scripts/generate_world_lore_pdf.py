#!/usr/bin/env python3
"""Generate world-lore.pdf from world-lore.md using reportlab."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.colors import black, grey, white, HexColor

import os

# Read the lore from the repo; write the generated PDF to the user's Documents
# (override the docs target with LANTERN_DOCS_DIR).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS_DIR = os.environ.get("LANTERN_DOCS_DIR", os.path.join(os.path.expanduser("~"), "Documents", "Lantern"))
os.makedirs(DOCS_DIR, exist_ok=True)
INPUT = os.path.join(REPO_ROOT, 'skills', 'dream_journal', 'symbolic', 'stories', 'world-lore.md')
OUTPUT = os.path.join(DOCS_DIR, 'world-lore.pdf')

with open(INPUT, 'r', encoding='utf-8') as f:
    lines = f.readlines()

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=28,
    leading=34,
    alignment=TA_CENTER,
    spaceAfter=30,
    textColor=black,
)

heading1_style = ParagraphStyle(
    'CustomH1',
    parent=styles['Heading1'],
    fontSize=20,
    leading=26,
    spaceAfter=16,
    spaceBefore=20,
    textColor=black,
    borderPadding=(0, 0, 6, 0),
)

heading2_style = ParagraphStyle(
    'CustomH2',
    parent=styles['Heading2'],
    fontSize=16,
    leading=22,
    spaceAfter=12,
    spaceBefore=16,
    textColor=black,
)

body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['BodyText'],
    fontSize=11,
    leading=16,
    spaceAfter=8,
    textColor=black,
)

code_style = ParagraphStyle(
    'CustomCode',
    parent=styles['Code'],
    fontSize=9,
    leading=13,
    leftIndent=20,
    spaceAfter=10,
    textColor=grey,
    backColor=white,
)

bullet_style = ParagraphStyle(
    'CustomBullet',
    parent=styles['BodyText'],
    fontSize=11,
    leading=16,
    leftIndent=20,
    spaceAfter=6,
    textColor=black,
    bulletIndent=10,
    bulletFontSize=11,
)

story = []

in_code_block = False

def escape_xml(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def format_inline(text):
    # Bold
    while '**' in text:
        text = text.replace('**', '<b>', 1).replace('**', '</b>', 1)
    # Inline code
    while '`' in text:
        parts = text.split('`', 2)
        if len(parts) >= 3:
            text = parts[0] + '<font face="Courier" size="9">' + escape_xml(parts[1]) + '</font>' + parts[2]
        else:
            break
    # Links [text](url) -> just text
    import re
    text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)
    return text

for raw_line in lines:
    line = raw_line.rstrip('\n')
    stripped = line.strip()

    if not stripped:
        if in_code_block:
            continue
        story.append(Spacer(1, 8))
        continue

    # Code block toggle
    if stripped.startswith('```'):
        in_code_block = not in_code_block
        continue

    if in_code_block:
        story.append(Paragraph(escape_xml(stripped), code_style))
        continue

    # Title
    if line.startswith('# '):
        text = format_inline(line[2:].strip())
        story.append(Paragraph(text, title_style))
        story.append(Spacer(1, 12))
    # Heading 1
    elif line.startswith('## '):
        text = format_inline(line[3:].strip())
        story.append(Paragraph(text, heading1_style))
    # Heading 2
    elif line.startswith('### '):
        text = format_inline(line[4:].strip())
        story.append(Paragraph(text, heading2_style))
    # Heading 3
    elif line.startswith('#### '):
        text = format_inline(line[5:].strip())
        story.append(Paragraph(text, heading2_style))
    # Blockquote
    elif line.startswith('>'):
        text = '<i>' + format_inline(line[1:].strip()) + '</i>'
        story.append(Paragraph(text, body_style))
    # Horizontal rule
    elif stripped == '---':
        story.append(Spacer(1, 12))
    # Bullet
    elif stripped.startswith('- '):
        text = format_inline(stripped[2:])
        story.append(Paragraph('• ' + text, bullet_style))
    # Numbered list
    elif len(stripped) > 2 and stripped[0].isdigit() and stripped[1] == '.':
        text = format_inline(stripped[stripped.find('.')+1:].strip())
        story.append(Paragraph(text, bullet_style))
    # Normal paragraph
    else:
        text = format_inline(line)
        story.append(Paragraph(text, body_style))

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    rightMargin=72,
    leftMargin=72,
    topMargin=72,
    bottomMargin=18,
)

doc.build(story)
print(f'PDF created: {OUTPUT}')
