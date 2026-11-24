# PER-SURGE lottery detector (9:04 cron spec): unit = (day, sym, dir) fire event.
# Label 1 if that event's penny ladder produced a >=10x INTRADAY repricing at any
# level. Features = the matching pullback-scan event's fire-time facts: legPct,
# fireMin, dir, heldVwap, volumeFading, symbol class. This is the convexity
# sleeve's trigger question: WHICH surges deserve the swarm?
# Walk-forward per the cron spec: train < 2026-06-01, judge >= 2026-06-01.
# Also: the census's 25x+ count (10x/50x already reported this morning).
import csv, glob
import numpy as np
from collections import defaultdict
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)
INDEXY = {"SPY", "QQQ", "GLD", "SPX", "SPXW"}

# ---- lottery tapes -> per (day,sym,dir): best intraday multiple + penny-swarm pnl ----
paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["sym"], int(r["dir"]), r["occ"], int(r["fireMin"]), float(r["entryPrint"]))
        paths[key].append(float(r["price"]))
best = defaultdict(float)          # (day,sym,dir) -> best peak multiple
pnl = defaultdict(float)           # (day,sym,dir) -> hold-to-end penny pnl at $500/pos
multiples = []                     # all positions' peak multiples for the 25x count
for (day, sym, dir_, occ, fire, entry), prices in paths.items():
    if entry <= 0: continue
    mult = max(prices) / entry
    multiples.append((mult, entry, day, sym))
    key = (day, sym, dir_)
    best[key] = max(best[key], mult)
    if entry <= 0.25:
        pnl[key] += (hair(prices[-1]) - entry) * 100 * (500 / (entry * 100))

n25 = sum(1 for m, *_ in multiples if m >= 25)
print(f"census add-on: positions {len(multiples)} | >=10x {sum(1 for m,*_ in multiples if m>=10)} | >=25x {n25} | >=50x {sum(1 for m,*_ in multiples if m>=50)}")

# ---- scan features per (day,sym,dir): nearest fire event ----
scan = {}
for fn in glob.glob("scanfeat/*.psv"):
    for line in open(fn):
        parts = line.strip().split("|")
        if len(parts) != 9: continue
        day, sym, dir_, leg, fire, held, fading, retr, _ = parts
        scan[(day, sym, int(dir_), int(fire))] = (float(leg), int(fire), int(held), int(fading))
scan_by = defaultdict(list)
for (day, sym, dir_, fire), v in scan.items(): scan_by[(day, sym, dir_)].append(v)

rows = []
for key, mult in best.items():
    day, sym, dir_ = key
    feats = scan_by.get(key)
    if not feats: continue
    leg, fire, held, fading = max(feats, key=lambda v: v[0])  # strongest scan event that day/side
    rows.append({"day": day, "sym": sym, "key": key, "label": 1 if mult >= 10 else 0,
                 "x": [leg, fire, dir_, held, fading, 1.0 if sym in INDEXY else 0.0]})
rows.sort(key=lambda r: r["day"])
days = np.array([r["day"] for r in rows])
y = np.array([r["label"] for r in rows])
tr = days < "2026-06-01"; te = ~tr
print(f"surge events {len(rows)} | positive {y.sum()} ({100*y.mean():.1f}%) | train {tr.sum()}(+{y[tr].sum()}) test {te.sum()}(+{y[te].sum()})")

X = np.array([r["x"] for r in rows], dtype=np.float32)
m = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, min_samples_leaf=25, random_state=7)
m.fit(X[tr], y[tr])
p = m.predict_proba(X[te])[:, 1]
print(f"AUC on unseen >= 2026-06: {roc_auc_score(y[te], p):.3f}")

test_rows = [r for r, t in zip(rows, te) if t]
all_pnl = sum(pnl.get(r["key"], 0) for r in test_rows)
print(f"\n=== swarm EV on unseen (pennies <=0.25, $500/pos, hold to end) ===")
print(f"swarm EVERY surge event: ${all_pnl:+12,.0f} ({len(test_rows)} events)")
for q in [0.5, 0.7, 0.8, 0.9]:
    th = np.quantile(m.predict_proba(X[tr])[:, 1], q)
    armed = [r for r, pr in zip(test_rows, p) if pr >= th]
    apnl = sum(pnl.get(r["key"], 0) for r in armed)
    tp = sum(r["label"] for r in armed); allpos = sum(r["label"] for r in test_rows)
    print(f"detector top {100*(1-q):>2.0f}%: ${apnl:+12,.0f} ({len(armed)} events) | {100*apnl/all_pnl if all_pnl else 0:3.0f}% of pnl on {100*len(armed)/len(test_rows):3.0f}% of events | precision {100*tp/max(len(armed),1):.0f}% recall {100*tp/max(allpos,1):.0f}%</br>".replace("</br>",""))
