"""Sigma Trader Report - July 2026 -- THE JULY LEAP (comet-leap, for-everyone edition).

Builds apps/lantern-garage/public/reports/sigma-trader-report-2026-07.pdf: the
monthly report on unisona.ai's Champion trader, written for EVERY user - free or
paid, plan or no plan, market-fluent or brand new. House COMET LEAP style
(Lantern Preferred Visual System v0.1: arc-of-past -> node-of-now -> projected
leap; lantern gold / spectral cyan / storm blue / arc green on dark marble;
tables + a labeled graph; reads in grayscale). Assumes zero prior knowledge:
events come with backstory, jargon gets a little dictionary, and the next-$20
answer has three lanes so it lands wherever the reader is starting from.

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
    BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "lantern-garage" / "public" / "reports" / "sigma-trader-report-2026-07.pdf"

# COMET LEAP palette (style profile colors_named, on dark marble)
NIGHT = colors.HexColor("#0F1518")
MARBLE = colors.HexColor("#93A29B")
CARD = colors.HexColor("#151D22")
HAIR = colors.HexColor("#26313A")
INK = colors.HexColor("#EBEAE2")
GOLD = colors.HexColor("#F0C24C")
CYAN = colors.HexColor("#5BC8E8")
STORM = colors.HexColor("#6E93C8")
ARC = colors.HexColor("#54BE9F")
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


# The $20 split - lifetime-average champion mix, normalized to $20.00.
# Last closes = Friday 2026-07-17 marks from the live brake monitor's state file.
# (ticker, plain name, what it is, Fri close, weight, $-of-20 label, $, color)
SPLIT = [
    ("SPY", "The S&amp;P 500", "the 500 biggest US companies, one bundle", "$743.29", "34%", "$6.75", 6.75, GOLD),
    ("TLT", "Long US bonds", "20+ year loans to the US government - ballast", "$84.52", "21%", "$4.15", 4.15, STORM),
    ("QQQ", "The tech 100", "the Nasdaq's engine room", "$695.33", "15%", "$3.00", 3.00, CYAN),
    ("GLD", "Gold", "the ancient anchor, in fund form", "$368.41", "14%", "$2.80", 2.80, colors.HexColor("#D9A441")),
    ("IWM", "Small companies", "the Russell 2000 - tomorrow's mid-caps", "$294.04", "5.5%", "$1.10", 1.10, ARC),
    ("EFA", "Rest of the world", "big developed markets beyond the US", "$103.33", "4.6%", "$0.90", 0.90, colors.HexColor("#8FB8D8")),
    ("XMMO", "Momentum, mid-size", "mid-caps already winning", "$157.08", "3.7%", "$0.75", 0.75, colors.HexColor("#C88A5B")),
    ("SPMO", "Momentum, large", "large-caps in the winners' lane", "$143.89", "2.9%", "$0.55", 0.55, colors.HexColor("#B4622D")),
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
    "label": s("label", fontName="Helvetica-Bold", fontSize=7.2, leading=10, textColor=MARBLE),
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
def comet_chart(w=7.0 * inch, h=3.2 * inch):
    d = Drawing(w, h)
    d.add(Rect(0, 0, w, h, fillColor=CARD, strokeColor=HAIR, strokeWidth=0.8))
    L, R, B, T = 0.52 * inch, w - 1.28 * inch, 0.34 * inch, h - 0.22 * inch
    ymax = 110000.0

    def X(idx):
        return L + (R - L) * idx / (N_MONTHS - 1)

    def Y(v):
        return B + (T - B) * v / ymax

    for gv in (25000, 50000, 75000, 100000):
        d.add(Line(L, Y(gv), R, Y(gv), strokeColor=HAIR, strokeWidth=0.5))
        d.add(String(L - 4, Y(gv) - 2.6, "$%dk" % (gv // 1000), fontName="Helvetica",
                     fontSize=6.4, fillColor=MARBLE, textAnchor="end"))
    for yr in (2000, 2005, 2010, 2015, 2020, 2025):
        idx = (yr - 2000) * 12
        d.add(String(X(idx), B - 9, str(yr), fontName="Helvetica", fontSize=6.4,
                     fillColor=MARBLE, textAnchor="middle"))

    paid = [(X(_idx(j)), Y(2020 + 20 * _idx(j))) for j in range(len(CH))]
    pl = PolyLine([c for pt in paid for c in pt], strokeColor=MARBLE, strokeWidth=0.8)
    pl.strokeDashArray = [2.5, 2.5]
    d.add(pl)

    d.add(PolyLine([c for j in range(len(SP)) for c in (X(_idx(j)), Y(SP[j]))],
                   strokeColor=CYAN, strokeWidth=1.15))

    pts = [(X(_idx(j)), Y(CH[j])) for j in range(len(CH))]
    d.add(Polygon([c for pt in (pts + [(R, B), (X(0), B)]) for c in pt],
                  fillColor=GOLD_DIM, strokeColor=None))
    d.add(PolyLine([c for pt in pts for c in pt], strokeColor=GOLD_GLOW, strokeWidth=5.5))
    d.add(PolyLine([c for pt in pts for c in pt], strokeColor=GOLD, strokeWidth=1.7))

    for lbl, idx, dx in (("storm '02", 32, 0), ("'08", 106, 0), ("'20", 242, -5), ("'22", 272, 4)):
        j = idx // 2
        d.add(Circle(X(idx), Y(CH[j]), 2.1, fillColor=STORM, strokeColor=None))
        d.add(String(X(idx) + dx, Y(CH[j]) - 13, lbl, fontName="Helvetica",
                     fontSize=6.0, fillColor=STORM, textAnchor="middle"))

    nx, ny = pts[-1]
    d.add(Circle(nx, ny, 7.5, fillColor=colors.Color(0.941, 0.761, 0.298, 0.14), strokeColor=None))
    d.add(Circle(nx, ny, 4.6, fillColor=colors.Color(0.941, 0.761, 0.298, 0.30), strokeColor=None))
    d.add(Circle(nx, ny, 2.5, fillColor=GOLD, strokeColor=None))

    leap = PolyLine([nx, ny, nx + 16, ny + 13, nx + 30, ny + 30], strokeColor=ARC, strokeWidth=1.4)
    leap.strokeDashArray = [3, 3]
    d.add(leap)

    d.add(String(nx + 6, ny - 3, "$91,537", fontName="Times-Bold", fontSize=10.5, fillColor=GOLD))
    d.add(String(nx + 6, ny - 12.5, "the champion, today", fontName="Helvetica", fontSize=6.4, fillColor=MARBLE))
    d.add(String(nx + 6, Y(SP[-1]) - 3, "$54,278", fontName="Helvetica-Bold", fontSize=8, fillColor=CYAN))
    d.add(String(nx + 6, Y(SP[-1]) - 11, "plain S&P drip", fontName="Helvetica", fontSize=6.4, fillColor=CYAN))
    d.add(String(nx + 6, Y(8380) - 2, "$8,380 paid in", fontName="Helvetica", fontSize=6.4, fillColor=MARBLE))
    d.add(String(nx + 33, ny + 33, "the leap", fontName="Helvetica-Bold", fontSize=6.6, fillColor=ARC))
    return d


def split_bar(w=7.0 * inch, h=0.6 * inch):
    d = Drawing(w, h)
    x = 0.0
    for tkr, _name, _sub, _px, _wt, dollars, amt, col in SPLIT:
        seg = w * (amt / 20.0)
        d.add(Rect(x, 0.2 * inch, seg, 0.3 * inch, fillColor=col, strokeColor=NIGHT, strokeWidth=1.2))
        if amt >= 2.5:
            d.add(String(x + seg / 2, 0.36 * inch, dollars, fontName="Helvetica-Bold",
                         fontSize=8, fillColor=NIGHT, textAnchor="middle"))
            d.add(String(x + seg / 2, 0.255 * inch, tkr, fontName="Helvetica",
                         fontSize=6.4, fillColor=NIGHT, textAnchor="middle"))
        x += seg
    d.add(String(0, 0.0, "one twenty, eight tickers - poured automatically, every month",
                 fontName="Helvetica", fontSize=6.8, fillColor=MARBLE))
    return d


def gem_row():
    """The board - Friday's marks a trader glances at first, cockpit-styled."""
    gems = [
        ("SPY $743.29", "Fri -1.0% · wk -1.5%", ARC),
        ("VIX 18.77", "calm is under 20", ARC),
        ("10-YR 4.55%", "off 4.62% high", ARC),
        ("WTI $82+", "+10% on the week", GOLD),
        ("GOLD $4,017", "+20% in a year", ARC),
        ("FED JUL 28-29", "hold expected", ARC),
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


def data_table(rows, widths, right_from=1, header_color=GOLD):
    body = []
    for i, row in enumerate(rows):
        body.append([P(c, "cellb" if i == 0 or j == 0 else "cell")
                     for j, c in enumerate(row)])
    t = Table(body, colWidths=widths)
    cmds = [
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, header_color),
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
    story.append(P("UNISONA.AI MONTHLY · VOL. 1 · FOR EVERY USER - NO HOMEWORK REQUIRED", "kicker"))
    story.append(Spacer(1, 4))
    story.append(P("The July Leap", "title"))
    story.append(Spacer(1, 4))
    story.append(P(
        "World news in plain money-sense · where a spare $20 goes · the monthly postcard from our robot "
        "trader. Data through Friday, July 17 close. Published July 18, 2026.", "subtitle"))
    story.append(Spacer(1, 8))
    story.append(card([
        P("<b>Hi - welcome to the first Leap.</b> If we haven't met: we keep a house strategy here "
          "nicknamed <b>the champion</b> - a robot-managed recipe of eight funds (you'll get every "
          "ticker on page 4). We test it the honest way: a simulator started it with $2,000 + $20 a "
          "month in January 2000 and replayed every real market day since, crashes included, no peeking. "
          "That story stands at <b>$91,537</b> tonight. July asked it a real question - war headlines, "
          "oil up, the hot stocks suddenly cold - and it answered the way we hoped it would: calmly. "
          "You don't need our plan, or any plan, to use these pages; borrow the habits with any $20 on "
          "any app. We'll be here every month either way.", "body"),
        Spacer(1, 4),
        P("- the unisona.ai trading desk &nbsp;·&nbsp; <i>P.S. Our robot's live practice book: "
          "$24,997.62 at 2.0× - all three of its tripwires green. Real money stays parked behind the "
          "evidence gate, as always.</i>", "small"),
    ], accent=GOLD))
    story.append(Spacer(1, 8))
    story.append(comet_chart())
    story.append(Spacer(1, 3))
    story.append(P(
        "The whole flight in one picture: the gold comet is the champion ($8,380 total paid in, dashed "
        "line). The cyan line is the same drip into a plain S&amp;P 500 fund (ticker SPY) - $54,278, no "
        "robot needed, and still a lovely flight. Four storms, sailed through, dotted in blue.", "small"))
    story.append(Spacer(1, 8))
    story.append(P("THE BOARD · FRIDAY'S CLOSING MARKS", "label"))
    story.append(Spacer(1, 3))
    story.append(gem_row())
    story.append(Spacer(1, 8))
    story.append(P(
        "<b>The word for July is <font color='#F0C24C'>poise</font>.</b> The champion's balance eased "
        "-6.4% as the market rotated - and a dip this size has visited 24 times in 26 years, every one "
        "followed, in time, by a new high. So the robot's answer was the calmest sentence it knows: "
        "<i>all gates green, keep cruising, keep dripping.</i> Poise, practiced.", "big"))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 2
    story.append(P("PART 1 · THE SCOREBOARD", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The month so far, on one card", "h2"))
    story.append(Spacer(1, 5))
    story.append(data_table([
        ["Market", "Friday's mark", "Last week", "2026 so far"],
        ["S&amp;P 500 · SPY", "7,458 (-1.0%)", "-1.6%", "+9.6% first half"],
        ["Nasdaq · QQQ", "-1.5% Friday", "-2.9%", "strongest Q2 since 2020"],
        ["Small caps · IWM", "$294.04", "cooled with peers", "+21.2% H1 - biggest lead on the S&amp;P since 1991"],
        ["World stocks · EFA", "$103.33", "steadier", "beat the S&amp;P in June"],
        ["Long bonds · TLT", "$84.52", "10-yr at 4.55%", "off its 4.62% high"],
        ["Gold · GLD", "$4,017/oz", "about -3%", "-4.6% in July · +19.9% in a year"],
        ["Oil · WTI crude", "$82+", "+10%", "highest in a month"],
        ["The champion (sim)", "$91,537", "eased", "-6.4% in July · +7.2% YTD"],
    ], [1.5 * inch, 1.55 * inch, 1.35 * inch, 2.6 * inch]))
    story.append(Spacer(1, 4))
    story.append(P(
        "Friday, July 17 close. Under the hood, the market is broadening, not breaking: seven of "
        "eleven S&amp;P sectors rose in June (industrials led), profits are beating estimates, and the "
        "selling is concentrated in the year's hottest corner - chips. Sources: Trading Economics, "
        "CNBC, Morgan Stanley/E*TRADE monthly commentary; the champion is our walk-forward simulation.", "small"))
    story.append(Spacer(1, 11))

    def event(col, head, backstory, happened, wallet, calm):
        story.append(card([
            P("<b>%s</b>" % head, "big", textColor=col),
            Spacer(1, 4),
            P("THE BACKSTORY", "label"), Spacer(1, 1.5),
            P(backstory), Spacer(1, 4),
            P("WHAT JUST HAPPENED", "label"), Spacer(1, 1.5),
            P(happened), Spacer(1, 4),
            P("WHY IT TOUCHES YOUR WALLET", "label"), Spacer(1, 1.5),
            P(wallet), Spacer(1, 4),
            P("THE TAKEAWAY", "label"), Spacer(1, 1.5),
            P("<i>%s</i>" % calm),
        ], accent=col, pad=9))
        story.append(Spacer(1, 7))

    story.append(P("PART 2 · FOUR STORIES, FROM THE TOP", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The news, explained like you were away all month", "h2"))
    story.append(Spacer(1, 6))

    event(GOLD, "Oil jumped 10% as the Middle East flared up again",
          "A large share of the world's oil ships through one narrow sea lane - the Strait of Hormuz, "
          "between Iran and the Arabian peninsula. Whenever that lane looks risky, oil gets pricier "
          "everywhere, because tankers wait, insure, or take the long way round.",
          "A June truce between the US and Iran gave way in mid-July: strikes resumed on both sides and "
          "far fewer tankers made the passage - about half the usual traffic in a day. Crude climbed "
          "above $82 a barrel, its highest in a month, up 10% for the week (CNBC, July 16).",
          "Pricier oil seeps into daily life with a lag: the pump first, then flights, shipping, and "
          "some grocery prices. It can also make the inflation-watchers at the central bank more "
          "cautious about cutting interest rates. Markets themselves stayed remarkably calm - the "
          "'fear index' traders watch (the VIX) reads a mellow 18.8, which is normal-weather territory.",
          "Storm headlines are not an instruction to do anything. Keeping a cash cushion and letting a "
          "monthly auto-investment run is the whole move. Our robot's version of the same idea: it "
          "re-checks the weather every minute, ready to glide toward interest-earning cash - and this "
          "month it never needed to. Worth knowing: the pros' June notes celebrated this strait "
          "reopening; July closed it again. Headlines age fast - habits don't.")

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 3
    story.append(P("PART 2, CONTINUED", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The rotation, and the people who set the price of money", "h2"))
    story.append(Spacer(1, 6))

    event(CYAN, "The market's favorite stocks changed seats",
          "For two years the star performers were computer-chip and AI companies - they powered a huge "
          "run. Markets rotate, though: sooner or later money takes profits from the leaders and goes "
          "looking for the next value, and the leaderboard reshuffles. It's regular weather, not an "
          "alarm.",
          "That rotation arrived in July. Chip stocks slid on worries that the big AI buyers may slow "
          "their spending: on Friday alone the S&amp;P 500 fell 1.0% to 7,458, the Nasdaq 1.5%, and "
          "the Dow 407 points, capping a -1.6% week. The quiet part: seven of eleven S&amp;P sectors "
          "actually ROSE in June (industrials led), small companies are having their best lead over "
          "the S&amp;P since 1991 (+21.2% first half), and 87% of early earnings beat expectations "
          "(Trading Economics, CNBC, Seeking Alpha, E*TRADE commentary, July 16-18).",
          "If your savings live in a broad index fund, a week like this barely dents a decades-long "
          "plan. If you were tempted by 'the hot stock everyone mentions,' July is the case for "
          "spreading out: last month's rocket can be this month's cooldown - while quieter corners "
          "(small caps, world stocks) quietly carry the year.",
          "Own a little of everything and you never have to guess the next favorite. That's the whole "
          "trick behind index funds - and behind our robot's eight-ticker mix, which holds the "
          "winners' lane (SPMO, XMMO), the quiet leaders (IWM, EFA), and the ballast, all at once.")

    event(STORM, "The Fed holds interest rates steady - and cash still pays",
          "The Federal Reserve - 'the Fed' - is America's central bank. Its main dial is the interest "
          "rate: turning it up makes borrowing pricier and saving more rewarding (to cool inflation); "
          "turning it down does the reverse. Eight times a year its committee meets, and the world "
          "watches - these days under a new chair, Kevin Warsh, whose talk runs hawkish.",
          "The next meeting is July 28-29 and everything points to no change. June's inflation "
          "readings came in gentler than expected, though officials stay watchful with oil rising. "
          "The honest wrinkle: most economists expect a hold through 2026, while rate-futures traders "
          "still price real odds of a hike by December - the pros disagree, and we'd rather tell you "
          "that than pick a side (Fed minutes July 8; CNBC; E*TRADE commentary).",
          "This is the friendliest fact in finance right now: boring cash earns real interest again. "
          "High-yield savings accounts and money-market funds pay meaningful yields while rates hold - "
          "an emergency fund is no longer dead money, it's a small engine.",
          "Before any investing move, park one: a cushion in a high-yield account is the purchase that "
          "buys sleep. Our robot agrees so strongly it's built in - when it de-risks, it parks in "
          "interest-earning cash, never under a mattress.")

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 4
    story.append(P("PART 2, CONCLUDED", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The old anchor, the little dictionary, and the road ahead", "h2"))
    story.append(Spacer(1, 6))

    event(ARC, "Gold is having a golden year",
          "Gold is humanity's oldest savings account - no company behind it, no interest paid, just "
          "scarcity and trust. People reach for it when they're unsure about everything else, which is "
          "why it often (not always) rises when stocks or currencies wobble.",
          "It sits near $4,017 an ounce - up about 20% from a year ago even after a breather this "
          "month (Trading Economics, July 17). The year's conflicts and inflation worries kept the "
          "old anchor in demand.",
          "You don't need coins in a drawer to benefit; a small slice of a gold fund inside a mixed "
          "portfolio does the same job - it tends to zig when stocks zag, smoothing the ride. The key "
          "word is slice: gold pays no interest, so all-in is a bet, not a plan.",
          "A pinch of gold as seasoning, never the whole meal. In our robot's $20 pour it's $2.80 - "
          "enough anchor to steady the boat, never enough to slow the voyage.")

    story.append(P("The little dictionary - six words this report just used", "h3"))
    story.append(Spacer(1, 4))
    dico = [
        ("Index fund", "one purchase that buys a tiny slice of hundreds of companies at once. The classic is the S&amp;P 500."),
        ("Drip (auto-invest)", "the same small amount invested every month, automatically - rain, shine, or headlines."),
        ("The Fed", "America's central bank. Sets the price of borrowing; meets next July 28-29."),
        ("VIX", "the market's mood ring - a fear gauge. Under 20 reads calm; July 17 read 18.8."),
        ("Momentum", "owning a little extra of whatever has already been winning lately."),
        ("Dip", "how far a balance sits below its best-ever mark. The champion's July dip: 11%."),
    ]
    drows = []
    for i in range(0, len(dico), 2):
        drows.append([P("<b>%s</b> - %s" % dico[i], "small", textColor=INK),
                      P("<b>%s</b> - %s" % dico[i + 1], "small", textColor=INK)])
    dt = Table(drows, colWidths=[3.5 * inch, 3.5 * inch])
    dt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, ARC),
        ("LINEBEFORE", (1, 0), (1, -1), 2.4, ARC),
        ("LINEBELOW", (0, 0), (-1, -2), 3, NIGHT),
        ("LINEAFTER", (0, 0), (0, -1), 6, NIGHT),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(dt)
    story.append(Spacer(1, 10))

    story.append(P("The road ahead - what the pros have circled", "h3"))
    story.append(Spacer(1, 4))
    story.append(data_table([
        ["When", "What", "Why it's circled"],
        ["Wed, Jul 22", "Alphabet &amp; Tesla report earnings (plus ServiceNow, Texas Instruments)",
         "Alphabet's AI-spending plans are THE tell for the whole chip story above"],
        ["Thu-Fri, Jul 23-24", "Intel, Honeywell, Lockheed, Blackstone; then American Express",
         "earnings season is running +23% vs last year so far (FactSet)"],
        ["Tue-Wed, Jul 28-29", "The Fed meets", "hold expected; the tone under new chair Warsh is the story"],
        ["Every market minute", "Our robot re-checks its three tripwires", "boring by design - that's the product"],
    ], [1.15 * inch, 3.05 * inch, 2.8 * inch], right_from=99, header_color=CYAN))
    story.append(Spacer(1, 4))
    story.append(P(
        "A light week for economic data (jobless claims, PMI, new-home sales) and a heavy one for "
        "earnings - calendar via CNBC's week-ahead and Yahoo Finance (July 17).", "small"))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 5
    story.append(P("PART 3 · YOUR NEXT $20", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("Three lanes - start where you're standing", "h2"))
    story.append(Spacer(1, 5))
    story.append(P(
        "Twenty dollars a month sounds small; the chart on page 1 is what it looks like grown up. "
        "Pick the lane that matches your life today - each one is a complete, respectable answer.", "big"))
    story.append(Spacer(1, 8))

    lanes = [
        (GOLD, "LANE 1 · THE GUARANTEED WIN - claim this first",
         "If any card or loan is charging you double-digit interest, your next $20 earns its best "
         "return by shrinking that balance - an instant, sure gain no market can promise. Sorted? Then "
         "build the cushion: a few hundred in a high-yield savings account, which finally pays real "
         "interest while rates hold. Cushion first, adventure second - every good plan starts here."),
        (CYAN, "LANE 2 · THE ONE-FUND DRIP - the everyone answer",
         "A $20 automatic monthly buy of one broad, low-cost index fund at any major app or broker. "
         "Fractional shares mean twenty is plenty; automation means willpower is never invited. This "
         "is the cyan line on page 1: $8,380 dripped in since 2000 became $54,278 - through four "
         "storms - with zero decisions along the way. Set it on payday and forget it's happening."),
        (ARC, "LANE 3 · THE CHAMPION'S POUR - for the curious",
         "The robot's own recipe, if you enjoy a richer mix: eight ingredients, poured by target "
         "weights, a little extra to whatever's drifted cheap. Here is exactly how it would split a "
         "twenty this month:"),
    ]
    for col, head, body in lanes:
        story.append(card([P("<b>%s</b>" % head, "body", textColor=col),
                           Spacer(1, 3), P(body)], accent=col))
        story.append(Spacer(1, 7))

    story.append(split_bar())
    story.append(Spacer(1, 5))
    story.append(data_table(
        [["Ticker", "Fund", "What it is", "Fri close", "Weight", "Of your $20"]] +
        [[tkr, name, sub, px, wt, dollars] for tkr, name, sub, px, wt, dollars, _a, _c in SPLIT],
        [0.62 * inch, 1.42 * inch, 2.33 * inch, 0.95 * inch, 0.68 * inch, 1.0 * inch], right_from=3))
    story.append(Spacer(1, 3))
    story.append(P(
        "Lifetime-average recipe, weights rounded (the momentum slices grow as their track record does); "
        "closes are Friday 7/17 marks from our live monitor. Fractional shares make every slice buyable "
        "with pocket change - and any lane can graduate to the next whenever you're ready.", "small"))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 5
    story.append(P("PART 4 · HABITS &amp; THE LEAP AHEAD", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("Lean on, glide past, and where this could fly", "h2"))
    story.append(Spacer(1, 7))

    lean = [
        ("THE DRIP ITSELF", "Twenty in, every month, rain or shine. Across everything our lab has "
         "tested, the steady contribution beats every clever tweak. Level it up when life allows."),
        ("BORING BALLAST", "Cushion cash that earns interest, bonds, a pinch of gold - the unglamorous "
         "pieces are what let you stay invested when headlines shout."),
        ("TIME &amp; AUTOMATION", "The chart's secret isn't genius - it's 319 straight months of "
         "showing up. Automate the showing up and you've automated the hard part."),
    ]
    glide = [
        ("CHASING THE HOT STOCK", "July's coolest lesson: the spring's rockets took the summer's "
         "sharpest turn. A broad mix already owns tomorrow's winner - no guessing required."),
        ("BORROWING TO INVEST", "Leverage looks magic in good months and bites in bad ones. Our robot "
         "practices it in a gated paper account; personal money flies best unborrowed."),
        ("WATCHING DAILY", "A drip plan pays you for patience - every dip your $20 lands in is a "
         "discount. The scoreboard worth reading prints monthly. This is it."),
    ]
    rows = [[P("Lean on these", "h3"), P("Glide past these", "h3c")]]
    for (lh, lb), (gh, gb) in zip(lean, glide):
        rows.append([P("<b>%s</b> - %s" % (lh, lb), "cell"),
                     P("<b>%s</b> - %s" % (gh, gb), "cell")])
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
    story.append(Spacer(1, 7))

    story.append(card([P(
        "<b>THE 24-FOR-24 BADGE.</b> A month like July (-6.4%) has visited the champion's arc 24 times "
        "since 2000 - the dot-com winter, 2008, the 2020 flash-storm, the 2022 bear. After all 24, the "
        "balance went on to a brand-new high. Number 25 is now on the clock, chasing the May peak of "
        "$103,189. History measured, future unwritten - but that is one well-rehearsed bounce.", "big")],
        accent=GOLD, bg=colors.HexColor("#1A2320")))
    story.append(Spacer(1, 7))

    story.append(P("The leap - if the next years rhyme with the last 26", "h3"))
    story.append(Spacer(1, 4))
    story.append(data_table([
        ["From the champion's $91,537 + $20/month", "by 2031", "by 2036"],
        ["At its measured pace (12.6%/yr)", "about $167,000", "about $304,000"],
        ["At the plain index-fund pace (10.0%/yr)", "about $148,000", "about $241,000"],
        ["New money added along the way", "$1,200", "$2,400"],
    ], [3.7 * inch, 1.65 * inch, 1.65 * inch]))
    story.append(Spacer(1, 3))
    story.append(P(
        "Paces are what each line actually measured, 2000-2026; the future keeps its own counsel. The "
        "drip, the mix, and patience do the promising here - not the projection.", "small"))
    story.append(Spacer(1, 10))

    story.append(P("The dials - for readers who trade", "h3"))
    story.append(Spacer(1, 4))
    story.append(card([P(
        "Universe: SPY · QQQ · IWM · EFA · TLT · GLD · XMMO · SPMO, weighted by a shrunk tangency "
        "optimizer (per-fund cap 35%), rebalanced with a 0.6%-of-equity no-churn band - about monthly "
        "in practice. Exposure dial: gross 0 to 2.0×, set by a streaming brake = 35% volatility target "
        "× 6-month trend gate (to cash) × drawdown taper that begins at -30%; idle cash earns T-bill "
        "interest. Current stance: gross 2.0×, all three tripwires green, book drawdown -11% vs the "
        "-30% taper. A Conservative mode (max 1.0×, never borrows, 12-month trend, wider band, ~1 "
        "trade/month) shipped this month for funded balances. Paper only; live capital stays gated on "
        "out-of-sample evidence.", "small", textColor=INK)], accent=STORM, pad=8))
    story.append(Spacer(1, 6))

    story.append(P("Where every number comes from", "h3"))
    story.append(Spacer(1, 4))
    story.append(P(
        "Champion balances &amp; the chart: unisona.ai walk-forward simulation, 2000-2026, re-run July "
        "17 (real market history, borrowing costs charged, no peeking; monthly path on file). Practice "
        "book, ETF closes &amp; robot status: live monitor state, July 18, 17:38 UTC. Market weather &amp; "
        "indexes: Trading Economics and the July 18 feed (VIX 18.77). World news &amp; calendar: CNBC "
        "(July 8-17), Seeking Alpha (July 17), Federal Reserve minutes (July 8), Morgan Stanley/E*TRADE "
        "monthly commentary (July), FactSet earnings via CNBC.", "small"))

    story.append(PageBreak())

    # ---------------------------------------------------------------- back page
    story.append(P("THE BACK PAGE", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("About The Leap", "h2"))
    story.append(Spacer(1, 5))
    story.append(card([P(
        "<b>What this is.</b> The Sigma Trader Report is unisona.ai's monthly letter for every user - "
        "free and paid, beginner and trader. Each issue, in order: the scoreboard, the month's stories "
        "explained from the top, the road ahead, where a spare $20 goes, and the champion's numbers "
        "with their habits. It ships as a PDF on the site under /reports/ in the third week of the "
        "month. How to read it: <b>measured</b> numbers come from real history or our live practice "
        "book; <b>projected</b> numbers are clearly labeled rhymes, never promises; the guaranteed "
        "row is always the money you put in.", "body")], accent=GOLD))
    story.append(Spacer(1, 8))
    story.append(card([P(
        "<b>THE FINE PRINT, IN PLAIN ENGLISH.</b> This report is education, not personalized "
        "investment, tax, or legal advice, and not an offer or recommendation to buy or sell anything. "
        "The champion's track record is a simulation on real historical prices (borrowing costs "
        "charged; taxes not modeled); its live book is practice money; simulated and past performance "
        "never guarantee future results. Prices, yields, and dates are as shown and have moved since. "
        "Tickers describe our practice mix, not endorsements. Investing involves risk, including loss "
        "of what you put in; markets can fall by half and stay down for years. unisona.ai is software, "
        "not a registered investment adviser or broker-dealer - before acting on anything here, "
        "consider your own situation, ideally with a licensed advisor.", "small")], pad=9))
    story.append(Spacer(1, 6))
    story.append(P(
        "Until August - keep the drip alive. &nbsp;- the unisona.ai trading desk", "small",
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
