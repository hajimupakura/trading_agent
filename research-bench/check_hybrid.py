# Hybrid policy: V0's protective floor (hard stop -30%, 10-min no-follow-through,
# 15:10 flat) always active; ML probability replaces the trail/ratchet exits.
# (session-local pickles, self-generated)
import numpy as np
from collections import defaultdict
from train_tree import positions, build, v0_exit_mult, model, best_th

def hybrid_exit_mult(pos, probs_by_i, th):
    bids, mins, entry = pos["bids"], pos["mins"], pos["entry"]
    pmap = dict(probs_by_i)
    peak = bids[0]
    for i in range(len(bids)):
        b = bids[i]; peak = max(peak, b)
        held = int(mins[i] - pos["fireMin"])
        if mins[i] >= 910: return b / entry
        if b <= entry * 0.70: return b / entry                      # V0 hard stop
        if held >= 10 and peak < entry * 1.10: return b / entry     # V0 no-follow-through
        p = pmap.get(i)
        if p is not None and p < th: return b / entry               # ML says upside gone
    return bids[-1] / entry

test = [p for p in positions if p["day"] >= "2026-06-01"]
Xte, _, ote = build(test)
probs = model.predict_proba(Xte)[:, 1]
byk = defaultdict(list)
for (k, i), pr in zip(ote, probs): byk[k].append((i, pr))

tot = {"peak": 0.0, "v0": 0.0, "hy": 0.0}
permonth = defaultdict(lambda: [0.0, 0.0, 0.0])
dud = []
for k, pos in enumerate(test):
    pk = float(pos["bids"].max()) / pos["entry"] - 1
    v0 = v0_exit_mult(pos) - 1
    hy = hybrid_exit_mult(pos, sorted(byk[k]), best_th) - 1
    tot["peak"] += pk; tot["v0"] += v0; tot["hy"] += hy
    m = permonth[pos["day"][:7]]; m[0] += pk; m[1] += v0; m[2] += hy
    if pk < 0.10: dud.append((v0, hy))

print(f"HYBRID on unseen 6 months ({len(test)} positions):")
print(f"  V0      capture {100*tot['v0']/tot['peak']:5.1f}%")
print(f"  HYBRID  capture {100*tot['hy']/tot['peak']:5.1f}%  (ML th={best_th} above a V0 floor)")
print("  month    V0cap  HYcap")
for month in sorted(permonth):
    pk, v0, hy = permonth[month]
    print(f"  {month}  {100*v0/pk:5.1f}%  {100*hy/pk:5.1f}%")
print(f"  dud fires: V0 avg {100*np.mean([d[0] for d in dud]):+.0f}% | hybrid avg {100*np.mean([d[1] for d in dud]):+.0f}% (n={len(dud)})")
