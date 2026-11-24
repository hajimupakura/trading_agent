# Velocity overnight research program — PDF report (reportlab/platypus).
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak)

OUT = "/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-research-2026-11-24.pdf"
import os; os.makedirs(os.path.dirname(OUT), exist_ok=True)

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], spaceBefore=18, spaceAfter=8, textColor=colors.HexColor("#1a1a2e"))
H2 = ParagraphStyle("H2", parent=styles["Heading2"], spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#16213e"))
BODY = ParagraphStyle("Body", parent=styles["Normal"], fontSize=10, leading=14, spaceAfter=6)
NOTE = ParagraphStyle("Note", parent=BODY, fontSize=9, textColor=colors.HexColor("#555555"))

def T(data, widths=None, align_right_from=1):
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (align_right_from, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f4f8")]),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t

story = []
story.append(Paragraph("Velocity Research Report", styles["Title"]))
story.append(Paragraph("Overnight ML &amp; Backtest Program — November 24, 2026", styles["Heading3"]))
story.append(Spacer(1, 6))
story.append(Paragraph(
    "All results below come from real Alpaca option trade prints (22 months, Feb 2024 – Nov 2026), "
    "not Black-Scholes modeling. Exits are charged a 1.5% (min 5&cent;) haircut as a bid proxy. Every model "
    "verdict is walk-forward: trained on earlier months, thresholds tuned on a middle window, judged only "
    "on months the model never saw.", BODY))

story.append(Paragraph("1. The data foundation", H1))
story.append(T([
    ["Study", "Positions", "Days", "What it is"],
    ["Exit corpus (0DTE)", "2,119", "345", "Same-day first-OTM contract per surge fire, minute tapes"],
    ["Swing ladder (3-7 DTE)", "5,325", "633", "Friday expiry at ITM -2% / near / +1% / +4% / +8% per fire"],
    ["Lottery census", "2,029", "373", "Deep-OTM (+6/10/15%) nearest-expiry pennies on 2%+ surge days"],
], widths=[1.7*inch, 0.8*inch, 0.6*inch, 3.6*inch]))
story.append(Paragraph(
    "Roughly 9,500 real option positions and 2.6 million price-path rows across 13 symbols. "
    "An export-pagination bug (rows silently dropped/duplicated when bulk inserts share timestamps) was "
    "caught by count reconciliation and fixed before training; all CSVs match the database exactly.", BODY))

story.append(Paragraph("2. Exit-advisor tournament (the capture-ratio problem)", H1))
story.append(Paragraph(
    "Question: each minute a position is open — is there meaningful upside left (will the bid print +15% "
    "higher before the close)? Scoreboard: capture ratio = realized profit / unmanaged peak profit. "
    "Judged on 767 positions from June–November 2026, fully unseen.", BODY))
story.append(T([
    ["Policy / model", "AUC", "Capture (unseen 6 mo)", "Dud fires (never moved)"],
    ["V0 shipped rules", "-", "19.3%", "-2% avg"],
    ["Tree (HistGBT), pure", "0.638", "43.0%", "-66% avg"],
    ["Tree + V0 floor (HYBRID)", "0.638", "30.0-35.3%", "-2% avg"],
    ["TCN sequence net", "0.595", "27.0%", "-"],
    ["LSTM sequence net", "0.553", "26.9%", "-"],
    ["Soft-average ensemble", "0.641", "26.7%", "-"],
    ["Hard 2-of-3 vote", "-", "26.9%", "-"],
], widths=[2.1*inch, 0.7*inch, 1.9*inch, 1.9*inch]))
story.append(Paragraph(
    "<b>Winner: the tree model over a V0 safety floor.</b> It beat V0 in every single test month "
    "(hybrid 23-47% vs V0 11-30%), on 482 of 767 individual positions (median exit +52% vs +9%), and the "
    "edge survives winsorizing every position at +300% (44.8% vs 29.2%) — it is not a lottery artifact. "
    "The model's extra capture comes from holding deep-but-healthy pullbacks that fixed trails sell; the V0 "
    "floor (-30% stop, 10-min no-follow-through, 15:10 flat) removes its one weakness, hope-holding dud fires. "
    "Sequence nets underperform at this corpus size and ensembles drag the tree down; majority vote is "
    "empirically rejected. Deployment: advisory shadow stamps first, per house governance.", BODY))

story.append(PageBreak())
story.append(Paragraph("3. The patient-OTM-swarm study (the friend's strategy)", H1))
story.append(Paragraph(
    "5,325 strike-ladder positions, $500 equal-dollar each, five exit policies. Total P&amp;L over 22 months:", BODY))
story.append(T([
    ["Strike depth", "Day+2 close", "Expiry", "3x target", "5x target", "Trail 50% after 2x"],
    ["ITM (-2%)", "+$24.9k", "+$38.0k", "+$9.1k", "+$33.5k", "+$42.4k"],
    ["Near-money", "+$87.4k", "+$77.1k", "+$75.1k", "+$71.9k", "+$117.7k"],
    ["+1% OTM", "+$31.2k", "+$53.6k", "+$8.6k", "+$37.4k", "+$73.8k"],
    ["+4% OTM", "+$84.9k", "+$78.9k", "-$1.4k", "+$20.9k", "+$77.8k"],
    ["+8% far-OTM", "+$157.3k", "+$49.4k", "-$56.8k", "-$55.4k", "+$31.7k"],
], widths=[1.3*inch, 1.1*inch, 1.0*inch, 1.0*inch, 1.0*inch, 1.4*inch]))
story.append(Paragraph(
    "<b>Findings.</b> (1) The friend's exact recipe — far OTM, hold 2-3 days, then out — is the single best "
    "cell in the table; profit targets amputate the monsters that pay for the duds, and holding to expiry "
    "gives half back. (2) His loss profile is real: 29% win rate, worst streak 23 straight losers, $35k max "
    "drawdown at $500/position. (3) Concentration: the top 5 of 979 far-OTM positions carry 112% of the "
    "total — without those five monster days the strategy loses. Never miss a monster day. "
    "(4) The steady alternative: near-money with a 50% trail (+$117.7k) is broad-based (top-5 only 36% of "
    "profit) and positive every year. (5) Echo effect confirmed: entering the day AFTER a position closed "
    "+50% still earned +$45k across 487 signals, best in far-OTM — winners continue.", BODY))
story.append(Paragraph(
    "Honest gap: the SMCI pre-split window (early 2024) yielded only ~11 usable tapes — pre-split strike "
    "symbology needs separate work; verdicts above do not depend on it. Post-split SMCI measured fine and "
    "is a monster factory (+$47k far-OTM at expiry on 320 positions).", NOTE))

story.append(Paragraph("4. The penny-lottery census", H1))
story.append(Paragraph(
    "2,029 deep-OTM nearest-expiry positions on 373 surge days; median entry 21&cent;. Ground truth: the "
    "pipeline reproduced all three user-supplied examples from Nov 23 (NVDA 200C high 0.87 close 0.18; "
    "TSLA 420C 0.11/0.75/0.19 exact; SPXW 7600C high 1.75).", BODY))
story.append(T([
    ["Repricing (vs fire-time price)", ">=5x", ">=10x", ">=25x", ">=50x"],
    ["Same day", "117", "27", "6", "1"],
    ["Full hold to expiry (<=2 days)", "288", "129 (6.4%)", "45", "21"],
], widths=[2.6*inch, 0.9*inch, 1.1*inch, 0.9*inch, 0.9*inch]))
story.append(Paragraph(
    "All 129 ten-baggers were born on just 63 of 373 days, and the best days birth them in litters "
    "(2026-11-19: ten contracts >=10x across six names; biggest NVDA 138P $0.09 -> x143). Swarming every day "
    "costs $1.01M over 22 months and returns +$254k (+25%) at a 7% win rate, with the top-1% of positions "
    "carrying ~3x the entire profit. The edge is not in the contracts — it is in knowing the day.", BODY))

story.append(Paragraph("5. Lottery-day detector v1", H1))
story.append(T([
    ["Variant", "AUC (unseen 2026)", "Best operating point", "Swarm EV effect"],
    ["End-of-day features", "0.583", "top-20%: precision 31%, recall 36%", "-"],
    ["By-11:00 features (deployable)", "0.577", "top-20%: precision 27%, recall 24%", "60% of profit on 18% of days"],
], widths=[1.9*inch, 1.2*inch, 2.4*inch, 1.6*inch]))
story.append(Paragraph(
    "Verdict: real but weak signal from day-shape features alone (fire counts, leg sizes, breadth, timing). "
    "Arming only the detector's top-20% days tripled capital efficiency ($112.6k on 30 days vs $188.2k on "
    "165) but misses 40% of profit. Ships as an advisory stamp, not a gate. v2 adds the event calendar "
    "(CPI, jobs Friday, FOMC, and NVDA/TSLA/AAPL/MSFT/META/GOOGL earnings days) — lottery days cluster in "
    "earnings weeks, so these known-in-advance features are the most promising upgrade.", BODY))

story.append(Paragraph("6. What ships, what waits", H1))
story.append(Paragraph(
    "<b>Ships (shadow/advisory):</b> tree exit advisor as hybrid over the V0 floor, stamped and scored "
    "against live fires; lottery-day detector as a card stamp; Echo continuation logic validated for the "
    "Echo Card. <b>Builds today:</b> Convexity sleeve (user-authorized): all watchlist + SPY, $3,000 max "
    "premium/position, no stop by design, 3-7 DTE, far-OTM, exit day+2 close (table-proven best) — "
    "defaults 1 new/day, max 2 concurrent pending user confirmation. <b>Waits:</b> sequence nets until the "
    "corpus is 5-10x bigger; real-money promotion stays behind the existing gate; SMCI pre-split symbology "
    "investigation.", BODY))
story.append(Spacer(1, 10))
story.append(Paragraph(
    "Method note: every rule above was tested criterion-first on data the models never saw; two prior "
    "hypotheses (gap-morning patience, mechanical re-entry) were rejected this way and are not in this "
    "report's recommendations.", NOTE))

SimpleDocTemplate(OUT, pagesize=letter, topMargin=0.7*inch, bottomMargin=0.7*inch).build(story)
print("written", OUT)
