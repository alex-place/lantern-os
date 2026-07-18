"""Sigma Trader Report - July 2026 -- THE JULY LEAP (comet-leap edition, Vol. 1).

Builds apps/lantern-garage/public/reports/sigma-trader-report-2026-07.pdf: the
monthly investor-facing report on the Champion trader in the house COMET LEAP
style (Lantern Preferred Visual System v0.1: arc-of-past -> node-of-now ->
projected leap; lantern gold / spectral cyan / storm blue / arc green on dark
marble; tables + at least one labeled graph; reads in grayscale). Written for
normies: your next $20, what to lean on, what to glide past - engaging, plain,
no jargon. Loop stage: Verify (publishes the measured state of the Act loop).

Every number is pinned as data below - reproducible offline from this file.
Sources: experiments/dca_champion_2k.py walk-forward (run 2026-07-17 15:19 ET,
monthly path dca_champion_paths.json), data/trading/brake-monitor.json (saved
2026-07-18 17:38 UTC), keyless Yahoo market feed 2026-07-18, web sources of
2026-07-16..18 (CNBC, Seeking Alpha, Trading Economics, federalreserve.gov).

Run:  python scripts/reports/sigma_trader_report_2026_07.py
"""
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Polygon, Rect, String
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "lantern-garage" / "public" / "reports" / "sigma-trader-report-2026-07.pdf"

# COMET LEAP palette (style profile colors_named, on dark marble)
NIGHT = colors.HexColor("#0F1518")     # page
MARBLE = colors.HexColor("#93A29B")    # muted
CARD = colors.HexColor("#151D22")
HAIR = colors.HexColor("#26313A")
INK = colors.HexColor("#EBEAE2")
GOLD = colors.HexColor("#F0C24C")      # lantern gold - the champion arc
CYAN = colors.HexColor("#5BC8E8")      # spectral cyan - the plain index
STORM = colors.HexColor("#6E93C8")     # storm blue
ARC = colors.HexColor("#54BE9F")       # arc green - status / the leap
GOLD_DIM = colors.Color(0.941, 0.761, 0.298, 0.16)
GOLD_GLOW = colors.Color(0.941, 0.761, 0.298, 0.10)

# ----------------------------------------------------------------- pinned data
# Champion + plain-S&P monthly balances, 2000-01..2026-07 (dca_champion_paths.json,
# run 2026-07-17). Downsampled for drawing: indices 0,2,..,304 then 305..318.
CH = [2056, 2132, 1965, 1917, 1939, 1945, 1994, 2044, 2095, 2145, 2195, 2247, 2298, 2272, 1909, 1958, 2008, 2059, 1915, 1866, 2267, 2414, 2474, 2823, 3252, 3260, 3319, 3298, 3252, 3535, 3442, 3381, 3197, 3680, 3624, 3812, 4133, 4402, 4034, 3529, 3609, 3935, 4199, 4212, 4791, 4323, 4443, 4604, 4231, 3920, 3943, 4003, 4063, 4124, 4184, 4245, 4520, 5239, 5987, 6051, 5509, 5923, 6499, 6586, 7638, 7894, 7613, 8283, 9109, 9464, 10293, 11238, 11925, 11678, 11606, 12356, 13231, 12695, 12288, 11938, 11771, 10993, 10793, 11203, 11439, 12087, 12804, 13134, 13570, 14944, 15846, 15860, 15610, 14927, 13869, 13460, 12200, 13394, 13640, 15256, 15176, 13945, 14726, 15648, 16714, 17146, 17746, 19170, 20708, 19242, 20251, 20654, 21480, 18109, 18228, 19487, 19538, 21753, 22908, 23734, 25842, 23221, 26268, 31305, 30145, 30322, 30838, 26917, 29556, 31486, 29713, 32327, 30641, 30645, 29678, 29864, 30061, 30251, 31784, 34426, 34424, 37440, 32673, 37859, 41444, 48868, 50368, 55041, 60174, 64182, 66304, 63960, 61245, 65370, 66263, 69881, 78719, 81797, 84292, 85355, 94141, 98905, 84514, 94707, 103189, 97743, 91537]
SP = [1938, 2137, 2068, 2115, 2168, 2034, 2155, 1876, 2067, 2036, 1794, 2002, 2034, 2104, 2008, 1750, 1614, 1897, 1783, 1803, 2106, 2208, 2269, 2457, 2674, 2713, 2748, 2748, 2822, 3028, 3088, 3135, 3216, 3386, 3421, 3528, 3646, 3768, 3740, 3806, 4036, 4288, 4451, 4455, 4852, 4669, 4954, 4866, 4558, 4439, 4761, 4362, 4049, 3179, 2985, 2928, 3451, 3749, 4067, 4277, 4239, 4680, 4411, 4511, 4735, 4957, 5453, 5684, 5823, 5649, 5004, 5571, 5932, 6431, 6041, 6403, 6771, 6725, 7174, 7583, 7953, 8294, 8340, 9027, 8974, 9502, 9831, 9939, 10229, 10799, 10492, 10947, 11238, 11298, 10378, 11343, 10630, 11378, 11657, 12166, 12221, 12493, 13015, 13584, 13953, 14372, 14745, 15595, 16716, 15706, 16212, 16951, 17637, 16761, 16550, 17438, 17031, 18533, 18618, 19760, 20367, 16445, 19463, 21017, 21682, 23484, 24146, 25986, 27582, 28930, 28441, 30233, 30002, 30252, 27697, 27795, 24232, 27702, 27788, 28135, 28757, 31665, 29710, 31763, 33784, 36752, 37095, 38910, 40697, 42782, 42914, 40047, 42237, 44428, 45472, 46425, 48100, 49267, 49383, 49443, 50191, 49777, 47338, 52333, 55108, 54561, 54278]
N_MONTHS = 319                      # 2000-01 .. 2026-07


def _idx(j):
    """Original month index for downsampled point j (evens 0..304, then 305..318)."""
    return 2 * j if j < 153 else 305 + (j - 153)


# The $20 split - lifetime-average champion mix, normalized to $20.00
SPLIT = [
    ("The S&amp;P 500", "the big American 500", "$6.75", 6.75, GOLD),
    ("Steady bonds", "the long-term ballast", "$4.15", 4.15, STORM),
    ("The tech 100", "the Nasdaq's engine room", "$3.00", 3.00, CYAN),
    ("Gold", "the ancient anchor", "$2.80", 2.80, colors.HexColor("#D9A441")),
    ("Small companies", "tomorrow's mid-caps", "$1.10", 1.10, ARC),
    ("Rest of the world", "beyond the US", "$0.90", 0.90, colors.HexColor("#8FB8D8")),
    ("Momentum, mid-size", "what's already winning", "$0.75", 0.75, colors.HexColor("#C88A5B")),
    ("Momentum, large", "the big winners' lane", "$0.55", 0.55, colors.HexColor("#B4622D")),
]

_BAD = re.compile(r"[^\x20-\x7E -ÿ–—‘’“”×·½°]")


def s(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.6, leading=14, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    "kicker": s("kicker", fontName="Helvetica-Bold", fontSize=8.2, leading=11, textColor=ARC),
    "title": s("title", fontName="Times-Bold", fontSize=30, leading=33, textColor=GOLD),
    "subtitle": s("subtitle", fontSize=10.5, leading=15, textColor=MARBLE),
    "h2": s("h2", fontName="Times-Bold", fontSize=17, leading=20, textColor=INK, spaceBefore=4),
    "h3": s("h3", fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=GOLD),
    "h3c": s("h3c", fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=CYAN),
    "body": s("body"),
    "big": s("big", fontSize=10.6, leading=15.5),
    "small": s("small", fontSize=8.2, leading=11.5, textColor=MARBLE),
    "stat_n": s("stat_n", fontName="Times-Bold", fontSize=21, leading=23, textColor=GOLD),
    "stat_k": s("stat_k", fontName="Helvetica-Bold", fontSize=7.4, leading=9.5, textColor=MARBLE),
    "cell": s("cell", fontSize=9, leading=12.5),
    "cellb": s("cellb", fontName="Helvetica-Bold", fontSize=9, leading=12.5),
    "gem": s("gem", fontName="Helvetica-Bold", fontSize=7.6, leading=10, textColor=INK, alignment=TA_CENTER),
    "gemk": s("gemk", fontSize=6.8, leading=9, textColor=MARBLE, alignment=TA_CENTER),
}


def P(text, style="body", **kw):
    if _BAD.search(text):
        raise ValueError("non-WinAnsi glyph: %r" % _BAD.search(text).group(0))
    st = ST[style] if not kw else ParagraphStyle("x", parent=ST[style], **kw)
    return Paragraph(text, st)


def card(flowables, pad=10, bg=CARD, border=HAIR, width=7.0 * inch, accent=None):
    t = Table([[flowables]], colWidths=[width])
    cmds = [
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), pad + (3 if accent else 0)),
        ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, -1), pad - 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), pad - 2),
    ]
    if accent:
        cmds.append(("LINEBEFORE", (0, 0), (0, -1), 2.6, accent))
    t.setStyle(TableStyle(cmds))
    return t


# ------------------------------------------------------------------ the arc
def comet_chart(w=7.0 * inch, h=3.35 * inch):
    d = Drawing(w, h)
    d.add(Rect(0, 0, w, h, fillColor=CARD, strokeColor=HAIR, strokeWidth=0.8))
    L, R, B, T = 0.52 * inch, w - 1.28 * inch, 0.34 * inch, h - 0.22 * inch
    ymax = 110000.0

    def X(idx):
        return L + (R - L) * idx / (N_MONTHS - 1)

    def Y(v):
        return B + (T - B) * v / ymax

    # faint grid + axis labels (grayscale-readable)
    for gv in (25000, 50000, 75000, 100000):
        d.add(Line(L, Y(gv), R, Y(gv), strokeColor=HAIR, strokeWidth=0.5))
        d.add(String(L - 4, Y(gv) - 2.6, "$%dk" % (gv // 1000), fontName="Helvetica",
                     fontSize=6.4, fillColor=MARBLE, textAnchor="end"))
    for yr in (2000, 2005, 2010, 2015, 2020, 2025):
        idx = (yr - 2000) * 12
        d.add(String(X(idx), B - 9, str(yr), fontName="Helvetica", fontSize=6.4,
                     fillColor=MARBLE, textAnchor="middle"))

    # money paid in - dashed marble baseline
    paid = [(X(_idx(j)), Y(2020 + 20 * _idx(j))) for j in range(len(CH))]
    pl = PolyLine([c for pt in paid for c in pt], strokeColor=MARBLE, strokeWidth=0.8)
    pl.strokeDashArray = [2.5, 2.5]
    d.add(pl)

    # plain S&P drip - spectral cyan
    d.add(PolyLine([c for j in range(len(SP)) for c in (X(_idx(j)), Y(SP[j]))],
                   strokeColor=CYAN, strokeWidth=1.15))

    # the champion - lantern-gold comet: soft fill, glow pass, bright core
    pts = [(X(_idx(j)), Y(CH[j])) for j in range(len(CH))]
    d.add(Polygon([c for pt in (pts + [(R, B), (X(0), B)]) for c in pt],
                  fillColor=GOLD_DIM, strokeColor=None))
    d.add(PolyLine([c for pt in pts for c in pt], strokeColor=GOLD_GLOW, strokeWidth=5.5))
    d.add(PolyLine([c for pt in pts for c in pt], strokeColor=GOLD, strokeWidth=1.7))

    # storms it sailed through (small storm-blue nodes, labels tucked below)
    for lbl, idx, dx in (("storm '02", 32, 0), ("'08", 106, 0), ("'20", 242, -5), ("'22", 272, 4)):
        j = idx // 2
        d.add(Circle(X(idx), Y(CH[j]), 2.1, fillColor=STORM, strokeColor=None))
        d.add(String(X(idx) + dx, Y(CH[j]) - 13, lbl, fontName="Helvetica",
                     fontSize=6.0, fillColor=STORM, textAnchor="middle"))

    # the node of now - glowing head of the comet
    nx, ny = pts[-1]
    d.add(Circle(nx, ny, 7.5, fillColor=colors.Color(0.941, 0.761, 0.298, 0.14), strokeColor=None))
    d.add(Circle(nx, ny, 4.6, fillColor=colors.Color(0.941, 0.761, 0.298, 0.30), strokeColor=None))
    d.add(Circle(nx, ny, 2.5, fillColor=GOLD, strokeColor=None))

    # the leap - dashed arc-green hint beyond the node
    leap = PolyLine([nx, ny, nx + 16, ny + 13, nx + 30, ny + 30], strokeColor=ARC, strokeWidth=1.4)
    leap.strokeDashArray = [3, 3]
    d.add(leap)

    # direct labels (no legend hunting)
    d.add(String(nx + 6, ny - 3, "$91,537", fontName="Times-Bold", fontSize=10.5, fillColor=GOLD))
    d.add(String(nx + 6, ny - 12.5, "the champion, today", fontName="Helvetica", fontSize=6.4, fillColor=MARBLE))
    d.add(String(nx + 6, Y(SP[-1]) - 3, "$54,278", fontName="Helvetica-Bold", fontSize=8, fillColor=CYAN))
    d.add(String(nx + 6, Y(SP[-1]) - 11, "plain S&P drip", fontName="Helvetica", fontSize=6.4, fillColor=CYAN))
    d.add(String(nx + 6, Y(8380) - 2, "$8,380 paid in", fontName="Helvetica", fontSize=6.4, fillColor=MARBLE))
    d.add(String(nx + 33, ny + 33, "the leap", fontName="Helvetica-Bold", fontSize=6.6, fillColor=ARC))
    return d


def split_bar(w=7.0 * inch, h=0.62 * inch):
    d = Drawing(w, h)
    x = 0.0
    for name, _sub, dollars, amt, col in SPLIT:
        seg = w * (amt / 20.0)
        d.add(Rect(x, 0.22 * inch, seg, 0.30 * inch, fillColor=col, strokeColor=NIGHT, strokeWidth=1.2))
        if amt >= 2.5:
            d.add(String(x + seg / 2, 0.315 * inch, dollars, fontName="Helvetica-Bold",
                         fontSize=8.5, fillColor=NIGHT, textAnchor="middle"))
        x += seg
    d.add(String(0, 0.02 * inch, "one twenty, eight ingredients - poured automatically, every month",
                 fontName="Helvetica", fontSize=6.8, fillColor=MARBLE))
    return d


def gem_row():
    gems = [
        ("DRIP", "on schedule", ARC),
        ("MIX", "eight assets", ARC),
        ("BRAKE", "cruising 2.0×", ARC),
        ("SKIES", "VIX 18.8 calm", ARC),
        ("GATES", "3 of 3 green", ARC),
        ("REAL $", "practice mode", GOLD),
    ]
    cells = []
    for label, sub, col in gems:
        dot = Drawing(10, 10)
        dot.add(Circle(5, 5, 4.4, fillColor=colors.Color(col.red, col.green, col.blue, 0.25), strokeColor=None))
        dot.add(Circle(5, 5, 2.6, fillColor=col, strokeColor=None))
        cells.append([dot, Spacer(1, 2), P(label, "gem"), P(sub, "gemk")])
    t = Table([cells], colWidths=[7.0 * inch / len(gems)] * len(gems))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD),
        ("BOX", (0, 0), (-1, -1), 0.8, HAIR),
        ("LINEAFTER", (0, 0), (-2, -1), 0.5, HAIR),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def data_table(rows, widths, right_from=1):
    body = []
    for i, row in enumerate(rows):
        body.append([P(c, "cellb" if i == 0 or j == 0 else "cell")
                     for j, c in enumerate(row)])
    t = Table(body, colWidths=widths)
    cmds = [
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, GOLD),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [CARD, NIGHT]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    for j in range(right_from, len(rows[0])):
        cmds.append(("ALIGN", (j, 0), (j, -1), "RIGHT"))
    t.setStyle(TableStyle(cmds))
    return t


def on_page(canvas, doc):
    canvas.saveState()
    w, h = letter
    canvas.setFillColor(NIGHT)
    canvas.rect(0, 0, w, h, stroke=0, fill=1)
    canvas.setStrokeColor(HAIR)
    canvas.setLineWidth(0.6)
    canvas.line(0.75 * inch, 0.6 * inch, w - 0.75 * inch, 0.6 * inch)
    canvas.setFont("Helvetica", 6.8)
    canvas.setFillColor(MARBLE)
    canvas.drawString(0.75 * inch, 0.45 * inch,
                      "unisona.ai · Sigma Trader Report · July 2026 · a practice-mode story from real history "
                      "- for learning, not personal advice")
    canvas.drawRightString(w - 0.75 * inch, 0.45 * inch, "p. %d" % doc.page)
    canvas.restoreState()


def build():
    story = []

    # ---------------------------------------------------------------- page 1
    story.append(P("UNISONA.AI MONTHLY · VOL. 1 · THE COMET-LEAP EDITION", "kicker"))
    story.append(Spacer(1, 4))
    story.append(P("The July Leap", "title"))
    story.append(Spacer(1, 4))
    story.append(P(
        "The Sigma Trader's monthly postcard: where the arc has been, where it glows tonight, "
        "and where your next $20 goes. Data through Friday, July 17. Published July 18, 2026.",
        "subtitle"))
    story.append(Spacer(1, 9))
    story.append(comet_chart())
    story.append(Spacer(1, 3))
    story.append(P(
        "The whole flight, one picture: $2,000 launched in January 2000 + $20 a month ($8,380 paid in, "
        "the dashed line). The gold comet is the champion at $91,537 today - eleven times the fuel spent - "
        "sailing through four storms on the way. The cyan line is the same drip into plain S&amp;P, $54,278. "
        "Measured in the walk-forward simulation, borrowing costs charged, no peeking.", "small"))
    story.append(Spacer(1, 10))
    story.append(gem_row())
    story.append(Spacer(1, 10))
    story.append(P(
        "<b>The word for July is <font color='#F0C24C'>poise</font>.</b> Markets took a breather - the "
        "spring's hottest stocks cooled off, headlines got loud, oil jumped - and the system's answer was "
        "the calmest sentence it knows: <i>all gates green, keep cruising, keep dripping.</i> The arc bent "
        "-6.4% this month. It has bent this way 24 times in 26 years, and after every single one it went "
        "on to a brand-new high. That is what the dashed green line off the comet's nose is drawn from: "
        "not hope - <b>habit</b>.", "big"))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 2
    story.append(P("PART 1 · YOUR NEXT $20", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("Where the next twenty goes", "h2"))
    story.append(Spacer(1, 5))
    story.append(P(
        "The plan's answer never needs a hot take: the next $20 buys <b>the whole mix, automatically</b> - "
        "a little more of whatever has drifted below its target weight, so you quietly buy what's on sale. "
        "Here is this month's pour:", "big"))
    story.append(Spacer(1, 8))
    story.append(split_bar())
    story.append(Spacer(1, 6))
    story.append(data_table(
        [["Ingredient", "What it is", "Of your $20"]] +
        [[name, sub, dollars] for name, sub, dollars, _a, _c in SPLIT],
        [1.95 * inch, 3.55 * inch, 1.5 * inch], right_from=2))
    story.append(Spacer(1, 4))
    story.append(P(
        "Lifetime-average champion recipe; the momentum slices grow as their track record does. "
        "Fractional shares mean all eight fit inside one twenty.", "small"))
    story.append(Spacer(1, 12))

    lean = [
        ("THE DRIP ITSELF", "Twenty in, every month, rain or shine. Across everything the lab has ever "
         "tested, the contribution is the strongest lever in the whole machine - stronger than any "
         "clever tweak. Level it up when life allows and you out-lever every strategy change."),
        ("BORING BALLAST", "Bonds and gold are a third of the pour, and July is why: they let the arc "
         "climb without white knuckles. Gold is up about 20% on the year - the anchor is pulling."),
        ("THE ROBOT'S WATCH", "A brake checks the skies every minute the market is open, ready to glide "
         "the book toward interest-earning cash if a storm builds. Tonight it reads calm. You were "
         "never on watch duty - that's the point."),
    ]
    glide = [
        ("CHASING JULY'S FIREWORKS", "The spring's hottest chip stocks just took the summer's sharpest "
         "turn. The mix already owns the winners' lane through its momentum slices - you get the ride "
         "without picking the horse."),
        ("DIY BORROWING", "Leverage is the robot's craft, practiced on a paper book behind a gate. On a "
         "personal account, plain and unborrowed is the strong move. Let the machine do the tightrope."),
        ("WATCHING DAILY", "A drip plan pays you for patience: every dip your $20 lands in is a "
         "discount. The scoreboard that matters prints monthly - this page - not at 3am."),
    ]
    rows = [[P("Lean on these", "h3"), P("Glide past these", "h3c")]]
    for (lh, lb), (gh, gb) in zip(lean, glide):
        rows.append([
            P("<b>%s</b> - %s" % (lh, lb), "cell"),
            P("<b>%s</b> - %s" % (gh, gb), "cell"),
        ])
    lg = Table(rows, colWidths=[3.5 * inch, 3.5 * inch])
    lg.setStyle(TableStyle([
        ("BACKGROUND", (0, 1), (-1, -1), CARD),
        ("LINEBEFORE", (0, 1), (0, -1), 2.4, GOLD),
        ("LINEBEFORE", (1, 1), (1, -1), 2.4, CYAN),
        ("LINEBELOW", (0, 1), (-1, -2), 3, NIGHT),
        ("LINEABOVE", (0, 1), (-1, 1), 3, NIGHT),
        ("LINEAFTER", (0, 0), (0, -1), 6, NIGHT),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 1), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(lg)

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 3
    story.append(P("PART 2 · THE WORLD THIS MONTH", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("Four headlines, four calm answers", "h2"))
    story.append(Spacer(1, 6))

    events = [
        (GOLD, "Oil leapt 10% as the Middle East flared",
         "Tensions between the US and Iran boiled over and crude jumped above $82 - a one-month high "
         "(CNBC, July 16). Gas may pinch; markets, remarkably, kept their cool: the fear gauge sits at a "
         "mellow 18.8.",
         "The plan's answer: nothing to do - and that's a feature. If storms build, the brake glides "
         "toward cash that currently pays real interest, all by itself, minutes-fast. Shelter with a yield."),
        (CYAN, "The market rotated out of spring's favorites",
         "Chipmakers cooled and the spotlight moved on - the S&amp;P eased 1.6% for the week while, quietly, "
         "87% of early earnings reports beat expectations (CNBC; Seeking Alpha, July 17). Strong engine, "
         "new seating chart.",
         "The plan's answer: this is exactly why you own eight ingredients instead of one hero. Rotations "
         "shuffle the leaderboard; the mix keeps a seat at every table, and July's drip buys the "
         "newly-discounted seats."),
        (STORM, "The Fed holds steady - and cash still pays",
         "The July 28-29 meeting is expected to keep rates right where they are, with inflation watched "
         "closely (Federal Reserve minutes; CNBC, July 8). The 10-year sits near 4.55%.",
         "The plan's answer: higher-for-now rates are the quiet gift of this era - the brake's cash "
         "refuge earns Treasury-bill interest, so playing defense is never dead money. Patience, paid."),
        (ARC, "Gold's golden year rolls on",
         "Even after catching its breath this month, gold shines near $4,017 an ounce - up about 20% "
         "from a year ago (Trading Economics, July 17).",
         "The plan's answer: the $2.80 gold slice in every twenty is the ancient anchor doing modern "
         "work - it zigs when stocks zag, most of the time, and asks nothing of you in return."),
    ]
    for col, head, what, take in events:
        story.append(card([
            P("<b>%s</b>" % head, "big", textColor=col),
            Spacer(1, 3),
            P(what),
            Spacer(1, 3),
            P("<i>%s</i>" % take, "body", textColor=INK),
        ], accent=col))
        story.append(Spacer(1, 7))

    story.append(Spacer(1, 2))
    story.append(card([
        P("<b>THE 24-FOR-24 BADGE.</b> A month like July (-6.4%) has happened 24 times before on this "
          "arc since 2000 - the dot-com winter, 2008, the 2020 flash-storm, the 2022 bear. The record "
          "after those 24: <b>24 new all-time highs.</b> The 25th is now on the clock, and the May peak "
          "($103,189) is the line it's chasing. History measured, future unwritten - but that is one "
          "well-rehearsed bounce.", "big")], accent=GOLD, bg=colors.HexColor("#1A2320")))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 4
    story.append(P("PART 3 · THE LEAP AHEAD", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The arc, the node, the leap", "h2"))
    story.append(Spacer(1, 6))

    story.append(P("The arc - the last three statement lines", "h3"))
    story.append(Spacer(1, 4))
    story.append(data_table([
        ["", "May", "June", "July 17", "Since 2000"],
        ["The champion", "$103,189", "$97,743", "$91,537", "11.0× the money in"],
        ["Plain S&amp;P drip", "$55,108", "$54,561", "$54,278", "6.5× the money in"],
        ["Money paid in", "$8,340", "$8,360", "$8,380", "the only guaranteed row"],
    ], [1.9 * inch, 1.15 * inch, 1.15 * inch, 1.15 * inch, 1.65 * inch]))
    story.append(Spacer(1, 10))

    story.append(P("The leap - if the next years rhyme with the last 26", "h3"))
    story.append(Spacer(1, 4))
    story.append(data_table([
        ["From today's $91,537 + $20/month", "by 2031", "by 2036"],
        ["At the champion's measured pace (12.6%/yr)", "about $167,000", "about $304,000"],
        ["At the plain-index pace (10.0%/yr)", "about $148,000", "about $241,000"],
        ["New money you'd add", "$1,200", "$2,400"],
    ], [3.7 * inch, 1.65 * inch, 1.65 * inch]))
    story.append(Spacer(1, 4))
    story.append(P(
        "Paces are what each line actually measured, 2000-2026. The future keeps its own counsel - "
        "which is why the drip, the mix, and the brake do the promising here, not the projection.", "small"))
    story.append(Spacer(1, 12))

    story.append(P("The plot, on one card", "h3"))
    story.append(Spacer(1, 4))
    story.append(data_table([
        ["", ""],
        ["Directive", "A monthly report for unisona.ai users: how the next $20 leaps, with current events in mind."],
        ["Promoted system", "The champion mix + streaming brake, now also running a live $25,000 practice book "
         "(reading $24,998, cruising 2.0×, started July 17)."],
        ["Evidence", "Walk-forward simulation 2000-2026 (run July 17; monthly path on file) · live brake state "
         "saved July 18, 17:38 UTC · market feed July 18 · news of July 16-18 (CNBC, Seeking Alpha, Trading "
         "Economics, federalreserve.gov)."],
        ["Boundaries", "Practice mode: simulation + paper only. Real dollars wait behind the plan's own "
         "evidence gate, and every real-money click belongs to a human - with a licensed advisor for the "
         "personal stuff."],
        ["Next action", "Keep the drip. Skim next month's Leap. If you do one extra thing in July: nudge the "
         "twenty toward twenty-five."],
    ], [1.35 * inch, 5.65 * inch], right_from=99))
    story.append(Spacer(1, 10))
    story.append(P(
        "See you at the August Leap - same arc, fresh node. · Full method &amp; every receipt: "
        "docs/investing-2k-plan.html and experiments/ in the unisona.ai repo.", "small",
        alignment=TA_CENTER))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(str(OUT), pagesize=letter,
                          leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                          topMargin=0.68 * inch, bottomMargin=0.8 * inch,
                          title="Sigma Trader Report - The July Leap (2026)",
                          author="unisona.ai")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=on_page)])
    doc.build(story)
    print("wrote %s" % OUT)


if __name__ == "__main__":
    build()
