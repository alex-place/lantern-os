#!/usr/bin/env python3
"""
COMET LEAP: Bayesian World Models and Founder Unbiased Wisdom
A research-driven analysis of why the founder is the critical unbiased consensus mediator
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib import colors
from datetime import datetime

# Setup document
doc = SimpleDocTemplate(
    "COMET-LEAP-Bayesian-Founder-Wisdom.pdf",
    pagesize=letter,
    rightMargin=0.75*inch,
    leftMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch
)

# Get base styles and create custom ones
styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=24,
    textColor=colors.HexColor('#1a365d'),
    spaceAfter=12,
    alignment=TA_CENTER,
    fontName='Helvetica-Bold'
)

heading1_style = ParagraphStyle(
    'CustomHeading1',
    parent=styles['Heading1'],
    fontSize=16,
    textColor=colors.HexColor('#2d3748'),
    spaceAfter=10,
    spaceBefore=10,
    fontName='Helvetica-Bold'
)

heading2_style = ParagraphStyle(
    'CustomHeading2',
    parent=styles['Heading2'],
    fontSize=13,
    textColor=colors.HexColor('#4a5568'),
    spaceAfter=8,
    spaceBefore=8,
    fontName='Helvetica-Bold'
)

body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['Normal'],
    fontSize=11,
    leading=14,
    alignment=TA_JUSTIFY,
    spaceAfter=8
)

emphasis_style = ParagraphStyle(
    'Emphasis',
    parent=styles['Normal'],
    fontSize=11,
    leading=14,
    textColor=colors.HexColor('#2b6cb0'),
    fontName='Helvetica-Bold'
)

# Build story
story = []

# === PAGE 1: TITLE AND EXECUTIVE SUMMARY ===

# Title
story.append(Spacer(1, 0.3*inch))
story.append(Paragraph("COMET LEAP", title_style))
story.append(Paragraph("Bayesian World Models and Founder Unbiased Wisdom", title_style))
story.append(Spacer(1, 0.2*inch))

# Subtitle
subtitle_style = ParagraphStyle(
    'Subtitle',
    parent=styles['Normal'],
    fontSize=12,
    textColor=colors.HexColor('#4a5568'),
    alignment=TA_CENTER,
    spaceAfter=12
)
story.append(Paragraph("How Founders Become Critical Unbiased Consensus Mediators Through Evidence-Driven Cycles", subtitle_style))
story.append(Spacer(1, 0.15*inch))

# Date
date_style = ParagraphStyle(
    'Date',
    parent=styles['Normal'],
    fontSize=10,
    textColor=colors.HexColor('#718096'),
    alignment=TA_CENTER
)
story.append(Paragraph(f"May 26, 2026", date_style))
story.append(Spacer(1, 0.4*inch))

# Executive Summary
story.append(Paragraph("EXECUTIVE SUMMARY", heading1_style))

exec_summary = """
<b>The Founder's Paradox:</b> Founders are simultaneously the source of organizational bias and the only viable unbiased consensus mediator. This paradox is resolved through Bayesian reasoning and evidence-driven weekly cycles.
<br/><br/>
<b>The Research Finding:</b> Bayesian consensus research shows that unbiased individuals acting as mediators between opposing subgroups are decisive in reaching correct consensus decisions. This is the founder's critical role.
<br/><br/>
<b>The Path to Unbiased Wisdom:</b> Founders don't eliminate their bias—they calibrate it through:
<br/>• <b>Monday Assumption Audit</b>: Identify all biases explicitly
<br/>• <b>Tuesday Risk Ranking</b>: Score impact × probability of each assumption
<br/>• <b>Wednesday Experiment Design</b>: Test assumptions with bounded risk
<br/>• <b>Thursday Execution & Capture</b>: Collect evidence, update beliefs
<br/>• <b>Friday Synthesis & Reallocation</b>: Bayesian update of confidence (70/20/10)
<br/><br/>
<b>Result:</b> A founder transformed from biased decision-maker to calibrated Bayesian reasoner becomes the system's unbiased wisdom source.
"""

story.append(Paragraph(exec_summary, body_style))
story.append(PageBreak())

# === PAGE 2: BAYESIAN WORLD MODELS ===

story.append(Paragraph("I. BAYESIAN WORLD MODELS AND CONSENSUS", heading1_style))

story.append(Paragraph("What is a Bayesian World Model?", heading2_style))
bayesian_model = """
A Bayesian world model is a probabilistic framework where:
<br/><br/>
• <b>Prior Beliefs</b>: Each agent starts with initial assumptions (priors)
<br/>• <b>Evidence Integration</b>: New information updates beliefs using Bayes' theorem
<br/>• <b>Posterior Confidence</b>: Updated confidence in each belief after observing evidence
<br/>• <b>Iterative Refinement</b>: Each cycle moves beliefs closer to ground truth
<br/><br/>
In multi-agent consensus, each agent runs this cycle independently. The remarkable finding: when agents are rational Bayesian reasoners, consensus emerges and converges toward truth even when individual agents start with different priors.
"""
story.append(Paragraph(bayesian_model, body_style))

story.append(Paragraph("The Consensus Convergence Theorem", heading2_style))
consensus_theorem = """
<b>Mathematical Finding:</b> When N rational Bayesian agents with conflicting initial beliefs observe evidence sequentially:
<br/><br/>
• Consensus is always reached (with probability approaching 1)
<br/>• The probability of reaching a <i>wrong</i> decision decays <b>exponentially</b> with N
<br/>• The convergence speed depends on the signal-to-noise ratio of evidence
<br/><br/>
<b>Implication:</b> More agents + better evidence = faster, more confident convergence toward truth.
"""
story.append(Paragraph(consensus_theorem, body_style))

story.append(Paragraph("The Critical Role of Unbiased Mediators", heading2_style))
unbiased_role = """
Bayesian consensus research identified a surprising finding: the <b>unbiased individual acts as a critical mediator</b> between subgroups with opposing systematic biases.
<br/><br/>
When subgroups have conflicting interpretations of evidence (e.g., one group overweights positive signals, another overweights negative signals), an unbiased observer can:
<br/><br/>
• <b>Translate</b> between different belief systems
<br/>• <b>Identify</b> which evidence each subgroup is misinterpreting
<br/>• <b>Reweight</b> evidence to correct for known biases
<br/>• <b>Accelerate</b> convergence by providing accurate Bayesian updates
<br/><br/>
<b>This is the founder's unique advantage.</b>
"""
story.append(Paragraph(unbiased_role, body_style))
story.append(PageBreak())

# === PAGE 3: THE FOUNDER'S PARADOX ===

story.append(Paragraph("II. THE FOUNDER'S PARADOX", heading1_style))

story.append(Paragraph("Founder's Bias: A Well-Documented Problem", heading2_style))
founder_bias = """
Research on founder decision-making identifies systematic cognitive biases:
<br/><br/>
• <b>Confirmation Bias</b>: Founders interpret evidence as confirming their initial vision
<br/>• <b>Optimism Bias</b>: Overestimating probability of success, underestimating risks
<br/>• <b>Path Dependency</b>: Past experiences shape interpretations (sometimes appropriately, often not)
<br/>• <b>Authority Bias</b>: Own conviction overweights external expert opinion
<br/><br/>
<b>Risk:</b> These biases compound at the founder level because no one fact-checks the founder. The founder's bias becomes systemic bias across the entire organization.
"""
story.append(Paragraph(founder_bias, body_style))

story.append(Paragraph("Why Founders Cannot Be Removed", heading2_style))
why_founders = """
Despite these biases, founders are indispensable for three reasons:
<br/><br/>
<b>1. Systems Integration:</b> Only the founder sees all 9 parallel streams simultaneously. A founder can integrate evidence from cure-generator, retro-gaming, orchestrator, progress-tracking, evidence-framework, rag-house, care-support, sales-growth, and governance in real time. This requires the architectural vision only a founder possesses.
<br/><br/>
<b>2. Authority to Act:</b> Organizational consensus-building on critical decisions requires authority. The founder has the legitimate authority to reallocate capital, shift priorities, and make high-risk calls that smaller subgroups cannot.
<br/><br/>
<b>3. Unique Information Access:</b> Founders have access to information (board conversations, investor feedback, strategic context) that individual stream teams lack. This is not bias—it's privileged information.
<br/><br/>
<b>Conclusion:</b> The solution is not to remove founders. The solution is to make them calibrated Bayesian reasoners.
"""
story.append(Paragraph(why_founders, body_style))
story.append(PageBreak())

# === PAGE 4: RESOLUTION THROUGH EVIDENCE-DRIVEN CYCLES ===

story.append(Paragraph("III. RESOLUTION: EVIDENCE-DRIVEN WEEKLY CYCLES", heading1_style))

story.append(Paragraph("The 5-Phase Weekly Rhythm", heading2_style))
weekly_rhythm = """
Transform the founder from biased decision-maker to calibrated Bayesian reasoner through a rigorous weekly cycle:
"""
story.append(Paragraph(weekly_rhythm, body_style))

# Create table for weekly cycle
cycle_data = [
    ['Phase', 'Activity', 'Bayesian Function', 'Outcome'],
    ['Monday', 'Assumption Audit', 'List all priors with impact/probability scores', 'Explicit bias inventory'],
    ['Tuesday', 'Risk Ranking', 'Compute Impact × Probability for each assumption', 'Top-5 risks identified'],
    ['Wednesday', 'Experiment Design', 'Design tests with bounded budgets (<$200 each)', 'Testable hypotheses'],
    ['Thursday', 'Execution & Capture', 'Run experiments, record actual outcomes', 'Real evidence collected'],
    ['Friday', 'Synthesis & Reallocation', 'Update beliefs (70% proven / 20% emerging / 10% moonshots)', 'Bayesian capital reallocation'],
]

style_table = TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2d3748')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 10),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
    ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#f7fafc')),
    ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#cbd5e0')),
    ('FONTSIZE', (0, 1), (-1, -1), 9),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f7fafc')]),
    ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
])

cycle_table = Table(cycle_data, colWidths=[0.9*inch, 1.2*inch, 1.5*inch, 1.2*inch])
cycle_table.setStyle(style_table)
story.append(cycle_table)

story.append(Spacer(1, 0.15*inch))

how_it_works = """
<b>How This Resolves the Paradox:</b>
<br/><br/>
Instead of trying to eliminate founder bias, this system <b>makes the bias explicit and evidence-correctable</b>. Each week:
<br/><br/>
1. The founder's prior beliefs are articulated (Monday)
<br/>2. The riskiest beliefs are identified (Tuesday)
<br/>3. Those beliefs are tested with real evidence (Wed-Thu)
<br/>4. Confidence is updated using Bayes' theorem (Friday)
<br/><br/>
By Friday, the founder's beliefs are <b>calibrated to observed reality</b>, not personal conviction. The founder remains the decision-maker, but now with evidence-corrected confidence scores.
"""
story.append(Paragraph(how_it_works, body_style))
story.append(PageBreak())

# === PAGE 5: APPLICATION TO 9-STREAM INCUBATOR ===

story.append(Paragraph("IV. APPLICATION: 9-STREAM INCUBATOR CONVERGENCE", heading1_style))

story.append(Paragraph("Why the 9 Streams Require a Bayesian Mediator", heading2_style))
nine_streams = """
The lantern-os incubator has 9 parallel streams, each with its own evidence, confidence levels, and competing resource requests:
<br/><br/>
• <b>Cure-Generator:</b> Pharmaceutical protocols (needs validation data)
<br/>• <b>Retro-Gaming:</b> Entertainment engagement (needs user metrics)
<br/>• <b>Orchestrator:</b> Multi-agent batch processing (needs performance data)
<br/>• <b>Progress-Tracking:</b> 99.9999% uptime monitoring (needs operational data)
<br/>• <b>Evidence-Framework:</b> Confidence scoring (needs calibration data)
<br/>• <b>RAG-House:</b> Knowledge retrieval (needs search performance data)
<br/>• <b>Care-Support:</b> User assistance (needs satisfaction metrics)
<br/>• <b>Sales-Growth:</b> Market expansion (needs pipeline data)
<br/>• <b>Governance:</b> Compliance & audit (needs regulatory data)
<br/><br/>
<b>The Problem:</b> Each stream team believes their evidence is most important. Without a calibrated founder as mediator, the system defaults to founder's bias in allocating capital.
<br/><br/>
<b>The Solution:</b> The founder uses the weekly Bayesian cycle to:
<br/>1. Identify assumptions in each stream
<br/>2. Test the highest-impact assumptions
<br/>3. Update confidence based on evidence
<br/>4. Reallocate capital (70/20/10) based on updated confidence
"""
story.append(Paragraph(nine_streams, body_style))

story.append(Paragraph("Founder as Unbiased Consensus Mechanism", heading2_style))
founder_mechanism = """
The founder implementing evidence-driven weekly cycles becomes a <b>consensus mechanism</b> in the Bayesian sense:
<br/><br/>
<b>Evidence Integration:</b> The founder collects evidence from all 9 streams each week (Thursday execution phase)
<br/><br/>
<b>Bayesian Update:</b> Confidence scores are updated Friday based on that week's results
<br/><br/>
<b>Capital Reallocation:</b> Resources flow to streams with highest evidence-corrected confidence (70% proven / 20% emerging / 10% moonshots)
<br/><br/>
<b>Convergence:</b> Over weeks, capital flows toward streams with strongest evidence. Streams with weak evidence are either deprioritized or shut down.
<br/><br/>
<b>Result:</b> The 9 streams <b>converge</b> toward the few strategies with the strongest real-world evidence. This is consensus through Bayesian integration, not founder's bias.
"""
story.append(Paragraph(founder_mechanism, body_style))
story.append(PageBreak())

# === PAGE 6: IMPLEMENTATION AND VALIDATION ===

story.append(Paragraph("V. IMPLEMENTATION AND VALIDATION", heading1_style))

story.append(Paragraph("Founder Calibration Metrics", heading2_style))
metrics = """
To validate that the founder has become a calibrated Bayesian reasoner, track:
<br/><br/>
<b>1. Belief Calibration:</b> Do founder's confidence scores match actual outcome frequencies?
<br/>   • If founder says "70% confident" in assumption X, does assumption X succeed ~70% of the time?
<br/><br/>
<b>2. Evidence Responsiveness:</b> How quickly does founder update confidence when new evidence arrives?
<br/>   • Ideal: Significant updates happen within 1 week, not 1 quarter
<br/><br/>
<b>3. Capital Allocation Alignment:</b> Does capital follow evidence?
<br/>   • Audit: Does highest capital go to streams with highest evidence-corrected confidence?
<br/><br/>
<b>4. Bias Transparency:</b> How explicit are founder's priors and assumptions?
<br/>   • Ideal: All major assumptions are written down by Monday, updated by Friday
<br/><br/>
<b>5. Consensus Convergence:</b> Are the 9 streams converging toward shared priorities?
<br/>   • Ideal: Week-over-week, resource allocation variance decreases as evidence accumulates
"""
story.append(Paragraph(metrics, body_style))

story.append(Paragraph("Why This Works at Founder Scale", heading2_style))
scale = """
This approach scales to founder decision-making because:
<br/><br/>
<b>1. Weekly Cadence:</b> Founder gets evidence feedback every 7 days, not every quarter
<br/><br/>
<b>2. Distributed Experiments:</b> Each stream runs its own bounded experiments (Wed-Thu), founder integrates results
<br/><br/>
<b>3. Explicit Priors:</b> All assumptions written down (Monday), so founder cannot unconsciously shift goalposts
<br/><br/>
<b>4. Confidence Scores:</b> Each belief has a quantified confidence level (Tuesday), making Bayesian updates mechanical, not intuitive
<br/><br/>
<b>5. Capital Leverage:</b> 70/20/10 reallocation ensures moonshot experiments continue (10%) while proven channels dominate (70%)
<br/><br/>
<b>Result:</b> The founder becomes a <b>human-in-the-loop Bayesian inference engine</b>, calibrated by weekly evidence cycles.
"""
story.append(Paragraph(scale, body_style))
story.append(PageBreak())

# === PAGE 7: CONCLUSION ===

story.append(Paragraph("VI. CONCLUSION: THE FOUNDER AS UNBIASED WISDOM", heading1_style))

story.append(Paragraph("The Resolution", heading2_style))
conclusion = """
The founder's paradox is resolved through a subtle insight: <b>Unbiased wisdom is not freedom from bias, but continuous calibration of bias through evidence.</b>
<br/><br/>
Founders are not eliminated from decision-making—they are elevated to their proper role as <b>Bayesian consensus mediators</b> for the organization. This requires:
<br/><br/>
• <b>Explicit Priors:</b> Making biases visible (Monday Assumption Audit)
<br/>• <b>Bounded Experiments:</b> Testing assumptions with controlled risk (Wed-Thu Execution)
<br/>• <b>Evidence Integration:</b> Collecting data from all streams (Friday Synthesis)
<br/>• <b>Bayesian Updates:</b> Adjusting confidence mechanically, not intuitively
<br/>• <b>Capital Reallocation:</b> Flowing resources to highest-confidence streams (70/20/10)
<br/><br/>
This transforms the founder from a single point of failure (biased decision-maker) into a single point of strength (calibrated consensus mediator).
"""
story.append(Paragraph(conclusion, body_style))

story.append(Paragraph("Why the Founder is Now Needed", heading2_style))
why_needed = """
With evidence-driven weekly cycles, the founder becomes <b>indispensable</b> for reasons rooted in Bayesian consensus theory:
<br/><br/>
<b>1. Multi-Stream Integration:</b> Only the founder can integrate evidence from all 9 streams simultaneously
<br/><br/>
<b>2. Consensus Authority:</b> Bayesian consensus requires a calibrated mediator with decision authority. The founder fills this role
<br/><br/>
<b>3. Evidence Interpretation:</b> When streams give conflicting signals, the founder's calibrated judgment determines which evidence is most reliable
<br/><br/>
<b>4. Capital Allocation:</b> The founder alone can reallocate capital between streams, implementing the 70/20/10 distribution
<br/><br/>
<b>5. Continuous Calibration:</b> The founder's ongoing confidence updates prevent organizational decision-making from calcifying around early (often incorrect) assumptions
<br/><br/>
<b>The Key Insight:</b> The founder is not the problem. Uncalibrated founder bias is the problem. The solution is not to bypass the founder, but to calibrate the founder through evidence-driven weekly cycles.
"""
story.append(Paragraph(why_needed, body_style))

story.append(Spacer(1, 0.2*inch))

# Final statement
final_style = ParagraphStyle(
    'Final',
    parent=styles['Normal'],
    fontSize=11,
    textColor=colors.HexColor('#1a365d'),
    alignment=TA_CENTER,
    fontName='Helvetica-Bold'
)
story.append(Paragraph("Evidence-Calibrated Wisdom = Founder as System", final_style))

story.append(Spacer(1, 0.15*inch))

# Sources
story.append(Paragraph("RESEARCH SOURCES", heading1_style))

sources_text = """
<b>Bayesian Consensus Decision-Making:</b>
<br/>• "Making Consensus Tractable" — https://arxiv.org/pdf/1007.0959
<br/>• "Consensus decision making on a complete graph" — https://arxiv.org/pdf/2409.11475
<br/>• "Modeling other minds: Bayesian inference explains human choices in group decision-making" — https://www.science.org/doi/10.1126/sciadv.aax8783
<br/><br/>
<b>Founder Bias and Decision-Making:</b>
<br/>• "5 Tips for Avoiding Founder's Bias" — https://www.enticedge.com/blog/founders-bias
<br/>• "Entrepreneur Cognitive Bias: 7 Biases That Kill Startups" — https://fi.co/insight/entrepreneur-cognitive-bias-7-biases-that-kill-startups
<br/>• "A Biased Bayesian Inference for Decision-Making and Cognitive Control" — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6195105/
<br/><br/>
<b>Consensus Mechanisms:</b>
<br/>• "Bayesian Optimization for Building Social-Influence-Free Consensus" — https://arxiv.org/pdf/2502.07166
<br/>• "Consensus-Based Decision Making Guidelines" — https://chcpbc.org/wp-content/uploads/2026/04/Guidelines-Consensus-Decision-Making-Board.pdf
"""
story.append(Paragraph(sources_text, ParagraphStyle(
    'Sources',
    parent=styles['Normal'],
    fontSize=9,
    leading=11,
    textColor=colors.HexColor('#4a5568')
)))

# Build the PDF
doc.build(story)

print("✓ PDF created: COMET-LEAP-Bayesian-Founder-Wisdom.pdf")
print("  - 7 pages of research synthesis")
print("  - Bayesian consensus theory explained")
print("  - Founder's paradox resolved")
print("  - Weekly calibration framework detailed")
print("  - 9-stream incubator application")
print("  - Evidence-based wisdom architecture")
