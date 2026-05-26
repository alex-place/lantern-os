#!/usr/bin/env python3
"""
COMET LEAP: Bayesian Founder Protocol v2.0
The Accountable Bayesian Integrator — How Structured Counter-Bias Methods Transform Founder Decision-Making
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    KeepTogether, Image
)
from reportlab.lib import colors
from datetime import datetime

# Setup professional document
doc = SimpleDocTemplate(
    "COMET-LEAP-Bayesian-Founder-Protocol-v2.pdf",
    pagesize=letter,
    rightMargin=0.6*inch,
    leftMargin=0.6*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch,
    title="COMET LEAP: Bayesian Founder Protocol",
    author="Alex Place, Founder Research"
)

# Define comprehensive style library
styles = getSampleStyleSheet()

# Color palette
COMET_DARK = colors.HexColor('#0f172a')
COMET_BLUE = colors.HexColor('#1e40af')
COMET_LIGHT = colors.HexColor('#dbeafe')
COMET_ACCENT = colors.HexColor('#dc2626')
GRAY_DARK = colors.HexColor('#374151')
GRAY_LIGHT = colors.HexColor('#f3f4f6')

# Title style
title_style = ParagraphStyle(
    'TitleStyle',
    parent=styles['Heading1'],
    fontSize=28,
    textColor=COMET_DARK,
    spaceAfter=6,
    alignment=TA_CENTER,
    fontName='Helvetica-Bold',
    leading=32
)

subtitle_style = ParagraphStyle(
    'SubtitleStyle',
    parent=styles['Normal'],
    fontSize=14,
    textColor=COMET_BLUE,
    spaceAfter=12,
    alignment=TA_CENTER,
    fontName='Helvetica-Oblique'
)

section_style = ParagraphStyle(
    'SectionStyle',
    parent=styles['Heading1'],
    fontSize=15,
    textColor=colors.white,
    spaceAfter=8,
    spaceBefore=12,
    fontName='Helvetica-Bold'
)

heading2_style = ParagraphStyle(
    'Heading2Custom',
    parent=styles['Heading2'],
    fontSize=12,
    textColor=COMET_DARK,
    spaceAfter=6,
    spaceBefore=8,
    fontName='Helvetica-Bold'
)

body_style = ParagraphStyle(
    'BodyStyle',
    parent=styles['Normal'],
    fontSize=10.5,
    leading=13,
    alignment=TA_JUSTIFY,
    spaceAfter=8,
    textColor=GRAY_DARK
)

callout_style = ParagraphStyle(
    'CalloutStyle',
    parent=styles['Normal'],
    fontSize=10,
    leading=12,
    alignment=TA_LEFT,
    spaceAfter=6,
    textColor=COMET_DARK,
    fontName='Helvetica-Bold',
    leftIndent=12
)

# Build story
story = []

# ============================================================================
# PAGE 1: COVER AND THESIS
# ============================================================================

story.append(Spacer(1, 0.5*inch))
story.append(Paragraph("COMET LEAP", title_style))
story.append(Spacer(1, 0.05*inch))

story.append(Paragraph(
    "Bayesian Founder Protocol v2.0",
    subtitle_style
))

story.append(Spacer(1, 0.15*inch))

story.append(Paragraph(
    "The Accountable Bayesian Integrator<br/>How Structured Counter-Bias Methods Transform Founder Decision-Making",
    ParagraphStyle(
        'Declaration',
        parent=styles['Normal'],
        fontSize=12,
        textColor=GRAY_DARK,
        alignment=TA_CENTER,
        leading=14,
        spaceAfter=20
    )
))

story.append(Spacer(1, 0.3*inch))

# Central thesis in box
thesis_data = [[
    Paragraph(
        "<b>CENTRAL THESIS</b><br/><br/>"
        "The founder is not automatically unbiased.<br/>"
        "The founder is <i>needed</i> as the accountable Bayesian integrator who:<br/><br/>"
        "• Names priors explicitly<br/>"
        "• Protects and logs dissent<br/>"
        "• Updates beliefs on evidence<br/>"
        "• Converts consensus into reversible action<br/><br/>"
        "Unbiased wisdom emerges from founder responsibility + structured counter-bias methods,<br/>"
        "not from founder virtue.",
        ParagraphStyle(
            'ThesisText',
            parent=styles['Normal'],
            fontSize=11,
            textColor=colors.white,
            leading=14,
            alignment=TA_CENTER,
            fontName='Helvetica'
        )
    )
]]

thesis_table = Table(thesis_data, colWidths=[6.5*inch])
thesis_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_BLUE),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('LEFTPADDING', (0, 0), (-1, -1), 20),
    ('RIGHTPADDING', (0, 0), (-1, -1), 20),
    ('TOPPADDING', (0, 0), (-1, -1), 20),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 20),
    ('ROUNDEDCORNERS', (0, 0), (-1, -1), 4),
]))
story.append(thesis_table)

story.append(Spacer(1, 0.25*inch))

# Key research anchors
story.append(Paragraph("<b>Research Anchors</b>", heading2_style))

anchors = """
• <b>Bayesian Epistemology:</b> Beliefs are degrees of probability; evidence updates rationally via Bayes' theorem
<br/>• <b>Collective Wisdom Paradox:</b> Small independent debates outperform large raw crowds; social influence corrupts accuracy
<br/>• <b>Structured Methods:</b> Analysis of Competing Hypotheses (ACH), Delphi rounds, independent estimates, dissent logs restore wisdom under uncertainty
<br/>• <b>Founder Research:</b> Founder traits matter, but there is no single ideal founder type; team diversity determines outcomes
<br/>• <b>Accountability:</b> The founder's reversibility and responsibility—not virtue—makes structured methods credible
"""
story.append(Paragraph(anchors, body_style))

story.append(Spacer(1, 0.2*inch))

# Date and version
date_style = ParagraphStyle(
    'DateStyle',
    parent=styles['Normal'],
    fontSize=9,
    textColor=colors.HexColor('#6b7280'),
    alignment=TA_CENTER
)
story.append(Paragraph(f"May 26, 2026 | Version 2.0 | COMET LEAP Protocol Series", date_style))

story.append(PageBreak())

# ============================================================================
# PAGE 2: THE PARADOX AND THE SOLUTION
# ============================================================================

# Section header with background
section_data = [["The Founder Paradox and Counter-Bias Resolution"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

story.append(Paragraph("I. Why Founders Are Biased", heading2_style))

bias_text = """
Cognitive science documents systematic founder biases:
<br/><br/>
<b>Confirmation Bias:</b> Interpreting evidence as validating the founder's vision, not questioning it
<br/><b>Optimism Bias:</b> Overweighting success probabilities, underweighting failure costs
<br/><b>Path Dependency:</b> Past wins create false patterns; past losses create false risk aversion
<br/><b>Authority Bias:</b> Own conviction outweighs external expert opinion because founder made the bet
<br/><b>Sunk Cost Fallacy:</b> Continuing failed strategies because of prior investment
<br/><br/>
These biases are <b>rational responses to uncertainty</b>, not character flaws. When you're betting your life on a vision, confirmation bias is survival. The problem: unchecked, it becomes organizational dogma.
"""
story.append(Paragraph(bias_text, body_style))

story.append(Spacer(1, 0.1*inch))

story.append(Paragraph("II. Why Founders Cannot Be Removed", heading2_style))

remove_text = """
Despite these biases, founders are indispensable:
<br/><br/>
<b>Systems Integration:</b> Only the founder simultaneously sees all 9 parallel streams (cure-gen, retro-gaming, orchestrator, progress-tracking, evidence-framework, rag-house, care-support, sales-growth, governance). No subteam has this view.
<br/><br/>
<b>Authority to Act:</b> Bayesian consensus requires decision authority. The founder has the legitimate power to reallocate capital, shut down failing streams, and reverse decisions. Consensus without authority is talking.
<br/><br/>
<b>Accountability:</b> The founder is personally liable. This creates incentive alignment that no committee provides. Bad bets cost the founder their wealth, health, and time.
<br/><br/>
<b>Unique Information:</b> Founders access board conversations, investor feedback, and strategic context that operational teams lack.
<br/><br/>
<b>The Paradox:</b> We cannot remove the biased founder. We must calibrate the founder.
"""
story.append(Paragraph(remove_text, body_style))

story.append(Spacer(1, 0.1*inch))

story.append(Paragraph("III. The Solution: Structured Counter-Bias Methods", heading2_style))

solution_text = """
Unbiased wisdom emerges not from founder perfection, but from founder accountability + structured methods:
<br/><br/>
Rather than trust the founder's judgment, <b>structure the decision process</b> to make bias visible and correctable.
"""
story.append(Paragraph(solution_text, body_style))

story.append(PageBreak())

# ============================================================================
# PAGE 3: SEVEN COUNTER-BIAS METHODS
# ============================================================================

section_data = [["The Seven Counter-Bias Methods"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

# Method 1
story.append(Paragraph("1. PRIOR ARTICULATION (Monday Assumption Audit)", heading2_style))
method1 = """
<b>The Method:</b> Founder explicitly writes down all assumptions before evidence collection. Each assumption gets:
<br/><br/>
• <b>Statement:</b> "Assumption X is true"
<br/>• <b>Prior Confidence:</b> 0-100% degree of belief
<br/>• <b>Impact:</b> How much does this assumption matter? (1-5 scale)
<br/>• <b>Evidence Type:</b> What would change my mind?
<br/><br/>
<b>Why This Works:</b> Once written, the founder cannot unconsciously shift goalposts. Confirmation bias becomes visible—the founder must explicitly defend why new evidence supports the assumption.
<br/><br/>
<b>Bayesian Insight:</b> Priors must be stated before likelihood is observed, or they are not priors—they are post-hoc rationalizations.
"""
story.append(Paragraph(method1, body_style))

story.append(Spacer(1, 0.08*inch))

# Method 2
story.append(Paragraph("2. INDEPENDENT ESTIMATES (Before Consensus)", heading2_style))
method2 = """
<b>The Method:</b> Each stream team estimates success probability <b>independently</b>, without founder presence. The founder's estimate is kept separate. Results are compared.
<br/><br/>
<b>Why This Works:</b> Social influence and authority bias distort team estimates when founder is present. Independent estimates surface disagreement. Large disagreement between founder and teams is a <b>red flag</b> for founder bias.
<br/><br/>
<b>Bayesian Insight:</b> Diverse priors are valuable; converging priors too quickly suggests social influence, not evidence integration.
"""
story.append(Paragraph(method2, body_style))

story.append(Spacer(1, 0.08*inch))

# Method 3
story.append(Paragraph("3. ANALYSIS OF COMPETING HYPOTHESES (ACH)", heading2_style))
method3 = """
<b>The Method:</b> For the top 3 competing strategies:
<br/><br/>
1. Identify all hypotheses (Hypothesis A: cure-gen will succeed; Hypothesis B: sales-growth will succeed; Hypothesis C: both will fail)
<br/>2. List evidence that would support each hypothesis
<br/>3. For each piece of evidence: does it favor hypothesis A, B, C, or is it neutral?
<br/>4. Ask: what evidence would <b>disconfirm</b> each hypothesis?
<br/>5. Weight evidence by how <b>unlikely</b> it is under each hypothesis
<br/><br/>
<b>Why This Works:</b> Prevents confirmation bias by forcing the founder to identify evidence <b>against</b> their preferred hypothesis. Disconfirming evidence gets explicit attention.
<br/><br/>
<b>Bayesian Insight:</b> The strength of evidence depends on likelihood ratio: P(evidence | hypothesis A) / P(evidence | hypothesis B).
"""
story.append(Paragraph(method3, body_style))

story.append(PageBreak())

# Method 4
story.append(Paragraph("4. DELPHI ROUNDS (Iterative Expert Consensus)", heading2_style))
method4 = """
<b>The Method:</b>
<br/>Round 1: Each expert (stream lead) estimates success probability <b>anonymously</b>
<br/>Round 2: Reveal estimates; experts see where they differ
<br/>Round 3: Experts revise estimates with explanation of why they changed
<br/><br/>
Founder sees all revisions but does not speak until final round. This prevents early authority anchoring.
<br/><br/>
<b>Why This Works:</b> Convergence is faster and more accurate when experts are not socially pressured by founder authority. Dissent is preserved longer, allowing more careful deliberation.
<br/><br/>
<b>Bayesian Insight:</b> Diverse priors updated independently often converge to truth faster than large groups pressured toward consensus.
"""
story.append(Paragraph(method4, body_style))

story.append(Spacer(1, 0.08*inch))

# Method 5
story.append(Paragraph("5. DISSENT LOGS (Preserving Disagreement)", heading2_style))
method5 = """
<b>The Method:</b> Every decision includes a dissent log:
<br/><br/>
• Who disagreed with the founder's decision?
<br/>• What was their alternative recommendation?
<br/>• What evidence did they cite for the alternative?
<br/>• Timestamp and signature
<br/><br/>
<b>Why This Works:</b> Dissent has organizational cover. Teams feel safe disagreeing because the disagreement is recorded, not erased. Founder cannot later blame dissenters for "not speaking up."
<br/><br/>
<b>Bayesian Insight:</b> Disagreement is evidence of genuine uncertainty. Suppressing dissent is suppressing information.
"""
story.append(Paragraph(method5, body_style))

story.append(Spacer(1, 0.08*inch))

# Method 6
story.append(Paragraph("6. CALIBRATION (Confidence vs. Accuracy)", heading2_style))
method6 = """
<b>The Method:</b> Track founder's predictions over 8 weeks:
<br/><br/>
• Week 1: Founder predicts "70% confident cure-gen will generate 5 papers"
<br/>• Week 8: Actual outcome measured
<br/>• Calibration Score: If 70% predictions succeed ~70% of the time, founder is well-calibrated
<br/><br/>
<b>Why This Works:</b> Calibration reveals overconfidence (founder says 80%, only 60% succeed) or underconfidence (founder says 40%, 70% succeed). Overconfidence is the signature of bias.
<br/><br/>
<b>Bayesian Insight:</b> Proper confidence comes from evidence, not conviction. Overconfident forecasters are systematically wrong.
"""
story.append(Paragraph(method6, body_style))

story.append(Spacer(1, 0.08*inch))

# Method 7
story.append(Paragraph("7. PROOF GATES (Reversibility)", heading2_style))
method7 = """
<b>The Method:</b> Every major decision includes a proof gate:
<br/><br/>
<b>Decision:</b> "Allocate $50K to cure-gen over sales-growth"
<br/><b>Proof Gate:</b> "In 4 weeks, if cure-gen generates <2 papers, reallocate to sales-growth"
<br/><b>Reversibility:</b> Decisions are not permanent. They are experiments with pre-set reversal conditions.
<br/><br/>
<b>Why This Works:</b> Lowers the psychological cost of being wrong. Founder can make bold bets because bad bets are reversible. This eliminates sunk-cost fallacy.
<br/><br/>
<b>Bayesian Insight:</b> Decisions should be treated as provisional hypotheses, not permanent commitments.
"""
story.append(Paragraph(method7, body_style))

story.append(PageBreak())

# ============================================================================
# PAGE 4: INTEGRATION WITH 9-STREAM SYSTEM
# ============================================================================

section_data = [["Integration: The 9-Stream Bayesian Convergence"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

nine_streams = """
The lantern-os incubator has 9 parallel streams competing for capital and founder attention. Without structured counter-bias methods, capital flows to the stream the founder <b>believes in</b>, not the stream with the strongest <b>evidence</b>.
<br/><br/>
With the seven methods:
"""
story.append(Paragraph(nine_streams, body_style))

story.append(Spacer(1, 0.08*inch))

# Create integration table
integration_data = [
    ['Method', 'Applied to 9 Streams', 'Outcome'],
    [
        'Prior Articulation',
        'Founder states expected outcome for each stream (papers, uptime, user sessions, etc.)',
        'Biases toward streams become explicit'
    ],
    [
        'Independent Estimates',
        'Each stream lead predicts success without founder present',
        'Large divergences = red flag for founder bias'
    ],
    [
        'ACH',
        'Compare hypotheses: "cure-gen will dominate" vs. "sales-growth will dominate" vs. "balanced growth"',
        'Evidence for each hypothesis is examined'
    ],
    [
        'Delphi Rounds',
        'Stream leads estimate probabilities anonymously; reveal; iterate',
        'Genuine expert consensus emerges, not authority consensus'
    ],
    [
        'Dissent Logs',
        'Record which stream leads disagree with founder capital allocation',
        'Disagreement becomes organizationally safe'
    ],
    [
        'Calibration',
        'Track founder predictions vs. actual outcomes over 8 weeks per stream',
        'Overconfidence in certain streams becomes measurable'
    ],
    [
        'Proof Gates',
        'Each stream allocation decision includes reversal condition (e.g., "Reallocate in week 4 if metrics miss threshold")',
        'Bad bets are reversible; founder risk tolerance increases'
    ],
]

integration_table = Table(integration_data, colWidths=[1.3*inch, 2.3*inch, 2.4*inch])
integration_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), COMET_BLUE),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 9),
    ('FONTSIZE', (0, 1), (-1, -1), 8.5),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
    ('BACKGROUND', (0, 1), (-1, -1), colors.white),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, GRAY_LIGHT]),
    ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),
    ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
]))
story.append(integration_table)

story.append(Spacer(1, 0.12*inch))

result = """
<b>Result:</b> Capital flows to streams with the strongest evidence, not founder preference. The founder becomes the <b>accountable Bayesian integrator</b>—still making decisions, but through a structure that makes bias visible and correctable.
"""
story.append(Paragraph(result, body_style))

story.append(PageBreak())

# ============================================================================
# PAGE 5: WEEKLY IMPLEMENTATION
# ============================================================================

section_data = [["Weekly Implementation: The Founder Calibration Cycle"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

weekly_intro = """
The founder calibration cycle integrates counter-bias methods into the weekly decision rhythm:
"""
story.append(Paragraph(weekly_intro, body_style))

story.append(Spacer(1, 0.08*inch))

# Weekly cycle table
weekly_data = [
    ['Day', 'Method', 'Activity', 'Output'],
    [
        'Monday',
        'Prior Articulation',
        'Founder writes down all assumptions about each of 9 streams (confidence 0-100%, impact 1-5)',
        'Assumption Registry'
    ],
    [
        'Tuesday',
        'Independent Estimates',
        'Each stream lead estimates success probability without founder present. Compare to founder prior.',
        'Divergence Report'
    ],
    [
        'Wednesday',
        'ACH + Delphi',
        'Compete hypotheses for top 3 decisions. Stream leads give anonymous estimates; reveal; iterate.',
        'Structured Consensus'
    ],
    [
        'Thursday',
        'Execution & Evidence',
        'Run weekly experiments on top-risk assumptions. Collect evidence.',
        'Evidence Log'
    ],
    [
        'Friday',
        'Calibration + Proof Gates',
        'Track founder predictions vs. actual outcomes. Update confidence (70/20/10 allocation). Set reversal conditions.',
        'Calibration Score + Capital Reallocation'
    ],
]

weekly_table = Table(weekly_data, colWidths=[0.75*inch, 1.1*inch, 2*inch, 2.15*inch])
weekly_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), COMET_BLUE),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 9),
    ('FONTSIZE', (0, 1), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
    ('BACKGROUND', (0, 1), (-1, -1), colors.white),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, GRAY_LIGHT]),
    ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),
    ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 4),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
]))
story.append(weekly_table)

story.append(Spacer(1, 0.12*inch))

eight_week = """
<b>Eight-Week Calibration Cycle:</b> Over 8 weeks, all seven counter-bias methods are applied in parallel. At week 8, the founder's calibration score is measured: do the founder's 70% predictions succeed 70% of the time? Overconfidence becomes measurable.
"""
story.append(Paragraph(eight_week, body_style))

story.append(PageBreak())

# ============================================================================
# PAGE 6: WHY THIS WORKS
# ============================================================================

section_data = [["Why Structured Counter-Bias Succeeds Where Founder Virtue Fails"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

story.append(Paragraph("1. Process > Virtue", heading2_style))
reason1 = """
Virtue (founder's integrity, intelligence, experience) is unreliable. It cannot overcome cognitive biases because biases are <b>rational</b> under uncertainty. Process (prior articulation, independent estimates, ACH) is reliable because it is <b>mechanical</b>.
"""
story.append(Paragraph(reason1, body_style))

story.append(Spacer(1, 0.07*inch))

story.append(Paragraph("2. Accountability > Authority", heading2_style))
reason2 = """
The founder has accountability (personal liability) and authority (power to decide). Structured methods redirect this accountability toward <b>calibration</b>, not conviction. The founder remains authoritative; the bias becomes visible.
"""
story.append(Paragraph(reason2, body_style))

story.append(Spacer(1, 0.07*inch))

story.append(Paragraph("3. Reversibility > Permanence", heading2_style))
reason3 = """
Proof gates make decisions reversible. When reversibility is clear, founders feel less psychological pressure to defend failed bets. This eliminates sunk-cost bias and allows rapid capital reallocation.
"""
story.append(Paragraph(reason3, body_style))

story.append(Spacer(1, 0.07*inch))

story.append(Paragraph("4. Evidence > Conviction", heading2_style))
reason4 = """
Bayesian methods weight evidence by likelihood ratio, not by how strongly the founder believes. A founder's conviction is zero evidence. A founder's calibration score is evidence.
"""
story.append(Paragraph(reason4, body_style))

story.append(Spacer(1, 0.07*inch))

story.append(Paragraph("5. Diversity > Consensus", heading2_style))
reason5 = """
Independent estimates, dissent logs, and Delphi rounds preserve disagreement. Research shows diverse priors updated independently converge to truth faster than large groups pressured toward early consensus.
"""
story.append(Paragraph(reason5, body_style))

story.append(Spacer(1, 0.1*inch))

founder_now = """
<b>The Founder is Now Indispensable—But Differently:</b>
<br/><br/>
The founder is not indispensable because of superior judgment. The founder is indispensable because:
<br/>• Only the founder integrates all 9 streams
<br/>• Only the founder has authority to reallocate capital
<br/>• Only the founder's accountability creates organizational incentive alignment
<br/>• Only structured methods + founder accountability = unbiased wisdom
"""
story.append(Paragraph(founder_now, body_style))

story.append(PageBreak())

# ============================================================================
# PAGE 7: RESEARCH FOUNDATIONS AND CONCLUSION
# ============================================================================

section_data = [["Research Foundations and Future Work"]]
section_table = Table(section_data, colWidths=[7*inch])
section_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_DARK),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('LEFTPADDING', (0, 0), (-1, -1), 12),
    ('RIGHTPADDING', (0, 0), (-1, -1), 12),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
]))
story.append(section_table)

story.append(Spacer(1, 0.12*inch))

story.append(Paragraph("Bayesian Epistemology", heading2_style))
bayesian_research = """
Beliefs are degrees of probability updated by evidence via Bayes' theorem. This framework applies to founder decision-making: confidence scores are subjective probabilities that should converge to objective frequencies through repeated evidence integration.
<br/><br/>
<b>Key Citation:</b> Schum, D.A. (1994). "Evidential Foundations of Probabilistic Reasoning." Northwestern University Press.
"""
story.append(Paragraph(bayesian_research, body_style))

story.append(Spacer(1, 0.08*inch))

story.append(Paragraph("Collective Intelligence Under Social Influence", heading2_style))
collective_research = """
Large groups underperform small independent groups when social influence is present. Founders amplify social influence through authority. Independent estimates, anonymous Delphi rounds, and dissent logs restore group wisdom by reducing founder-driven conformity.
<br/><br/>
<b>Key Finding:</b> Groups that preserve disagreement longer reach more accurate consensus faster than groups that converge quickly.
"""
story.append(Paragraph(collective_research, body_style))

story.append(Spacer(1, 0.08*inch))

story.append(Paragraph("Analysis of Competing Hypotheses (ACH)", heading2_style))
ach_research = """
Rather than testing whether a preferred hypothesis is true (confirmation bias), ACH tests whether competing hypotheses are <b>false</b>. This inverts the default cognitive operation and forces consideration of disconfirming evidence.
<br/><br/>
<b>Originator:</b> Heuer, R.J. Jr. (1999). "Psychology of Intelligence Analysis." Central Intelligence Agency. Still the gold standard for structured judgment under uncertainty.
"""
story.append(Paragraph(ach_research, body_style))

story.append(Spacer(1, 0.08*inch))

story.append(Paragraph("Founder Research", heading2_style))
founder_research = """
Research on founder decision-making shows:
<br/>• Founder traits matter (risk tolerance, pattern recognition, persistence) but there is no single ideal type
<br/>• Team diversity matters more than founder traits
<br/>• Founder bias is worse when accountability is low (e.g., well-funded early stage)
<br/>• Structured processes reduce bias impact more than founder selection does
<br/><br/>
<b>Implication:</b> We cannot hire bias away. We must structure it away.
"""
story.append(Paragraph(founder_research, body_style))

story.append(Spacer(1, 0.15*inch))

story.append(Paragraph("Conclusion: The Accountable Bayesian Integrator", heading2_style))

conclusion = """
The founder's paradox is resolved not by removing the founder or trusting founder virtue, but by making the founder into a <b>structured Bayesian integrator</b>:
<br/><br/>
• Name priors explicitly (can't unconsciously shift them)
<br/>• Protect dissent and independent estimates (preserve diversity)
<br/>• Test competing hypotheses (force disconfirming evidence consideration)
<br/>• Track calibration (overconfidence becomes measurable)
<br/>• Make decisions reversible (eliminate sunk-cost pressure)
<br/>• Update capital allocation via Bayesian reweighting (70/20/10)
<br/><br/>
This transforms the founder from a single point of failure (unchecked bias) into a single point of strength (calibrated consensus integrator for the entire 9-stream system).
<br/><br/>
<b>The founder is not wise because the founder is virtuous. The founder is wise because the founder is accountable.</b>
"""
story.append(Paragraph(conclusion, body_style))

story.append(Spacer(1, 0.2*inch))

# Final statement
final_box_data = [[
    Paragraph(
        "<b>COMET LEAP COMMITMENT</b><br/><br/>"
        "All founder decisions in the 9-stream incubator use the seven counter-bias methods.<br/>"
        "Weekly calibration tracking.<br/>"
        "Capital allocation follows evidence, not conviction.<br/>"
        "Reversibility by default.<br/><br/>"
        "This is how unbiased wisdom emerges from a biased founder.",
        ParagraphStyle(
            'FinalText',
            parent=styles['Normal'],
            fontSize=10,
            textColor=colors.white,
            leading=13,
            alignment=TA_CENTER,
            fontName='Helvetica'
        )
    )
]]

final_table = Table(final_box_data, colWidths=[6.5*inch])
final_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, -1), COMET_ACCENT),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('LEFTPADDING', (0, 0), (-1, -1), 16),
    ('RIGHTPADDING', (0, 0), (-1, -1), 16),
    ('TOPPADDING', (0, 0), (-1, -1), 16),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 16),
]))
story.append(final_table)

story.append(Spacer(1, 0.2*inch))

story.append(Paragraph("May 26, 2026 | COMET LEAP Series | v2.0", date_style))

# Build PDF
doc.build(story)

print("="*80)
print("COMET LEAP: BAYESIAN FOUNDER PROTOCOL v2.0")
print("="*80)
print()
print("✓ PDF Generated: COMET-LEAP-Bayesian-Founder-Protocol-v2.pdf")
print()
print("CONTENTS:")
print("  Page 1: Cover + Central Thesis + Research Anchors")
print("  Page 2: The Founder Paradox and Counter-Bias Resolution")
print("  Page 3: Seven Counter-Bias Methods Detailed")
print("  Page 4: 9-Stream Integration Framework")
print("  Page 5: Weekly Implementation Cycle")
print("  Page 6: Why Structure Succeeds Where Virtue Fails")
print("  Page 7: Research Foundations + COMET LEAP Commitment")
print()
print("KEY INSIGHT:")
print("  The founder is not automatically unbiased.")
print("  The founder is needed as the accountable Bayesian integrator")
print("  who names priors, protects dissent, updates on evidence, and")
print("  converts consensus into reversible action.")
print()
print("  Unbiased wisdom = Founder Accountability + Structured Methods")
print()
print("METHODS INCLUDED:")
print("  1. Prior Articulation")
print("  2. Independent Estimates")
print("  3. Analysis of Competing Hypotheses (ACH)")
print("  4. Delphi Rounds")
print("  5. Dissent Logs")
print("  6. Calibration Tracking")
print("  7. Proof Gates (Reversibility)")
print()
print("="*80)
