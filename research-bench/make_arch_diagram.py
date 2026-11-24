# Velocity architecture diagram -> PNG for the architecture PDF.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

fig, ax = plt.subplots(figsize=(14, 10), dpi=150)
ax.set_xlim(0, 14); ax.set_ylim(0, 10); ax.axis("off")

C = {"src": "#dbeafe", "app": "#dcfce7", "worker": "#fef9c3", "db": "#fce7f3", "human": "#fee2e2", "ml": "#ede9fe"}

def box(x, y, w, h, title, lines, color, title_size=10, line_size=7.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.06", facecolor=color, edgecolor="#374151", linewidth=1.2))
    ax.text(x + w/2, y + h - 0.28, title, ha="center", va="center", fontsize=title_size, fontweight="bold", color="#111827")
    for i, line in enumerate(lines):
        ax.text(x + 0.15, y + h - 0.60 - i * 0.26, line, ha="left", va="center", fontsize=line_size, color="#1f2937")

def arrow(x1, y1, x2, y2, label=None, color="#374151", style="-|>", ls="-"):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle=style, mutation_scale=14, color=color, linewidth=1.4, linestyle=ls))
    if label:
        ax.text((x1 + x2) / 2, (y1 + y2) / 2 + 0.12, label, ha="center", fontsize=7, color="#4b5563", style="italic")

# ---- data sources (top) ----
box(0.3, 8.5, 4.2, 1.3, "ALPACA (paid feeds — the only market-data vendor)",
    ["Stock + option chains, minute bars, live quotes", "Benzinga news API (headlines, ~7-mo retention)", "Paper brokerage: orders, positions, equity curve"], C["src"])
box(5.0, 8.5, 2.6, 1.3, "CME / ES futures", ["Overnight ES glimpse", "(gap + ignition read, GTH)"], C["src"])
box(8.1, 8.5, 2.6, 1.3, "OpenRouter LLM", ["News triage (sentry)", "Morning tape scoring", "Language only — never sizing"], C["src"])
box(11.2, 8.5, 2.5, 1.3, "BLS / Fed / IR calendars", ["CPI · jobs · FOMC", "megacap earnings dates", "(verified 2024-2026)"], C["src"])

# ---- Vercel app (middle-left, big) ----
box(0.3, 3.4, 7.3, 4.6, "VERCEL APP — Next.js, monitor cron every minute (apps/trading)", [
    "COMMAND CENTER per symbol: snapshot -> deterministic SIGNAL ENGINE",
    "  fires enter_call / enter_put -> option_signals (+ leg_pct30, news context)",
    "THREE PAPER SLEEVES (isolated budgets):",
    "  1 EQUITY  $500/trade, 7/day, VWAP health gate (decade-validated)",
    "  2 INDEX   SPX PAIR $1,800 + $200 far-OTM kicker, 3/day",
    "  3 CONVEXITY  $3,000 far-OTM Friday swarm, 1/day, 2 concurrent, NO stop",
    "NEWS: Benzinga ingest -> market_news · overnight sentry (LLM, pages <=3/night)",
    "  morning scorer 9:05-9:25 -> morning_news_scores (gov-on-a-name pages)",
    "LOTTERY STAMP 11:00: day shape + events -> armed days page AND",
    "  widen convexity to 2 swarms/day (acts automatically on paper)",
    "Morning Card 9:25 · surge radar · shadow ledgers · research queue · alerts"], C["app"], line_size=7.2)

# ---- Railway worker ----
box(8.1, 4.9, 5.6, 3.1, "RAILWAY WORKER — position manager loop (apps/position-worker)", [
    "Polls broker positions + fresh option quotes (30s staleness gate)",
    "EXIT ENGINE, six modes:",
    "  burst (stop/trail/time) · scalp · drive · trend (ride)",
    "  thesis · convexity (time-only: day+2 close, expiry 14:00)",
    "Dollar-profit lock · session peak reset · morning grace",
    "ML HYBRID (live on paper): tree model replaces trail/ratchet",
    "  on same-day positions; V0 floor keeps the last word;",
    "  every opinion journaled -> exit_advisor_stamps"], C["worker"], line_size=7.2)

# ---- ML bench ----
box(8.1, 3.4, 5.6, 1.2, "RESEARCH BENCH (this Mac — models trained offline)", [
    "Corpus exports -> sklearn HistGBT -> JSON + check vectors -> TS predictor (1e-6 tested)"], C["ml"], line_size=7.2)

# ---- Supabase ----
box(0.3, 1.0, 9.6, 2.0, "SUPABASE — single source of truth", [
    "option_signals · paper_trade_orders (risk_snapshot tags sleeves) · market_news · morning_news_scores",
    "market_events (163 rows) · lottery_day_stamps · exit_advisor_stamps · research_requests (raw jsonb, permanent)",
    "signal_shadow_ledger · surge_triggers · alerts · paper_position_monitors · storage bucket 'research'"], C["db"], line_size=7.2)

# ---- human ----
box(10.4, 1.0, 3.3, 2.0, "HUMAN (Telegram)", [
    "Every fire -> one-tap RH buy card",
    "HUMAN TAP = the ONLY real-money",
    "executor. Pages: overnight shocks,",
    "gov-on-a-name, lottery-armed,", "convexity swarms, exits"], C["human"], line_size=7.2)

# ---- arrows ----
arrow(2.4, 8.5, 2.4, 8.0, "chains · bars · news")
arrow(6.3, 8.5, 6.3, 8.0, "ES read")
arrow(9.4, 8.5, 7.6, 7.6, "triage/scoring")
arrow(12.45, 8.5, 12.45, 8.3); arrow(12.45, 8.3, 9.5, 3.0, "market_events")
arrow(4.0, 3.4, 4.0, 3.0, "writes/reads")
arrow(10.9, 4.9, 10.9, 4.6); arrow(10.9, 3.4, 10.9, 3.0, "stamps · journals")
arrow(7.6, 6.0, 8.1, 6.0, "paper orders adopt ->")
arrow(9.9, 3.4, 9.9, 4.9, "model JSON", color="#7c3aed", ls="--")
arrow(8.4, 3.55, 7.0, 3.55, "detector JSON", color="#7c3aed", ls="--")
arrow(9.9, 2.0, 10.4, 2.0)
ax.text(7, 9.9, "VELOCITY — three-sleeve autonomous paper desk with an advisory ML layer (2026-11-24)", ha="center", fontsize=13, fontweight="bold")
ax.text(7, 0.55, "Deploys: git push origin main -> Vercel (app) + Railway (worker). Secrets live only in Vercel/Railway. Real money: human tap only; promotion gate closed.",
        ha="center", fontsize=8, style="italic", color="#4b5563")

out = "/Users/hajimupakura/git_repos/trading_agent/research-reports/velocity-architecture.png"
plt.savefig(out, bbox_inches="tight", facecolor="white")
print("wrote", out)
