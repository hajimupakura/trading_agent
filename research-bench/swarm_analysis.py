# The patient-OTM-swarm study: 22 months of real Friday-expiry strike-ladder tapes.
# Equal-dollar ($500 fractional) per position, per moneyness level, per exit policy:
#   d2close  — hold to day+2 session close (the friend's 2-3 day ride)
#   expiry   — hold to the last print
#   t3x/t5x  — sell at 3x / 5x target, else ride to the end
#   trail50  — after 2x, sell when price gives back 50% from peak
# Reports win rate, averages, totals, losing streaks, drawdowns; SMCI pre-split
# (< 2024-10-01) broken out — the window where the strategy minted its name.
import csv
import numpy as np
from collections import defaultdict

HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)

paths = defaultdict(list)
with open("swing.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["sym"], int(r["dir"]), int(r["lvl"]), r["occ"], int(r["fireMin"]), float(r["entryPrint"]))
        paths[key].append((int(r["min"]), float(r["price"])))

positions = []
for (day, sym, dir_, lvl, occ, fire, entry), tape in paths.items():
    if entry <= 0: continue
    tape.sort()
    tape = [(m, p) for m, p in tape if m >= fire]
    if len(tape) < 10: continue
    positions.append((day, sym, dir_, lvl, occ, fire, entry, tape))
positions.sort(key=lambda p: (p[0], p[1], p[4]))

def exits(entry, tape):
    out = {}
    # day+2 close: last print with min <= 2*1440 + 965
    d2 = [p for m, p in tape if m <= 2 * 1440 + 965]
    out["d2close"] = hair(d2[-1]) if d2 else hair(tape[-1][1])
    out["expiry"] = hair(tape[-1][1])
    for mult, name in [(3.0, "t3x"), (5.0, "t5x")]:
        hit = next((p for m, p in tape if hair(p) >= entry * mult), None)
        out[name] = entry * mult if hit is not None else hair(tape[-1][1])
    peak, ex = tape[0][1], None
    armed = False
    for m, p in tape:
        peak = max(peak, p)
        if peak >= entry * 2: armed = True
        if armed and p <= peak * 0.5: ex = p; break
    out["trail50"] = hair(ex if ex is not None else tape[-1][1])
    return out

POLICIES = ["d2close", "expiry", "t3x", "t5x", "trail50"]
STAKE = 500.0

def table(rows, label):
    print(f"\n=== {label} ===")
    bylvl = defaultdict(list)
    for r in rows: bylvl[r["lvl"]].append(r)
    print(f"lvl   n     " + "".join(f"{p:>10s}" for p in POLICIES) + "   (total $ at $500/position)")
    for lvl in sorted(bylvl):
        rs = bylvl[lvl]
        line = f"{lvl:+3d} {len(rs):5d}  "
        for pol in POLICIES:
            tot = sum(r[pol] for r in rs)
            line += f"{tot:+10.0f}"
        print(line)
    print("win rate (d2close / t5x): " + " | ".join(
        f"lvl{lvl:+d}: {100*np.mean([r['d2close']>0 for r in bylvl[lvl]]):.0f}%/{100*np.mean([r['t5x']>0 for r in bylvl[lvl]]):.0f}%"
        for lvl in sorted(bylvl)))

rows = []
for day, sym, dir_, lvl, occ, fire, entry, tape in positions:
    ex = exits(entry, tape)
    frac = STAKE / (entry * 100.0)
    row = {"day": day, "sym": sym, "dir": dir_, "lvl": lvl, "entry": entry}
    for pol in POLICIES: row[pol] = (ex[pol] - entry) * 100.0 * frac
    rows.append(row)

print(f"positions {len(rows)} | days {len({r['day'] for r in rows})} | syms {len({r['sym'] for r in rows})}")
table(rows, "ALL 22 MONTHS, ALL NAMES")
table([r for r in rows if r["sym"] == "SMCI" and r["day"] < "2024-10-01"], "SMCI PRE-SPLIT (2024-02..09) — the legend window")
table([r for r in rows if r["sym"] == "SMCI" and r["day"] >= "2024-10-01"], "SMCI POST-SPLIT")
table([r for r in rows if r["sym"] != "SMCI"], "ALL NAMES EXCEPT SMCI")

# ---- streaks and drawdown for the best far-OTM policy (lvl=+8, t5x) ----
for LVL in [4, 8]:
    sel = sorted([r for r in rows if r["lvl"] == LVL], key=lambda r: r["day"])
    curve, cum, worst_streak, cur_streak, peak_c, max_dd = [], 0.0, 0, 0, 0.0, 0.0
    for r in sel:
        cum += r["t5x"]; peak_c = max(peak_c, cum); max_dd = max(max_dd, peak_c - cum)
        cur_streak = cur_streak + 1 if r["t5x"] < 0 else 0
        worst_streak = max(worst_streak, cur_streak)
    print(f"\nlvl+{LVL} t5x: total ${cum:+,.0f} | worst losing streak {worst_streak} positions | max drawdown ${max_dd:,.0f} (at $500 each)")

# ---- ECHO test: day-0 close >= +50% -> enter day+1 open, exit day+2 close ----
echo = []
for day, sym, dir_, lvl, occ, fire, entry, tape in positions:
    d0 = [p for m, p in tape if m <= 965]
    d1open = next((p for m, p in tape if m >= 1440), None)
    if not d0 or d1open is None: continue
    if hair(d0[-1]) >= entry * 1.5:
        d2 = [p for m, p in tape if m <= 2 * 1440 + 965]
        exit_p = hair(d2[-1]) if d2 else hair(tape[-1][1])
        frac = STAKE / (d1open * 100.0)
        echo.append({"lvl": lvl, "pnl": (exit_p - d1open) * 100.0 * frac, "day": day, "sym": sym})
print(f"\n=== ECHO (enter day+1 open after day-0 close >= +50%) ===")
print(f"signals {len(echo)} | win rate {100*np.mean([e['pnl']>0 for e in echo]):.0f}% | avg ${np.mean([e['pnl'] for e in echo]):+,.0f} | total ${sum(e['pnl'] for e in echo):+,.0f} at $500 each")
bylvl = defaultdict(list)
for e in echo: bylvl[e["lvl"]].append(e["pnl"])
for lvl in sorted(bylvl):
    print(f"  lvl{lvl:+d}: n {len(bylvl[lvl])} | win {100*np.mean([x>0 for x in bylvl[lvl]]):.0f}% | total ${sum(bylvl[lvl]):+,.0f}")
