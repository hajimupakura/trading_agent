# The penny-contract census: 22 months of deep-OTM nearest-expiry tapes on
# big-surge days. Counts the 10x/25x/50x intraday repricings the user described
# (NVDA 200C 0.02->1.00 etc.), maps which days birth them, and prices the swarm:
# buy $500 of every qualifying penny at fire time, exit day+2close / expiry / peak.
import csv
import numpy as np
from collections import defaultdict

HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)

paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["sym"], int(r["dir"]), int(r["lvl"]), r["occ"], int(r["fireMin"]), float(r["entryPrint"]))
        paths[key].append((int(r["min"]), float(r["price"])))

pos = []
for (day, sym, dir_, lvl, occ, fire, entry), tape in paths.items():
    if entry <= 0: continue
    tape.sort(); tape = [(m, p) for m, p in tape if m >= fire]
    if len(tape) < 5: continue
    prices = np.array([p for _, p in tape]); mins = np.array([m for m, _ in tape])
    d0 = prices[mins <= 965]
    maxall = float(prices.max()); max0 = float(d0.max()) if len(d0) else 0.0
    d2 = prices[mins <= 2 * 1440 + 965]
    pos.append({"day": day, "sym": sym, "lvl": lvl, "occ": occ, "entry": entry,
                "mult0": max0 / entry, "mult": maxall / entry,
                "d2close": hair(float(d2[-1])) if len(d2) else hair(float(prices[-1])),
                "expiry": hair(float(prices[-1]))})

print(f"census population: {len(pos)} positions | {len({p['day'] for p in pos})} days | {len({p['sym'] for p in pos})} symbols")
ent = np.array([p["entry"] for p in pos])
print(f"entry prices: <=0.10: {(ent<=0.10).sum()} | <=0.25: {(ent<=0.25).sum()} | <=0.50: {(ent<=0.50).sum()} | median {np.median(ent):.2f}")

print("\n=== REPRICING FREQUENCY (max print / fire-time entry) ===")
for scope, key in [("same-day", "mult0"), ("full hold to expiry", "mult")]:
    m = np.array([p[key] for p in pos])
    print(f"{scope:22s}: >=5x {int((m>=5).sum()):4d} | >=10x {int((m>=10).sum()):3d} | >=25x {int((m>=25).sum()):3d} | >=50x {int((m>=50).sum()):3d}  ({100*(m>=10).mean():.1f}% of all reach 10x)")

# penny subset — the friend's actual instrument
penny = [p for p in pos if p["entry"] <= 0.25]
m = np.array([p["mult"] for p in penny])
print(f"\npennies (entry<=0.25): {len(penny)} | >=10x {int((m>=10).sum())} | >=25x {int((m>=25).sum())} | >=50x {int((m>=50).sum())}")

# which days birth 10x+
days10 = defaultdict(list)
for p in pos:
    if p["mult"] >= 10: days10[p["day"]].append(p)
print(f"\n10x+ repricings cluster on {len(days10)} distinct days (of {len({p['day'] for p in pos})}).")
top = sorted(days10.items(), key=lambda kv: -len(kv[1]))[:12]
for d, ps in top:
    syms = defaultdict(int)
    for p in ps: syms[p["sym"]] += 1
    best = max(ps, key=lambda p: p["mult"])
    print(f"  {d}: {len(ps):3d} contracts 10x+ | {dict(syms)} | biggest {best['occ']} {best['entry']:.2f}->x{best['mult']:.0f}")

# swarm EV: $500 each
print("\n=== SWARM EV ($500 per position, fractional) ===")
for name, seg in [("all", pos), ("pennies<=0.25", penny)]:
    for pol in ["d2close", "expiry"]:
        pnl = [(p[pol] - p["entry"]) * 100 * (500 / (p["entry"] * 100)) for p in seg]
        s = np.array(pnl); tot = s.sum(); top1 = np.sort(s)[-max(1, len(s)//100):].sum()
        print(f"{name:14s} {pol:8s}: total ${tot:+12,.0f} | win rate {100*(s>0).mean():.0f}% | top-1% positions carry ${top1:+,.0f} ({100*top1/tot if tot else 0:.0f}%)")

# ground truth: 2026-11-23 user examples
print("\n=== 2026-11-23 (user's example day) in census ===")
for p in sorted([p for p in pos if p["day"] == "2026-11-23"], key=lambda p: -p["mult"])[:10]:
    print(f"  {p['occ']:24s} lvl+{p['lvl']:<3d} entry {p['entry']:5.2f} same-day x{p['mult0']:5.1f} full x{p['mult']:5.1f}")
