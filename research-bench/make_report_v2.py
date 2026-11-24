# Velocity research report — detector v2 + news-shock study (2026-11-24 morning).
# Same register as the overnight report: verdict first, every number with its
# practical meaning, plain English, honest caveats.
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

OUT = "/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-research-v2-2026-11-24.pdf"
styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], spaceBefore=18, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], spaceBefore=14, spaceAfter=6)
B = ParagraphStyle("B", parent=styles["Normal"], fontSize=10.5, leading=15, spaceAfter=8)
BI = ParagraphStyle("BI", parent=B, leftIndent=14)
doc = SimpleDocTemplate(OUT, pagesize=letter, topMargin=0.8*inch, bottomMargin=0.8*inch)
S = []
def p(t, s=B): S.append(Paragraph(t, s))
def tbl(data, widths=None):
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"), ("FONTSIZE", (0,0), (-1,-1), 9),
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1f2937")), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f3f4f6")]),
        ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#d1d5db")), ("TOPPADDING", (0,0), (-1,-1), 4), ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    S.append(t); S.append(Spacer(1, 10))

p("Velocity Research — Part II", styles["Title"])
p("Lottery-Day Detector v2 and the News-Shock Study · November 24, 2026 (morning session)", styles["Italic"])
S.append(Spacer(1, 12))

p("The verdict up front", H1)
p("We rebuilt the lottery-day detector with scheduled-event awareness (CPI, jobs report, Fed decisions, "
  "and the six mega-caps' earnings days) and ran a separate study of overnight news shocks against the "
  "lottery-day census. Three findings matter:")
p("<b>1. The event calendar improves the detector.</b> With full-day information the new model scores "
  "AUC 0.607 against 0.583 for v1 on the same unseen 2026 days — and at the practical operating point "
  "(arm the top fifth of days) its precision rises from 31% to 41%. The deployable by-11-AM variant is a "
  "wash on raw score but meaningfully more efficient: it banks the same 59-60% of swarm profit while "
  "arming only 13% of days instead of 18%. Fewer armed days for the same profit means less premium "
  "burned on false alarms. Status stays ADVISORY — this stamps days, it does not pull triggers.", BI)
p("<b>2. The single most useful calendar fact is a negative one: CPI mornings are lottery deserts.</b> "
  "Across 23 CPI days in the census, only 4% birthed a 10x repricing versus 18% of ordinary days, and a "
  "blind penny swarm on them lost $33,000. Mega-cap earnings-reaction days are the opposite pole: 27% "
  "lottery rate versus 15% baseline — nearly double. FOMC days look spectacular (+$142k) but honesty "
  "requires the decomposition: two single days earned +$161k and the other 21 lost about $20k combined. "
  "Event flags mark soil where monsters occasionally grow; they are not steady income.", BI)
p("<b>3. The news study refines the Jensen thesis.</b> It is not 'bad news makes puts pay.' It is: "
  "<b>the government showing up makes puts pay.</b> Days whose overnight tape carried a security, "
  "regulatory, legal, or national-security angle on a single name produced the entire puts profit of the "
  "study window (+$97k across 53 such days; every other day's puts were net losers). Raids, probes, "
  "penalties, export controls — the SMCI smuggling raid (41x), the Meta $1.4T penalty demand (10x), the "
  "DOJ-Nvidia probe day (24x), and your 11/19 NVDA day all wear this tag.", BI)

p("What we could not do, and why", H1)
p("The plan was to feed news-shock scores into the trained detector. The data refused: our news feed's "
  "history only reaches back to late April 2026. Every one of the 480+ requests for 2024-2025 headlines "
  "returned empty. A model can only learn from the past it can see, and seven months of news that overlap "
  "the test period is not a training set — using it would be grading the model on days it peeked at. So "
  "news scoring becomes a <b>live, accumulating feature</b>: the system scores each morning's tape from "
  "today forward, and in a few months there is real history to train on. The study below is therefore "
  "descriptive — strong enough to shape what we collect, not yet to pull triggers.")

p("The news-shock study (108 days, May–November 2026)", H1)
p("Each morning's overnight headlines (prior evening 9 PM through the open) were scored on four axes: "
  "shock level 0-3, direction (good/bad/mixed), scope (single-name vs market-wide), and whether a "
  "security/regulatory angle was present. Those scores were then laid against the lottery census — which "
  "days actually birthed a 10x-plus penny repricing, and where a blind $500-per-position penny swarm "
  "would have made or lost money, split by calls and puts.")
tbl([
    ["Overnight tape", "Days", "Lottery rate", "Swarm calls P&L", "Swarm puts P&L"],
    ["Routine (shock 0)", "8", "12%", "-$4,700", "-$5,500"],
    ["Notable (shock 1)", "81", "20%", "-$42,237", "+$84,424"],
    ["Genuine shock (2)", "18", "28%", "-$5,500", "-$14,500"],
    ["Sec/reg angle days", "53", "25%", "-$17,965", "+$97,246"],
    ["All other days", "55", "~16%", "-$37,000", "net negative"],
])
p("The shock gradient is real — lottery odds climb from 12% on boring mornings to 28% on shock mornings — "
  "but it is a slope, not a cliff, because plenty of shocks break during the session where overnight "
  "scoring cannot see them (11/19 itself scored 'mixed' at dawn; the worst Nvidia news landed later). "
  "The security/regulatory flag is the standout: it concentrates the puts payoff almost perfectly. And "
  "one structural fact: all 22 lottery days in the window were single-name stories. The broad September "
  "AI sell-off days — systemic fear, everything down together — produced none. Monsters grow where one "
  "ticker's uncertainty explodes, not where the whole market bleeds.")

p("Detector v2: what changed and what it scored", H1)
p("v2 keeps v1's day-shape features (fire counts, leg sizes, breadth, timing) and adds seven "
  "calendar flags, all knowable before the open: CPI day, jobs day, Fed day, day-after-Fed, mega-cap "
  "earnings-reaction day (an after-close report maps to the next trading day), day-after-reaction, and "
  "an NVDA-specific flag. Same walk-forward discipline as v1: train on 2024-2025 only, judge on 2026 "
  "days the model never saw (165 days, 33 of them lottery days).")
tbl([
    ["Model", "AUC (unseen 2026)", "Top-20% precision", "Profit capture"],
    ["v1 full-day", "0.583", "31%", "—"],
    ["v2 full-day", "0.607", "41%", "—"],
    ["v1 by-11 AM (deployable)", "0.577", "27%", "60% of profit on 18% of days"],
    ["v2 by-11 AM (deployable)", "0.567", "36%", "59% of profit on 13% of days"],
    ["Calendar alone, no day-shape", "0.539", "28%", "weak — context, not signal"],
])
p("Plain reading: with hindsight-complete information the calendar clearly helps (0.607 beats the 0.583 "
  "bar we set). The deployable by-11 variant trades a hair of raw score for sharper aim — same profit on "
  "five fewer armed days per hundred. The calendar alone, with no view of the day's fires, is nearly "
  "coin-flip: events tell you where to look, the tape tells you whether something is happening.")

p("Event-day facts worth keeping (all 373 census days)", H2)
tbl([
    ["Calendar flag", "Days", "Lottery rate", "vs baseline", "Blind swarm P&L"],
    ["CPI day", "23", "4%", "18%", "-$33,444"],
    ["Jobs day", "21", "19%", "17%", "-$35,027"],
    ["Fed decision day", "17", "18%", "17%", "+$141,703 (two days = +$161k)"],
    ["Day after Fed", "17", "24%", "17%", "+$113,948"],
    ["Mega-cap reaction day", "48", "27%", "15%", "+$32,366"],
    ["Day after reaction", "48", "23%", "16%", "+$96,037"],
    ["NVDA reaction day", "12", "25%", "17%", "-$20,140"],
])
p("The NVDA row deserves a note: a 25% lottery rate but negative blind-swarm P&L means NVDA earnings "
  "days birth repricings often, but the pennies are priced richer going in — the market already knows "
  "it is NVDA day. The edge on known-event days is thinner than their drama suggests; the edge on "
  "<i>unscheduled</i> government-shows-up days is where the puts study points.")

p("Caveats, stated plainly", H1)
p("Small samples everywhere: 63 lottery days across 373 census days; 23 CPI days; 17 Fed days of which "
  "two carry the P&L. The news scores are one model's judgment of headlines, not ground truth. The swarm "
  "P&L uses last-print exits with a haircut, not guaranteed fills. And every event-flag P&L figure is "
  "dominated by its best one or two days — exactly as the lottery structure predicts, which is also why "
  "no single flag should ever gate an entry on its own.")

p("What happens next", H1)
p("1. The by-11 v2 stamps become the advisory arming signal (same status as v1 — context on the day "
  "card, no autonomous trigger). 2. The live morning news scorer starts tagging each day's tape — "
  "shock level, direction, single-name vs systemic, and the security/regulatory flag — building the "
  "training history the retention window denied us. 3. CPI mornings get a standing 'thin soil' note on "
  "the day card. 4. Revisit in ~3 months when the accumulated news history is big enough to train on "
  "rather than describe.")

doc.build(S)
print("wrote", OUT)
