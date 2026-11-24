# Lottery-day detector: predict whether TODAY births a 10x+ penny repricing.
# Label: from the census (lottery.csv) — day's best full-hold multiple >= 10.
# Features: day_features.csv (fire counts, leg sizes, breadth, direction mix,
# timing) + day-of-week. Two variants:
#   EOD   — all of the day's fires (hindsight upper bound)
#   BY-11 — only what was known by 11:00 ET (deployable: arm the sleeve at 11)
# Walk-forward: train < 2026-01-01, test >= 2026-01-01.
import csv, datetime
import numpy as np
from collections import defaultdict
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

# labels from census
best = defaultdict(float)
paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["occ"], r["fireMin"], r["entryPrint"])
        paths[key].append(float(r["price"]))
        if not paths[key]: continue
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e > 0: best[day] = max(best[day], max(prices) / e)

feats = []
with open("day_features.csv") as f:
    for r in csv.DictReader(f):
        if r["day"] not in best: continue  # only days with census coverage
        dow = datetime.date.fromisoformat(r["day"]).weekday()
        feats.append({
            "day": r["day"], "label": 1 if best[r["day"]] >= 10 else 0,
            "eod": [float(r[k]) for k in ["n15","n2","n3","max_leg","avg_leg","n_syms","n_calls","n_puts","first_fire"]] + [dow],
            "by11": [float(r["n_by11"]), float(r["maxleg_by11"]), float(r["syms_by11"]), float(r["first_fire"]), dow],
        })
feats.sort(key=lambda x: x["day"])
days = [x["day"] for x in feats]; y = np.array([x["label"] for x in feats])
print(f"days {len(feats)} | lottery days {y.sum()} ({100*y.mean():.0f}%) | split: train {(np.array(days)<'2026-01-01').sum()} (+{y[np.array(days)<'2026-01-01'].sum()}) / test {(np.array(days)>='2026-01-01').sum()} (+{y[np.array(days)>='2026-01-01'].sum()})")

tr = np.array(days) < "2026-01-01"; te = ~tr
for name in ["eod", "by11"]:
    X = np.array([x[name] for x in feats], dtype=np.float32)
    m = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, min_samples_leaf=25, random_state=7)
    m.fit(X[tr], y[tr])
    p = m.predict_proba(X[te])[:, 1]
    auc = roc_auc_score(y[te], p)
    print(f"\n[{name.upper()}] AUC {auc:.3f} on unseen 2026")
    for th_q in [0.70, 0.80, 0.90]:
        th = np.quantile(m.predict_proba(X[tr])[:, 1], th_q)  # threshold set on train distribution
        pred = p >= th
        tp = int((pred & (y[te] == 1)).sum()); fp = int((pred & (y[te] == 0)).sum()); fn = int((~pred & (y[te] == 1)).sum())
        prec = tp / max(tp + fp, 1); rec = tp / max(tp + fn, 1)
        print(f"  arm top {100*(1-th_q):.0f}% of days: armed {int(pred.sum())}/{int(te.sum())} | precision {100*prec:.0f}% | recall {100*rec:.0f}%")
    if name == "by11": p11, m11, X11 = p, m, X

# EV: swarm pennies (<=0.25) only on armed days vs every day — unseen 2026 only
pnl_by_day = defaultdict(float)
HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e <= 0 or e > 0.25: continue
    pnl_by_day[day] += (hair(prices[-1]) - e) * 100 * (500 / (e * 100))
test_days = [d for d, t in zip(days, te) if t]
p_by_day = dict(zip(test_days, p11))
print(f"\n=== SWARM EV on unseen 2026 (pennies <=0.25, $500 each, hold to expiry) ===")
all_pnl = sum(pnl_by_day.get(d, 0) for d in test_days)
print(f"swarm EVERY day   : ${all_pnl:+12,.0f}  ({len(test_days)} days)")
for th_q in [0.70, 0.80, 0.90]:
    th = np.quantile(m11.predict_proba(X11[tr])[:, 1], th_q)
    armed = [d for d in test_days if p_by_day[d] >= th]
    pnl = sum(pnl_by_day.get(d, 0) for d in armed)
    print(f"armed top {100*(1-th_q):>2.0f}% only: ${pnl:+12,.0f}  ({len(armed)} days) -> {100*pnl/all_pnl if all_pnl else 0:.0f}% of profit on {100*len(armed)/len(test_days):.0f}% of days")
