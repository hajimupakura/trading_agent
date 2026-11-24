# Robustness checks on the tree result (session-local pickles, self-generated).
# (1) per-month capture, (2) winsorized totals (cap each position at +300%),
# (3) win-rate / median view — is the edge broad or 3 lottery tickets?
import pickle, numpy as np
from collections import defaultdict
from train_tree import positions, build, v0_exit_mult, ml_exit_mult, model, best_th

test = [p for p in positions if p["day"] >= "2026-06-01"]
Xte, yte, ote = build(test)
probs = model.predict_proba(Xte)[:, 1]
byk = defaultdict(list)
for (k, i), pr in zip(ote, probs): byk[k].append((i, pr))

rows = []
for k, pos in enumerate(test):
    peak = float(pos["bids"].max()) / pos["entry"] - 1
    v0 = v0_exit_mult(pos) - 1
    ml = ml_exit_mult(pos, sorted(byk[k]), best_th) - 1
    rows.append((pos["day"][:7], peak, v0, ml))

print("month      n   peak%    V0%   ML%   V0cap  MLcap")
for month in sorted({r[0] for r in rows}):
    sub = [r for r in rows if r[0] == month]
    pk = sum(r[1] for r in sub); v = sum(r[2] for r in sub); m = sum(r[3] for r in sub)
    print(f"{month} {len(sub):4d} {100*pk:+8.0f} {100*v:+7.0f} {100*m:+7.0f}  {100*v/pk:5.1f}%  {100*m/pk:5.1f}%")

CAP = 3.0  # winsorize each position's contribution at +300%
wp = sum(min(r[1], CAP) for r in rows); wv = sum(min(r[2], CAP) for r in rows); wm = sum(min(r[3], CAP) for r in rows)
print(f"\nwinsorized@+300%: peak {100*wp:+.0f}% | V0 {100*wv:+.0f}% ({100*wv/wp:.1f}%) | ML {100*wm:+.0f}% ({100*wm/wp:.1f}%)")
v0w = sum(1 for r in rows if r[3] > r[2]); tie = sum(1 for r in rows if abs(r[3]-r[2]) < 1e-9)
print(f"ML beats V0 on {v0w}/{len(rows)} positions ({tie} ties) | median V0 {100*np.median([r[2] for r in rows]):+.0f}% | median ML {100*np.median([r[3] for r in rows]):+.0f}%")
neg = [r for r in rows if r[1] < 0.10]
print(f"dud fires (peak<+10%): {len(neg)} | V0 avg {100*np.mean([r[2] for r in neg]):+.0f}% | ML avg {100*np.mean([r[3] for r in neg]):+.0f}%")
