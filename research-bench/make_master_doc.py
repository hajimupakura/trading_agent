# Velocity master analysis document — the complete 2026-11-24 research program,
# in the chat's register: verdict first, every number with its meaning, honest caveats.
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

OUT = "/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-master-analysis-2026-11-24.pdf"
styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], spaceBefore=16, spaceAfter=7)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], spaceBefore=12, spaceAfter=5)
B = ParagraphStyle("B", parent=styles["Normal"], fontSize=10.5, leading=15, spaceAfter=8)
BI = ParagraphStyle("BI", parent=B, leftIndent=14)
doc = SimpleDocTemplate(OUT, pagesize=letter, topMargin=0.7*inch, bottomMargin=0.7*inch)
S = []
def p(t, s=B): S.append(Paragraph(t, s))
def tbl(data, widths=None, fs=8.5):
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"), ("FONTSIZE", (0,0), (-1,-1), fs),
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1f2937")), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f3f4f6")]),
        ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#d1d5db")), ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("TOPPADDING", (0,0), (-1,-1), 4), ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    S.append(t); S.append(Spacer(1, 10))

p("Velocity — The Complete Research Program", styles["Title"])
p("Everything learned overnight and this morning, what shipped, and why · November 24, 2026", styles["Italic"])
S.append(Spacer(1, 10))

p("What happened, in one page", H1)
p("Over one night and one morning the system built a research corpus of roughly 2.6 million option-minute "
  "rows from its own replayed history (2,371 day-requests, zero errors), ran a tournament of exit "
  "strategies against it, validated a friend's legendary far-OTM recipe cell by cell, took a census of "
  "every penny-contract lottery ticket in 22 months, built and upgraded a lottery-day detector, studied "
  "overnight news shocks against those lottery days, and confirmed the VWAP tell on a decade of tapes. "
  "Then it shipped: a third paper sleeve (the convexity swarm), a morning news scorer, and — on your "
  "instruction that paper trading be fully automatic — both trained models now ACT on paper: the exit "
  "model owns profit-taking on same-day positions, and the lottery detector widens the swarm budget on "
  "armed days. Every model action explains itself on Telegram. Real money remains human-tap only.")

p("1 · The exit tournament: can a machine out-sell our rules?", H1)
p("The question: our hand-written exits (call them V0) captured only 19.3% of the value positions "
  "actually reached at their peaks. Can a model do better? Method: every position minute became a "
  "training row — gain, peak, drawdown, time held, time of day, premium, direction — labeled with "
  "whether the bid later rose another 15% before the close. Train on 26 months, tune on 3 held-out "
  "months, judge on 6 months the models never saw (767 positions). Bids proxied with a 1.5% haircut.")
tbl([
    ["Contender", "Capture of peak value", "Verdict"],
    ["Unmanaged peak (ceiling)", "100%", "not achievable - requires selling every top"],
    ["V0 hand-written rules", "19.3%", "the bar to beat"],
    ["Pure ML tree (no floor)", "43%", "REJECTED: rode dead fires to -66% average"],
    ["LSTM / TCN neural nets", "<= 27%", "REJECTED: need 5-10x more data"],
    ["2-of-3 voting ensemble", "<= 27%", "REJECTED: averaging diluted the tree"],
    ["HYBRID: V0 floor + tree above", "30-35%", "WINNER - duds held to -2%, shipped today"],
])
p("The deep lesson: fixed-percent trails sell wobbles. The canonical tape is your own 8/3 SPX call — a "
  "-24% option dip at 6x while the stock structure held; the trail sells there and the 96x never "
  "happens. The model, having watched thousands of wobbles resolve, holds through them — but it needs "
  "the hand-written floor beneath it because dying positions drift outside anything it trained on.")

p("2 · The swarm study: your friend's recipe, measured", H1)
p("5,325 real ladder positions over 22 months answered: what actually works for far-out-of-the-money "
  "weekly options? Buy strikes ~8% OTM on strong surges, hold about two days, sell on time — never on "
  "targets: at $500 a position that cell made +$157,300, while 5x profit targets LOST $55,000 (targets "
  "amputate the monsters that pay for everything). The price of admission: a 29% win rate, a worst "
  "streak of 23 straight losers, and the top 5 of 979 positions carrying more than 100% of the P&L. "
  "This became the CONVEXITY SLEEVE, live today: $3,000 per swarm, no stop (max loss = premium), "
  "day+2 close exit.")

p("3 · The lottery census: where the 10-baggers live", H1)
p("Every penny contract (entries <= 25 cents) the engine's events touched: 2,029 positions across 373 "
  "days. 129 reached 10x or better (6.4%), 21 reached 50x. ALL of them happened on just 63 days — and "
  "they arrive in litters: 11/19 alone birthed ten contracts that went 10x+ (the best: an NVDA put, "
  "9 cents to $12.87, 143x). Your three ground-truth contracts replayed tick-for-tick. The biggest "
  "multiples were puts on bad-news days, and the single biggest repricings happened in OVERNIGHT GAPS "
  "(your NVDA 200C opened already at 87 cents — the 43x was never buyable intraday).")

p("4 · The lottery-day detector: v1, then v2 with the event calendar", H1)
tbl([
    ["Model", "AUC unseen 2026", "Top-20% precision", "Profit capture"],
    ["v1 full-day", "0.583", "31%", "-"],
    ["v2 full-day (+ events)", "0.607", "41%", "-"],
    ["v1 by-11 AM (deployable)", "0.577", "27%", "60% of profit on 18% of days"],
    ["v2 by-11 AM (deployable)", "0.567", "36%", "59% of profit on 13% of days"],
])
p("v2 adds seven calendar flags (CPI, jobs, Fed, day-after-Fed, mega-cap earnings reactions, NVDA "
  "specifically). Honest reading: with hindsight information v2 clearly beats the bar; the deployable "
  "by-11 variant trades a hair of raw score for sharper aim — the same profit on a third fewer armed "
  "days. Standout calendar facts: CPI mornings are lottery DESERTS (4% rate vs 18% baseline, 23 days); "
  "mega-cap earnings-reaction days nearly double the odds (27% vs 15%, 48 days); the Fed's +$142k is "
  "really TWO days (+$161k) minus steady bleed on the other 21 — flags mark soil, not income. LIVE "
  "TODAY: the 11:00 stamp pages on armed days and widens the convexity budget to two swarms.")

p("5 · The news-shock study: your Jensen insight, sharpened", H1)
p("Data limit discovered: our news feed's history only reaches April 2026, so news features cannot "
  "train the detector yet — 108 recent days were scored instead (shock 0-3, direction, scope, "
  "security/regulatory angle) and laid against the lottery census. The shock gradient is real "
  "(12% -> 20% -> 28% lottery rate by shock level). But the refined finding is better than the "
  "hypothesis: it is not 'bad news pays puts' — it is THE GOVERNMENT SHOWING UP that pays puts. The 53 "
  "days carrying a security/regulatory/legal angle on a single name held the ENTIRE puts profit of the "
  "window (+$97k; every other day's puts were net losers): the SMCI raid cluster (41x), the Meta $1.4T "
  "penalty day, the DOJ-Nvidia probe day, your 11/19. And all 22 lottery days were single-name stories "
  "— the broad September sell-off produced none. LIVE TODAY: the 9:05 morning scorer pages "
  "GOVERNMENT-ON-A-NAME and accumulates labeled history for detector v3 (~3 months to trainable).")

p("6 · The decade VWAP verdict: the cleanest result of the program", H1)
tbl([
    ["Era", "Pullback HELD VWAP -> 2nd leg", "BROKE VWAP -> 2nd leg"],
    ["2016-19", "82%", "55%"], ["2020 (covid)", "89%", "60%"], ["2021", "84%", "58%"],
    ["2022 (bear)", "86%", "63%"], ["2023", "83%", "58%"], ["2024+ (AI era)", "84%", "59%"],
])
p("27,075 graded pullbacks: a pullback that holds VWAP goes on to a second leg about 5 times in 6, in "
  "EVERY regime of the past decade, with a ~25-point spread that never narrows. The equity sleeve's "
  "VWAP health gate rests on one of the most stable behavioral facts we have ever measured.")

p("7 · What is live in production tonight", H1)
tbl([
    ["Component", "Status", "What it does"],
    ["Equity sleeve", "live (pre-existing)", "$500/trade, 7/day, VWAP gate; exits now ML-hybrid"],
    ["Index SPX PAIR", "live (pre-existing)", "$1,800 + $200 kicker; exits now ML-hybrid"],
    ["Convexity sleeve", "LIVE TODAY", "$3k far-OTM swarm, no stop, day+2 close; 2/day when armed"],
    ["Exit model (hybrid)", "LIVE TODAY", "owns profit-taking on same-day paper; V0 floor beneath"],
    ["Lottery detector v2", "LIVE TODAY", "11:00 stamp; armed days page + widen swarm budget"],
    ["Morning news scorer", "LIVE TODAY", "9:05 tape score; government-on-a-name pages"],
    ["Daily deep review", "scheduled", "post-close autopsy; hypotheses tested on history only"],
    ["Real-money autonomy", "CLOSED", "human Telegram tap remains the only executor"],
])

p("Caveats, all of them", H1)
p("Research prices are trade prints, not executable bids (1.5% haircut approximates, thinly-traded "
  "pennies are worse). Strike selection in replays approximates what the live engine would pick. "
  "Detector and news samples are small (63 lottery days; 108 scored days); every event-flag P&L is "
  "dominated by its best one or two days — which is the lottery structure itself, but means averages "
  "mislead. News scores are one model's reading of headlines. The SMCI pre-split window (where the "
  "friend's strategy minted most) is under-represented pending a symbology fix. And the models' live "
  "debut is TODAY: expect the first week to teach us something the backtests could not.")

p("The operating philosophy, as it now stands", H1)
p("Rules for disasters, learning for upside, history for verdicts. Hand-written floors cap what any "
  "single position can lose; learned models decide when upside is spent; nothing changes on one day's "
  "evidence — every proposed improvement becomes a hypothesis tested on the corpus first. Patience is "
  "the edge: zero-fire days are the system working. And the human stays sovereign over real money.")

doc.build(S)
print("wrote", OUT)
