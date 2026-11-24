# Velocity architecture document — all components and how they work, with diagram.
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak

OUT = "/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-architecture-2026-11-24.pdf"
styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], spaceBefore=16, spaceAfter=7)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], spaceBefore=12, spaceAfter=5)
B = ParagraphStyle("B", parent=styles["Normal"], fontSize=10.5, leading=15, spaceAfter=8)
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

p("Velocity — System Architecture", styles["Title"])
p("All components and how they work together · November 24, 2026", styles["Italic"])
S.append(Spacer(1, 10))

p("The system in one paragraph", H1)
p("Velocity is an autonomous paper-trading desk built as a monorepo with two deployed services and one "
  "database. A Next.js app on Vercel runs the brain on a once-a-minute cron: it reads market data, "
  "generates deterministic entry signals, and operates three isolated paper sleeves plus the whole news "
  "and research apparatus. A Node worker on Railway is the hands on the other side: it watches every open "
  "position against live quotes and executes exits under six different rule modes — now including a "
  "machine-learned hybrid. Supabase (Postgres) is the single source of truth every component reads and "
  "writes. Real money is deliberately out of the loop: every live fire becomes a one-tap Telegram card, "
  "and the human tap is the only real-money executor. Deploys happen one way only: git push to main, "
  "which rebuilds both services.")

S.append(Image("/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-architecture.png", width=7.1*inch, height=5.07*inch))
S.append(Spacer(1, 8))
S.append(PageBreak())

p("Data layer", H1)
p("<b>Alpaca</b> is the sole market-data vendor (the prior vendor was retired): stock and option chains, "
  "minute bars, live option quotes, Benzinga news headlines, and the paper brokerage itself (orders, "
  "positions, and the account equity curve that serves as ground-truth P&L). <b>CME ES futures</b> are "
  "sampled overnight so the system knows what SPX will likely do at the open. <b>OpenRouter</b> provides "
  "the LLM used for language work only — news triage and morning tape scoring — never for sizing or "
  "signals. The <b>market_events</b> table holds the verified macro calendar (every CPI, jobs, and Fed "
  "decision date 2024-2026, including the 2025 shutdown gaps, plus all mega-cap earnings dates).")

p("Signal engine (the brain's sensory cortex)", H1)
p("Every minute, the command center refreshes a snapshot per watched symbol (SPX, SPY, QQQ, NVDA, TSLA, "
  "META, MU, SMCI and the rest of the watchlist): price, minute bars, VWAP, opening range, technicals, "
  "and the option chain. A deterministic rule engine turns that into at most one signal — enter_call, "
  "enter_put, or nothing — with a setup name, confidence, reasons, and a chosen contract. Every fire is "
  "journaled to option_signals with its news context and (new today) its 30-minute leg size. Signals are "
  "pure information; what acts on them is the sleeves.")

p("The three paper sleeves", H1)
tbl([
    ["", "EQUITY", "INDEX (SPX PAIR)", "CONVEXITY (new 11/24)"],
    ["Budget", "$500/trade, 7/day", "$1,800 + $200 kicker, 3/day", "$3,000/swarm, 1/day (2 on armed days), 2 concurrent"],
    ["What it buys", "Watchlist 0-2 DTE near-money", "SPX quality contract + far-OTM kicker", "Friday 3-7 DTE, strike nearest +8% OTM, many cheap contracts"],
    ["Entry gate", "Fresh fire + VWAP health + quality screens", "Fresh SPX fire + quality", "Fresh fire + 30-min leg >= 1.5%; quality screens deliberately OFF"],
    ["Exit", "ML hybrid (V0 floor)", "ML hybrid (V0 floor)", "NO stop, NO trail: day+2 close 15:45 or expiry-day 14:00"],
    ["Calibration", "Decade VWAP tell (82-89% second-leg)", "SPX focus (user), 60/40 tax logic", "22-month swarm study: best cell beat every target/trail"],
], widths=[0.9*inch, 1.7*inch, 1.9*inch, 2.6*inch], fs=7.8)
p("Sleeves are isolated: convexity orders carry a strategy tag in their risk snapshot, and each sleeve's "
  "budget counter excludes the others' positions, so a swarm never eats an equity slot.")

p("Exit worker (the hands)", H1)
p("The Railway worker polls broker positions and fresh option quotes (30-second staleness gate, three "
  "misses page critically). Each position carries one of six exit modes. <b>burst</b> is the default "
  "same-day mode and now runs the ML HYBRID: the hand-written floor (hard stop -30%, 15:10 flat, "
  "10-minute no-follow-through, underlying invalidation, $300 dollar lock) always keeps the last word, "
  "while the learned model owns profit-taking — hold while P(another +15% leg) >= 0.55, sell below. "
  "<b>scalp</b> and <b>drive</b> are tighter intraday variants; <b>trend</b> is ride mode (50% disaster "
  "floor only); <b>thesis</b> handles multi-day manual convictions; <b>convexity</b> is time-only "
  "(no stop by design — max loss is the premium). Every ML opinion is journaled once a minute to "
  "exit_advisor_stamps, and every ML sell explains itself on Telegram.")

p("News pipeline", H1)
p("Benzinga headlines are ingested every minute into market_news (ascending, paginated — a burst of news "
  "can never be silently dropped). Overnight (8 PM - 9:25 AM ET) the <b>sentry</b> prefilters headlines "
  "with a macro-shock vocabulary and sends candidates to the LLM; genuinely market-moving stories page "
  "(max 3/night) with the live ES read attached. At 9:05-9:25 the <b>morning scorer</b> grades the whole "
  "overnight tape on the study rubric (shock 0-3, direction, single-name vs systemic, security/regulatory "
  "angle) into morning_news_scores — and a security/regulatory story on a single name pages as "
  "GOVERNMENT-ON-A-NAME, the one news cell whose puts asymmetry the research validated. These rows "
  "double as training data for the next detector generation.")

p("The ML advisory-and-acting layer", H1)
p("Models are trained offline on this desk's own research corpus (research_requests raw tapes -> CSV "
  "exports -> sklearn HistGradientBoosting), then exported as JSON tree dumps with 40 sklearn-computed "
  "check probabilities. A ~25-line TypeScript predictor reproduces sklearn to 1e-6 — asserted in tests, "
  "and the detector module refuses to score at all if its JSON drifts. <b>Exit advisor</b> (tree-v1, "
  "AUC 0.638): runs in the worker, described above. <b>Lottery-day detector</b> (by11-v2, AUC 0.567): "
  "at 11:00 ET the app scores the morning's fire shape plus the event calendar; armed days (top-20% "
  "band, which carried 59% of unseen penny-swarm profit on 13% of days) page the human AND widen the "
  "convexity sleeve to two swarms. Neural nets were tried and rejected (tournament); they return at "
  "5-10x the data.")

p("Research infrastructure", H1)
p("research_requests is a Postgres-backed job queue: the cron works one pending row per tick server-side "
  "(where the data keys live), writing raw JSON tapes back onto the row — minute bars, option ladders, "
  "pullback scans, news history. Those rows are permanent (the export-bug recovery proved why) and feed "
  "CSV exports to the research bench (this Mac), where studies and models are built. The bench ships "
  "models back as JSON; it is never in the live path.")

p("Safety doctrines", H1)
p("1. <b>Human tap only for real money</b> — the promotion gate is closed; autonomy is paper-only. "
  "2. <b>Advisory-first, history-first</b> — models earn hands via walk-forward tests on unseen months; "
  "rule changes are never made on one day's evidence (standing doctrine, daily post-close review). "
  "3. <b>Fail loud</b> — every new gate ships with its own alarm; a dead feed must page, not look quiet. "
  "4. <b>Never force trades</b> — zero-fire days are correct behavior; gates never loosen because a "
  "sleeve is bored. 5. <b>Secrets</b> — only in Vercel/Railway env; the assistant never handles values. "
  "6. <b>Deploys</b> — git push origin main only; Vercel builds the app, Railway builds the worker.")

doc.build(S)
print("wrote", OUT)
