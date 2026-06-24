#!/usr/bin/env python3
"""
resume_docx.py — docx read/write helper for the Keystone chat document-processing
feature (routes/documents.js). Two modes:

  extract <in.docx>           -> prints the document's plain text to stdout
  build   <out.docx>          -> reads a JSON spec on stdin, writes a styled .docx

The JSON `build` spec is intentionally generic so it works for resumes and other
simple documents:

  {
    "name": "Alexander Place",                 # big title line (optional)
    "contact": "email · phone · City, ST · linkedin.com/in/...",  # subtitle (optional)
    "sections": [
      { "heading": "Professional Summary", "paragraphs": ["..."] },
      { "heading": "Work Experience", "entries": [
          { "title": "Software Engineer", "org": "US Bank — Cincinnati, OH",
            "dates": "Mar 2016 – Apr 2023", "bullets": ["...", "..."] }
      ]},
      { "heading": "Skills", "bullets": ["...", "..."] }
    ]
  }

Each section may carry any of: paragraphs[], bullets[], entries[]. Unknown keys are
ignored, so the LLM can be a little loose without breaking generation.
"""
import json
import sys


def extract(path):
    import docx
    doc = docx.Document(path)
    lines = []
    # Name + contact often live in the page HEADER (not the body) — include them first
    # so the rewrite keeps the person's identity instead of emitting a placeholder.
    seen_hdr = set()
    for section in doc.sections:
        for part in (section.header, section.footer):
            try:
                for p in part.paragraphs:
                    txt = p.text.strip()
                    if txt and txt not in seen_hdr:
                        seen_hdr.add(txt)
                        lines.append(txt)
            except Exception:
                pass
    for p in doc.paragraphs:
        lines.append(p.text)
    # include simple table text too (some resumes use tables for layout)
    for t in doc.tables:
        for row in t.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                lines.append("\t".join(cells))
    sys.stdout.write("\n".join(lines))


def _set_repeat(run):
    run.font.name = "Calibri"


def build(path, spec):
    import docx
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    doc = docx.Document()

    # Base style
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    for section in doc.sections:
        section.top_margin = section.bottom_margin = docx.shared.Inches(0.6)
        section.left_margin = section.right_margin = docx.shared.Inches(0.7)

    accent = RGBColor(0x1F, 0x4E, 0x79)  # deep blue

    def add_bottom_border(paragraph):
        p = paragraph._p
        pPr = p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "6")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), "1F4E79")
        pbdr.append(bottom)
        pPr.append(pbdr)

    # Name / title
    name = (spec.get("name") or "").strip()
    if name:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(name)
        r.bold = True
        r.font.size = Pt(22)
        r.font.color.rgb = accent
        p.space_after = Pt(0)

    contact = (spec.get("contact") or "").strip()
    if contact:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(contact)
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    for sec in spec.get("sections", []):
        heading = (sec.get("heading") or "").strip()
        if heading:
            hp = doc.add_paragraph()
            hp.paragraph_format.space_before = Pt(10)
            hp.paragraph_format.space_after = Pt(2)
            hr = hp.add_run(heading.upper())
            hr.bold = True
            hr.font.size = Pt(11.5)
            hr.font.color.rgb = accent
            add_bottom_border(hp)

        for para in sec.get("paragraphs", []) or []:
            if not str(para).strip():
                continue
            pp = doc.add_paragraph(str(para).strip())
            pp.paragraph_format.space_after = Pt(4)

        for entry in sec.get("entries", []) or []:
            title = (entry.get("title") or "").strip()
            org = (entry.get("org") or "").strip()
            dates = (entry.get("dates") or "").strip()
            line = doc.add_paragraph()
            line.paragraph_format.space_before = Pt(4)
            line.paragraph_format.space_after = Pt(0)
            left = " — ".join([x for x in [title, org] if x])
            lr = line.add_run(left)
            lr.bold = True
            lr.font.size = Pt(10.5)
            if dates:
                # right-aligned dates via tab stop
                from docx.enum.text import WD_TAB_ALIGNMENT
                from docx.shared import Inches as _In
                line.paragraph_format.tab_stops.add_tab_stop(_In(7.1), WD_TAB_ALIGNMENT.RIGHT)
                dr = line.add_run("\t" + dates)
                dr.italic = True
                dr.font.size = Pt(9.5)
                dr.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
            for b in entry.get("bullets", []) or []:
                if not str(b).strip():
                    continue
                bp = doc.add_paragraph(str(b).strip(), style="List Bullet")
                bp.paragraph_format.space_after = Pt(1)

        for b in sec.get("bullets", []) or []:
            if not str(b).strip():
                continue
            bp = doc.add_paragraph(str(b).strip(), style="List Bullet")
            bp.paragraph_format.space_after = Pt(1)

    doc.save(path)
    sys.stdout.write(json.dumps({"ok": True, "path": path}))


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: resume_docx.py <extract|build> <path>\n")
        sys.exit(2)
    mode, path = sys.argv[1], sys.argv[2]
    if mode == "extract":
        extract(path)
    elif mode == "build":
        spec = json.loads(sys.stdin.read() or "{}")
        build(path, spec)
    else:
        sys.stderr.write("unknown mode: %s\n" % mode)
        sys.exit(2)


if __name__ == "__main__":
    main()
