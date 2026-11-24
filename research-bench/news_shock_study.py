# News-shock descriptive study (2026-05+ only — Alpaca/Benzinga news history
# starts late April 2026, so these features CANNOT train the detector; this
# study answers: do overnight news shocks coincide with lottery days, and is
# there a puts-on-bad-news asymmetry? If yes, live scoring becomes a real
# input once months of history accumulate.
import csv, json
import numpy as np
from collections import defaultdict

scores = {}
for fn in ["news_scores_1.json", "news_scores_2.json"]:
    with open(fn) as f:
        for r in json.load(f):
            scores[r["day"]] = r

# census labels + penny-swarm P&L per day, split by call/put side
best = defaultdict(float)
paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["occ"], r["fireMin"], r["entryPrint"])
        paths[key].append(float(r["price"]))
HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)
pnl = defaultdict(lambda: {"C": 0.0, "P": 0.0})
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e > 0: best[day] = max(best[day], max(prices) / e)
    if e <= 0 or e > 0.25: continue
    side = "P" if "P" in occ[-9:] else "C"  # OCC: ...C00123000 / ...P00123000
    pnl[day][side] += (hair(prices[-1]) - e) * 100 * (500 / (e * 100))

days = sorted(d for d in best if d >= "2026-05-01" and d in scores)
print(f"overlap days (census ∩ scored news): {len(days)}")
lot = {d: best[d] >= 10 for d in days}

print("\n=== shock level vs lottery rate ===")
for lv in [0, 1, 2, 3]:
    sel = [d for d in days if scores[d]["shock"] == lv]
    if not sel: continue
    r = 100 * np.mean([lot[d] for d in sel])
    pc = sum(pnl[d]["C"] for d in sel); pp = sum(pnl[d]["P"] for d in sel)
    print(f"shock={lv}: {len(sel):>3} days | lottery rate {r:4.0f}% | swarm pnl calls ${pc:+9,.0f} puts ${pp:+9,.0f}")

print("\n=== direction (bad vs good news) — the puts-on-bad-news question ===")
for dr, nm in [(-1, "BAD "), (0, "mixed"), (1, "GOOD")]:
    sel = [d for d in days if scores[d]["direction"] == dr]
    if not sel: continue
    r = 100 * np.mean([lot[d] for d in sel])
    pc = sum(pnl[d]["C"] for d in sel); pp = sum(pnl[d]["P"] for d in sel)
    print(f"{nm}: {len(sel):>3} days | lottery rate {r:4.0f}% | calls ${pc:+9,.0f} | puts ${pp:+9,.0f}")

print("\n=== shock>=2 AND bad: the 'Jensen pattern' cell ===")
sel = [d for d in days if scores[d]["shock"] >= 2 and scores[d]["direction"] == -1]
base = [d for d in days if not (scores[d]["shock"] >= 2 and scores[d]["direction"] == -1)]
for nm, s in [("shock-bad", sel), ("all other", base)]:
    if not s: continue
    r = 100 * np.mean([lot[d] for d in s])
    pc = sum(pnl[d]["C"] for d in s); pp = sum(pnl[d]["P"] for d in s)
    print(f"{nm}: {len(s):>3} days | lottery rate {r:4.0f}% | calls ${pc:+9,.0f} | puts ${pp:+9,.0f}")

print("\n=== security/regulatory angle days ===")
sel = [d for d in days if scores[d].get("secreg")]
if sel:
    r = 100 * np.mean([lot[d] for d in sel])
    pc = sum(pnl[d]["C"] for d in sel); pp = sum(pnl[d]["P"] for d in sel)
    print(f"secreg: {len(sel):>3} days | lottery rate {r:4.0f}% | calls ${pc:+9,.0f} | puts ${pp:+9,.0f}")
    for d in sel:
        tag = "LOTTERY" if lot[d] else ""
        print(f"  {d} shock={scores[d]['shock']} dir={scores[d]['direction']:+d} {scores[d]['note']} {tag}")

print("\n=== every lottery day in the window, with its news score ===")
for d in days:
    if lot[d]:
        s = scores[d]
        print(f"{d}: shock={s['shock']} dir={s['direction']:+d} sys={s['systemic']} name={s.get('name')} | {s['note']} | best {best[d]:.0f}x")
