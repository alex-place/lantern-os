"""Sigma Trader Report - July 2026 (Vol. 1, the first monthly issue).

Builds docs/reports/sigma-trader-report-2026-07.pdf: the monthly investor-facing
report on the Champion trader - current balance, what moved it, current events
and what the system does with them, then the receipts. Loop stage: Verify
(it publishes the measured state of the Act-stage trading loop).

Every number in DATA below is pinned to its source; nothing is computed at
build time so the committed PDF is reproducible from this file alone.
Style follows docs/investing-2k-plan.html (answer first, receipts after,
failure map included; light-theme house palette).

Run:  python scripts/reports/sigma_trader_report_2026_07.py
"""
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "lantern-garage" / "public" / "reports" / "sigma-trader-report-2026-07.pdf"

# House palette (docs/investing-2k-plan.html, light theme)
PAPER = colors.HexColor("#FBFAF6")
INK = colors.HexColor("#16211F")
MUTED = colors.HexColor("#54635E")
HAIR = colors.HexColor("#E4E0D6")
COPPER = colors.HexColor("#B4622D")
PINE = colors.HexColor("#1F6F5C")
CARD = colors.white
RED = colors.HexColor("#A03A2E")

# WinAnsi-safe text only (built-in fonts): no Greek, no U+2212 minus, no arrows.
_BAD = re.compile(r"[^\x20-\x7E -ÿ–—‘’“”×·½]")


def s(style_name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(style_name, **base)


ST = {
    "kicker": s("kicker", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=COPPER),
    "title": s("title", fontName="Times-Bold", fontSize=26, leading=30, textColor=INK),
    "subtitle": s("subtitle", fontSize=10.5, leading=15, textColor=MUTED),
    "h2": s("h2", fontName="Times-Bold", fontSize=15.5, leading=19, textColor=INK, spaceBefore=6),
    "h3": s("h3", fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=PINE),
    "body": s("body"),
    "small": s("small", fontSize=8.3, leading=11.5, textColor=MUTED),
    "stat_n": s("stat_n", fontName="Times-Bold", fontSize=19, leading=22, textColor=INK),
    "stat_k": s("stat_k", fontName="Helvetica-Bold", fontSize=7.6, leading=10, textColor=MUTED),
    "cell": s("cell", fontSize=8.8, leading=12),
    "cellb": s("cellb", fontName="Helvetica-Bold", fontSize=8.8, leading=12),
    "mono": s("mono", fontName="Courier", fontSize=7.8, leading=10.5, textColor=MUTED),
}


def P(text, style="body", **kw):
    if _BAD.search(text):
        raise ValueError("non-WinAnsi glyph in: %r" % _BAD.search(text).group(0))
    st = ST[style] if not kw else ParagraphStyle("x", parent=ST[style], **kw)
    return Paragraph(text, st)


def rule(color=HAIR, w=0.7):
    return HRFlowable(width="100%", thickness=w, color=color, spaceBefore=6, spaceAfter=8)


def card(flowables, pad=10, bg=CARD, border=HAIR):
    t = Table([[flowables]], colWidths=[7.0 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), pad),
        ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, -1), pad - 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), pad - 2),
    ]))
    return t


def data_table(rows, widths, header=True, align_right_from=1):
    body = []
    for i, row in enumerate(rows):
        out = []
        for j, cell in enumerate(row):
            style = "cellb" if (header and i == 0) or j == 0 else "cell"
            out.append(P(cell, style))
        body.append(out)
    t = Table(body, colWidths=widths, repeatRows=1 if header else 0)
    cmds = [
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK if header else HAIR),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [CARD, PAPER]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    for j in range(align_right_from, len(rows[0])):
        cmds.append(("ALIGN", (j, 0), (j, -1), "RIGHT"))
    t.setStyle(TableStyle(cmds))
    return t


def on_page(canvas, doc):
    canvas.saveState()
    w, h = letter
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, w, h, stroke=0, fill=1)
    canvas.setStrokeColor(HAIR)
    canvas.setLineWidth(0.6)
    canvas.line(0.75 * inch, 0.62 * inch, w - 0.75 * inch, 0.62 * inch)
    canvas.setFont("Helvetica", 6.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.75 * inch, 0.47 * inch,
                      "unisona.ai · Sigma Trader Report · July 2026 · simulation + paper practice · "
                      "educational research, not investment advice")
    canvas.drawRightString(w - 0.75 * inch, 0.47 * inch, "p. %d" % doc.page)
    canvas.restoreState()


def build():
    story = []

    # ---------------------------------------------------------------- page 1
    story.append(P("UNISONA.AI · MONTHLY · VOL. 1 · FIRST ISSUE", "kicker"))
    story.append(Spacer(1, 4))
    story.append(P("Sigma Trader Report - July 2026", "title"))
    story.append(Spacer(1, 5))
    story.append(P(
        "Published Saturday, July 18, 2026 · data through Friday, July 17 close · "
        "the monthly state of the Champion trader: the answer first, then all the receipts.",
        "subtitle"))
    story.append(rule(INK, 1.1))

    story.append(P("The answer", "h2"))
    story.append(Spacer(1, 3))
    story.append(P(
        "<b>The champion gave back part of its May high this month - and did exactly what it was "
        "designed to do.</b> July's tape hit the plan where it tilts: the market's first-half momentum "
        "winners sold off hard in a chip-led rotation (S&amp;P 500 -1.6% for the week, Nasdaq -2.9%) "
        "while the US-Iran truce collapsed, the Strait of Hormuz seized up again, and oil jumped above "
        "$82. A momentum-tilted book at 2.0× gross feels that kind of week about twelve times harder "
        "than a plain index drip - and it did."))
    story.append(Spacer(1, 6))

    stats = Table([[
        [P("$91,537", "stat_n"), P("CHAMPION BALANCE (SIM), JULY 17", "stat_k"),
         P("$8,380 paid in since 2000 · 10.9× money multiple", "small")],
        [P("-6.4%", "stat_n", textColor=RED), P("JULY SO FAR (JUNE CLOSE $97,743)", "stat_k"),
         P("plain S&amp;P DCA: -0.5% · unbraked 2×: -8.7%", "small")],
        [P("2.0×", "stat_n", textColor=PINE), P("LIVE BRAKE STANCE: HOLDING", "stat_k"),
         P("VIX 18.77 (calm) · all three gates green", "small")],
        [P("$24,998", "stat_n"), P("LIVE $25K PAPER BOOK (STARTED 7/17)", "stat_k"),
         P("marked 2026-07-18 17:37 UTC", "small")],
    ]], colWidths=[1.75 * inch] * 4)
    stats.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD),
        ("BOX", (0, 0), (-1, -1), 0.8, HAIR),
        ("LINEAFTER", (0, 0), (-2, -1), 0.6, HAIR),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(stats)
    story.append(Spacer(1, 8))

    story.append(P(
        "Nothing here is off-script. The plan's own failure map ranks \"momentum's good decade may not "
        "repeat\" as risk #1, its worst simulated dip is -25%, and the current give-back is -11.3% off "
        "the May peak - two down months, well inside the envelope. The brake watched all of it in real "
        "time and kept reading calm: volatility low (VIX 18.77), the 12-month trend still up, the book's "
        "drawdown nowhere near the -30% taper. So it holds at 2.0× - on purpose, by rule, not by mood."))
    story.append(Spacer(1, 6))
    story.append(P(
        "<b>What to do this month is what the plan always says:</b> keep the contribution automatic, "
        "don't override the brake in either direction, and let the robot keep building the paper record "
        "that the gate demands before any real dollar moves. One genuinely new decision exists this "
        "month - a <b>Conservative (never-borrow) mode</b> shipped, and the evidence says it is the "
        "better risk-adjusted book. It gets a full section on page 3."))
    story.append(Spacer(1, 8))
    story.append(card([P(
        "<b>Standing rule.</b> Every balance on this page is measured inside a simulation or a paper "
        "(practice) account - not a live brokerage account. The robot's gate (ADR-0028) still withholds "
        "real money because nothing has met its live-evidence bar. That is the rule working, not failing. "
        "This report is educational research, not personalized investment advice - a licensed advisor "
        "and your own judgment make real decisions.", "small")], bg=PAPER))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 2
    story.append(P("PART 1 · THE BALANCE", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("The champion's month, in numbers", "h2"))
    story.append(Spacer(1, 4))
    story.append(P(
        "The walk-forward simulation that crowned the champion ($2,000 start in January 2000 + $20 every "
        "month, borrowing costs charged, no peeking) is re-marked through Friday's close. These are its "
        "monthly statement lines:"))
    story.append(Spacer(1, 6))
    story.append(data_table([
        ["Book", "May close", "June close", "July (to 7/17)", "MTD", "YTD"],
        ["Champion (momentum mix, 2× brake)", "$103,189", "$97,743", "$91,537", "-6.4%", "+7.2%"],
        ["Same engine, no brake (2×)", "$93,451", "$88,705", "$80,978", "-8.7%", "+5.6%"],
        ["Plain S&amp;P 500 DCA", "$55,108", "$54,561", "$54,278", "-0.5%", "+9.8%"],
        ["Money actually paid in", "$8,340", "$8,360", "$8,380", "-", "-"],
    ], [2.5 * inch, 0.95 * inch, 0.95 * inch, 1.05 * inch, 0.75 * inch, 0.75 * inch]))
    story.append(Spacer(1, 5))
    story.append(P(
        "YTD includes the $20 monthly deposits (about 0.2% of the move - noise). The champion's all-time "
        "peak was May 2026 at $103,189; it now sits 11.3% below it. Its worst drawdown across the whole "
        "26.5-year simulation remains -25.5%; plain S&amp;P's is -51%; the unbraked engine's is -68%.", "small"))
    story.append(Spacer(1, 10))

    story.append(P("Two honest flags before anything else", "h3"))
    story.append(Spacer(1, 3))
    story.append(P(
        "<b>1. The champion is losing to the index this year.</b> +7.2% vs +9.8% YTD. A momentum tilt "
        "trails when momentum rotates - that is the deal, printed on the label. One year is a datapoint, "
        "not a verdict; the full-period gap ($91.5k vs $54.3k on the same $8,380) is the claim the plan "
        "actually makes."))
    story.append(Spacer(1, 4))
    story.append(P(
        "<b>2. The drawdown is real and may deepen.</b> -11.3% off peak today; the sim's worst is -25.5%; "
        "the failure map says the future can be deeper and stay down longer. If watching that number fall "
        "would make you sell, the Conservative mode on page 3 - or plain unlevered indexing - is the "
        "honest fit, decided calmly now rather than at the bottom."))
    story.append(Spacer(1, 10))

    story.append(P("The live paper book (the record that gates real money)", "h3"))
    story.append(Spacer(1, 3))
    story.append(P(
        "The streaming brake runs against a virtual $25,000 practice book so its decisions leave a "
        "scoreable trail. It started Friday morning, July 17; as of the last mark it reads:"))
    story.append(Spacer(1, 5))
    story.append(data_table([
        ["Reading", "Value", "Meaning"],
        ["Book equity", "$24,997.62", "-0.01% from the $25,000 start (one calm-ish day old)"],
        ["Gross target", "2.0× - \"holding\"", "14 status marks since 7/17, zero brake trips"],
        ["Vol gate", "green", "VIX 18.77 - calm regime despite the war tape"],
        ["Trend gate (12-mo)", "green", "S&amp;P positive on the year; no cash step triggered"],
        ["Drawdown taper", "green", "book far above the -30% taper zone"],
    ], [1.45 * inch, 1.55 * inch, 4.0 * inch]))
    story.append(Spacer(1, 5))
    story.append(P(
        "Candor note: the stable dashboard API was unreachable at press time (host outage), so these "
        "readings come straight from the monitor's state file on disk, last saved 2026-07-18 17:38 UTC. "
        "Last marked prices: SPY 743.29 · QQQ 695.33 · IWM 294.04 · EFA 103.33 · TLT 84.52 · GLD 368.41 "
        "· XMMO 157.08 · SPMO 143.89.", "small"))
    story.append(Spacer(1, 8))
    story.append(card([P(
        "<b>Also shipped this week:</b> the champion allocation now runs as a real (paper-only) book - "
        "target weights × the live brake's gross, rebalanced with a no-churn band, every action logged to "
        "a ledger the gate can score later. It is dry-run by default, hard-refuses live accounts in code, "
        "and has placed nothing. The live-record clock the gate requires has now started ticking.", "small")]))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 3
    story.append(P("PART 2 · CURRENT EVENTS", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("What happened in the world - and what the system does with it", "h2"))
    story.append(Spacer(1, 4))
    story.append(P(
        "Four things moved markets this month. For each: what happened (sourced, dated), then the only "
        "question the plan cares about - which rule does it touch?"))
    story.append(Spacer(1, 8))

    def event(no, head, what, touch):
        story.append(P("%s · %s" % (no, head), "h3"))
        story.append(Spacer(1, 2.5))
        story.append(P(what))
        story.append(Spacer(1, 3))
        story.append(P("<b>What the system does with it:</b> " + touch))
        story.append(Spacer(1, 8))

    event("01", "The Middle East truce collapsed; oil jumped 10% in a week",
          "The June US-Iran truce broke down. US strikes ran a sixth consecutive night by July 16; Iran "
          "answered against US bases in Kuwait, Jordan and Bahrain; a US naval blockade was reimposed and "
          "Strait of Hormuz transits roughly halved (13 ships to 7 in a day). Crude rose above $82 - a "
          "one-month high, up more than 10% on the week - with analysts floating $90-100 if the strait "
          "stays contested (CNBC, 7/16; Federal News Network, 7/17).",
          "war reaches the book as an inflation shock (oil) before an equity shock. The brake doesn't "
          "read headlines - it reads volatility, trend, and drawdown, and all three still say calm: the "
          "market is, so far, pricing a contained conflict (VIX 18.77). If that repricing comes, "
          "de-levering is automatic and fast - in the measured hourly test the streaming brake stepped "
          "toward cash 71 hours earlier than a daily check on the worst crash day in its window.")

    event("02", "Momentum rotated - hard - out of the first half's winners",
          "The S&amp;P 500 lost 1.6% and the Nasdaq 2.9% for the week as chip stocks slid (Taiwan Semi's "
          "capex-raise spooked the group; the SMH semiconductor ETF is down almost 9% over four weeks). "
          "Seeking Alpha's summary: the first half's biggest S&amp;P winners \"have stumbled in July - a "
          "sharp rotation away from the market's strongest momentum names.\" The undertow is not "
          "earnings: 87% of the first 40 S&amp;P reporters beat estimates (CNBC 7/16-7/17; Seeking Alpha "
          "7/17; Fortune 7/5 had already flagged \"speculation hitting extreme levels\").",
          "this is the champion's own exposure - a momentum tilt at 2.0× gross - and it is precisely why "
          "the book fell about twelve times more than a plain index drip this month. Failure-map risk #1 "
          "(\"momentum's good decade may not repeat\") is live on the tape right now, not hypothetical. "
          "The counterweight is also on the record: the same engine ate -25% in 2008-style storms inside "
          "the sim and finished 68% ahead of the index overall. The plan's answer to a rotation is the "
          "rules, not a reaction.")

    event("03", "The Fed: on hold this month, but leaning hawkish into year-end",
          "The July 28-29 FOMC is priced as a near-certain hold. June CPI and PPI both came in below "
          "expectations, which cooled things - yet rate futures still put better than two-in-three odds "
          "on a HIKE by December, with June minutes showing a split committee; war-oil keeps the "
          "inflation risk alive. The 10-year Treasury sits at 4.55% (7/17), just off a two-month high of "
          "4.62% (Federal Reserve minutes 7/8; CNBC 7/8; Trading Economics/FRED 7/17).",
          "two rules feel this. First, the brake's cash refuge earns T-bill interest - at today's rates, "
          "stepping to cash in a storm is shelter with a yield, not dead money. Second, the 2× book "
          "borrows at rates that only get pricier if hikes come, while the sim's funding charge is "
          "fixed-formula - a real-world drag the failure map already flags. Both cut the same way: "
          "toward the never-borrow Conservative mode below.")

    event("04", "Gold did its job badly this month - and well this year",
          "Gold marked $4,017/oz on July 17: down 4.6% on the month (it spent Friday below $4,000 and "
          "was tracking a 3% weekly loss) even as missiles flew - rate-hike fear beat the safe-haven bid "
          "- yet still up 19.9% year over year, about a quarter below January's record (Trading "
          "Economics 7/17; Fortune 7/6).",
          "GLD is roughly a seventh of the mix as ballast, not a bet. A month where gold falls during a "
          "shooting war is the periodic reminder that ballast is a correlation story with exceptions, "
          "not a guarantee - which is why the plan holds it at a slice, rebalanced by rule, rather than "
          "as a conviction trade.")

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 4
    story.append(P("PART 3 · WHAT TO ACTUALLY DO", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("July's suggestions - all of them rules, none of them trades", "h2"))
    story.append(Spacer(1, 4))
    story.append(P(
        "These are the plan's own moves for a month like this, stated as the system enforces them. None "
        "of this is personalized advice; all real-money actions remain a human's click, ideally with a "
        "licensed advisor.", "small"))
    story.append(Spacer(1, 7))

    def move(no, head, body):
        story.append(P("%s · %s" % (no, head), "h3"))
        story.append(Spacer(1, 2.5))
        story.append(P(body))
        story.append(Spacer(1, 7))

    move("01", "Change nothing about the cadence",
         "The $20 keeps buying automatically, into weakness included - that is the design. Across every "
         "test the plan ever ran, the contribution - not the strategy - is the biggest lever on the "
         "outcome. If anything changes this month, make it the contribution size, not the strategy.")

    move("02", "Decide - once, calmly - which book you want to be: 2× braked, or Conservative",
         "New this month: a ten-iteration deep-history study (S&amp;P back to 1927, Nasdaq to 1971) "
         "shipped a <b>Conservative, never-borrow (max 1×) mode</b> into the live champion book. The "
         "evidence: the best risk-adjusted result of every variant tested (Sharpe 0.71/0.90 vs 0.42/0.60 "
         "buy-and-hold), roughly half the drawdown, about one trade a month, an edge that is "
         "statistically significant (the Sharpe-difference confidence interval excludes zero on both "
         "indices), robust to 10× worse trading costs, and independently matching the published "
         "Faber/AQR/Antonacci results. The honest cost: under a small monthly drip from zero it ends "
         "with less final money than buy-and-hold - it is risk-protection, not return-maximization. In "
         "a month with a war premium in oil, a Fed leaning toward hikes, and margin only getting "
         "pricier, the never-borrow book is the one the evidence keeps voting for. The default remains "
         "2×; the mode is a dial, and a person decides.")

    move("03", "Do not override the brake - in either direction",
         "Selling now because July feels bad is the behavior risk the failure map ranks above every "
         "market risk. Adding leverage because the dip \"looks cheap\" is the same error mirrored. The "
         "book de-levers by rule when any gate trips: a volatility breach, a 12-month trend break, or "
         "the -30% drawdown taper. All three read green today. Let the rules be the ones that panic - "
         "they are faster (71 hours faster, measured) and they do not feel anything.")

    move("04", "Options stay seatbelts, not bets",
         "With 100+ shares of a holding, the robot may propose covered calls (rent on shares you own) "
         "or protective collars (a floor under them). Proposals only; naked variants remain banned in "
         "code. Nothing changed this month, and in a tape where volatility is cheap-calm while "
         "headlines are not, selling panic you don't own is exactly what the ban is for.")

    move("05", "Remember what the balances are - and what the gate is doing",
         "$91,537 is a simulation's July mark. $24,998 is a two-day-old practice book. The gate "
         "(ADR-0028) requires a live, statistically significant record before any real dollar moves, "
         "measured against a lifetime-Buffett bar - and nothing has met it. Meanwhile the single "
         "highest-confidence move on any page of this plan is unchanged: raise the monthly "
         "contribution while the risk engine stays in practice mode.")

    story.append(Spacer(1, 2))
    story.append(card([P(
        "<b>What would change next month's answer.</b> A vol or trend gate trip (the report would show "
        "the de-lever, step by step) · the momentum rotation extending into a -15%+ book drawdown (the "
        "envelope talk gets real) · a December-hike repricing (the funding-cost math worsens for 2×) · "
        "the paper book's first full month, scored. The report will print whichever of these happens, "
        "and what the rules did about it - losers next to winners, as always.", "small")]))

    story.append(PageBreak())

    # ---------------------------------------------------------------- page 5
    story.append(P("PART 4 · THE RECEIPTS", "kicker"))
    story.append(Spacer(1, 3))
    story.append(P("Every number on these pages, pinned to its source", "h2"))
    story.append(Spacer(1, 5))

    story.append(P("Measured - in the walk-forward simulation", "h3"))
    story.append(Spacer(1, 3))
    story.append(P(
        "Champion monthly balances (May $103,189 / June $97,743 / July $91,537; peak May 2026; MTD "
        "-6.35%; YTD +7.24%), plain S&amp;P DCA (May $55,108 / June $54,561 / July $54,278; YTD +9.78%), "
        "unbraked 2× (July $80,978), paid-in $8,380, full-period Sharpe 0.65, max drawdown -25.5% / "
        "-51.2% / -68.4%: <font face='Courier' size='7.8'>experiments/dca_champion_2k.py</font> "
        "walk-forward 2000-01 to 2026-07, monthly path in <font face='Courier' size='7.8'>"
        "dca_champion_paths.json</font>, run 2026-07-17 15:19 ET; cross-checked against <font "
        "face='Courier' size='7.8'>experiments/twok_start.json</font> regenerated 2026-07-18. The "
        "published plan page (docs/investing-2k-plan.html) quotes $91,843/$54,603/$82,087 from a "
        "one-session-earlier data vintage - the ~0.3% gap is one down day, an honest measure of "
        "run-vintage sensitivity.", "small"))
    story.append(Spacer(1, 6))
    story.append(P(
        "Deep-history study (the Conservative mode's evidence): S&amp;P 1927+ never-borrow Sharpe 0.71 "
        "vs 0.42 buy-and-hold, max drawdown -30% vs -86%, ~16 trades/yr; Nasdaq 1971+ 0.90 vs 0.60, "
        "-25% vs -78%; Sharpe-difference bootstrap CIs [+0.10, +0.43] and [+0.09, +0.52] (both exclude "
        "zero, 2,000 block-bootstrap resamples); survives cost stress to 20bp; on the real 8-ETF "
        "universe 2015-2026: Sharpe 1.07 vs 0.95, drawdown -16% vs -25%, 6.1 trades/yr. Honest "
        "reversal, stated: under $20/mo DCA-from-zero, buy-and-hold ends with MORE money (S&amp;P "
        "$4.39M vs $2.80M) - the overlay halves drawdown instead. <font face='Courier' size='7.8'>"
        "experiments/DEEP_HISTORY_RESEARCH_LOG.md</font>, merged in PR #2728 (48/48 CI checks green), "
        "2026-07-18.", "small"))
    story.append(Spacer(1, 6))

    story.append(P("Measured - live, at press time", "h3"))
    story.append(Spacer(1, 3))
    story.append(P(
        "Paper book $24,997.62 (peak $25,000), gross target 2.0×, 14 marks all \"holding 2.0×\" since "
        "2026-07-17 17:31 UTC, zero trips: monitor state file <font face='Courier' size='7.8'>"
        "data/trading/brake-monitor.json</font>, saved 2026-07-18 17:38 UTC (dashboard API down at "
        "press time - host outage; state read from disk). Market feed (keyless Yahoo, 2026-07-18): VIX "
        "18.77 calm regime; SPY -0.99% on Friday, -1.54% over 5 days; US session closed (Saturday). "
        "Champion-book paper deployment + Conservative dial: <font face='Courier' size='7.8'>"
        "apps/lantern-garage/lib/champion-book.js</font>, 11/11 unit tests, PR #2728.", "small"))
    story.append(Spacer(1, 6))

    story.append(P("Web-grounded - current events (all accessed 2026-07-18; confidence: recent, multi-source)", "h3"))
    story.append(Spacer(1, 3))
    for line in [
        "US-Iran truce collapse, sixth night of strikes, Hormuz transits 13 to 7, oil above $82 (+10% "
        "wk), $90-100 talk: CNBC 7/16 (cnbc.com/2026/07/16/oil-rise-as-us-strikes-on-iran...), Federal "
        "News Network 7/17, Trading Economics crude page.",
        "S&amp;P -1.6% / Nasdaq -2.9% on the week; chip slide on Taiwan Semi capex; SMH -9% over four "
        "weeks; 87% of first 40 reporters beat; rotation out of H1 momentum winners: CNBC market wraps "
        "7/16-7/17, Seeking Alpha \"July pullback hits first-half S&amp;P 500 winners\" 7/17, Fortune "
        "\"speculation hitting extreme levels\" 7/5.",
        "FOMC 7/28-29 hold priced; June CPI+PPI below expectations; >2/3 odds of a hike by December; "
        "split June minutes; 10Y 4.55% off a 4.62% two-month high: federalreserve.gov June minutes "
        "(7/8), CNBC 7/8, Trading Economics / FRED DGS10 7/17, Kalshi+Polymarket July-Fed markets.",
        "Gold $4,017/oz 7/17, -4.6% month, +19.9% y/y, ~25% below the January record, sub-$4,000 "
        "intraweek: Trading Economics gold page 7/17, Fortune gold 7/6.",
    ]:
        story.append(P("· " + line, "small"))
        story.append(Spacer(1, 3))
    story.append(Spacer(1, 4))

    story.append(P("Governance - why no real money moved (or can)", "h3"))
    story.append(Spacer(1, 3))
    story.append(P(
        "ADR-0028: real capital requires a live record whose Sharpe confidence interval clears the "
        "lifetime-Buffett bar (0.79); nothing qualifies, so the gate withholds - by design. The champion "
        "book is paper-only in code (hard-refuses live accounts), dry-run by default, and every "
        "rebalance lands in an append-only ledger for the gate to score. Options engines are "
        "proposal-only; naked strategies are banned in code. Nothing in this system places real "
        "orders.", "small"))
    story.append(Spacer(1, 8))
    story.append(rule())
    story.append(P(
        "<b>The honest ending.</b> This report is a practice story built from real historical prices "
        "and one day of live paper marks - not a promise, not personal financial advice, and not "
        "evidence of a live edge. The champion's numbers are measured inside a simulation conditional "
        "on its exact code, prices, and cost model; they include borrowing costs and trading drag but "
        "not taxes; markets can fall by half and stay down for years. The champion is trailing the "
        "plain index this year and sits 11.3% below its peak - both printed above, next to the wins, "
        "because a page that only argues for itself isn't evidence. Full failure map: "
        "docs/investing-2k-plan.html, \"Where this could be wrong.\"", "small"))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(str(OUT), pagesize=letter,
                          leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                          topMargin=0.7 * inch, bottomMargin=0.85 * inch,
                          title="Sigma Trader Report - July 2026",
                          author="unisona.ai")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=on_page)])
    doc.build(story)
    print("wrote %s" % OUT)


if __name__ == "__main__":
    build()
