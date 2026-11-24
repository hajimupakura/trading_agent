# Exit-advisor tournament, round 1: HistGradientBoosting vs shipped V0 rules.
# Walk-forward: train on days < 2026-06-01 (26 months of option era), threshold
# tuned on the last 3 train months, judged on >= 2026-06-01 (fully unseen ~6 months).
# Scoreboard = capture ratio: sum(exit multiple - 1) / sum(peak multiple - 1).
import pickle, numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

positions = pickle.load(open("positions.pkl", "rb"))

def minute_rows(pos):
    """Per held minute: features + label(future bid >= bid*1.15)."""
    bids, mins, entry = pos["bids"], pos["mins"], pos["entry"]
    out = []
    peak = bids[0]
    n = len(bids)
    # suffix max of future bids
    sufmax = np.empty(n, dtype=np.float32)
    run = 0.0
    for i in range(n - 1, -1, -1):
        sufmax[i] = run; run = max(run, bids[i])
    for i in range(1, n - 1):
        b = bids[i]
        if b <= 0: continue
        peak = max(peak, b)
        out.append(((b / entry - 1, peak / entry - 1, 1 - b / max(peak, 1e-9),
                     int(mins[i] - pos["fireMin"]), int(mins[i]), entry, pos["dir"]),
                    1 if sufmax[i] >= b * 1.15 else 0, i))
    return out

def v0_exit_mult(pos):
    bids, mins, entry = pos["bids"], pos["mins"], pos["entry"]
    peak = bids[0]
    for i in range(len(bids)):
        b = bids[i]; peak = max(peak, b)
        g = peak / entry - 1; held = int(mins[i] - pos["fireMin"])
        if mins[i] >= 910: return b / entry
        if g >= 0.25 and b <= entry: return b / entry
        if b <= entry * 0.70: return b / entry
        if held >= 10 and peak < entry * 1.10: return b / entry
        tr = 0.15 if g >= 1 else (0.20 if g >= 0.33 else None)
        if tr is not None and b <= peak * (1 - tr): return b / entry
    return bids[-1] / entry

def ml_exit_mult(pos, probs_by_i, th):
    bids, entry = pos["bids"], pos["entry"]
    for i, p in probs_by_i:
        if p < th: return bids[i] / entry
    return bids[-1] / entry

FEATS = 7
def build(ps):
    X, y, owners = [], [], []
    for k, pos in enumerate(ps):
        for feats, label, i in minute_rows(pos):
            X.append(feats); y.append(label); owners.append((k, i))
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int8), owners

train = [p for p in positions if p["day"] < "2026-03-01"]
val   = [p for p in positions if "2026-03-01" <= p["day"] < "2026-06-01"]
test  = [p for p in positions if p["day"] >= "2026-06-01"]
Xtr, ytr, _ = build(train)
Xva, yva, ova = build(val)
Xte, yte, ote = build(test)
print(f"rows train {len(ytr)} | val {len(yva)} | test {len(yte)} | hold-worthy base rate test {yte.mean():.3f}")

model = HistGradientBoostingClassifier(max_iter=300, max_depth=5, learning_rate=0.06,
                                       min_samples_leaf=60, random_state=7)
model.fit(Xtr, ytr)
print(f"AUC val {roc_auc_score(yva, model.predict_proba(Xva)[:,1]):.3f} | test {roc_auc_score(yte, model.predict_proba(Xte)[:,1]):.3f}")

def policy_scores(ps, X, owners, th):
    probs = model.predict_proba(X)[:, 1]
    byk = {}
    for (k, i), pr in zip(owners, probs): byk.setdefault(k, []).append((i, pr))
    tot_ml = tot_v0 = tot_peak = 0.0
    for k, pos in enumerate(ps):
        peak_m = float(pos["bids"].max()) / pos["entry"]
        tot_peak += peak_m - 1
        tot_v0 += v0_exit_mult(pos) - 1
        tot_ml += ml_exit_mult(pos, sorted(byk.get(k, [])), th) - 1
    return tot_ml, tot_v0, tot_peak

# tune threshold on validation months (never on test)
best_th, best = None, -1e9
for th in [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55]:
    m, _, _ = policy_scores(val, Xva, ova, th)
    if m > best: best, best_th = m, th
print(f"threshold tuned on val: {best_th} (val ML total {100*best:.0f}%)")

ml, v0, peak = policy_scores(test, Xte, ote, best_th)
n = len(test)
print(f"\nUNSEEN 6 MONTHS ({n} positions, equal-premium):")
print(f"  unmanaged peak  {100*peak:+8.0f}%   (capture 100%)")
print(f"  V0 shipped      {100*v0:+8.0f}%   (capture {100*v0/peak:5.1f}%)")
print(f"  ML tree th={best_th}  {100*ml:+8.0f}%   (capture {100*ml/peak:5.1f}%)")
for th in [0.35, 0.5]:
    m2, _, _ = policy_scores(test, Xte, ote, th)
    print(f"  ML tree th={th:<4} {100*m2:+8.0f}%   (capture {100*m2/peak:5.1f}%)")
import pickle as pk
pk.dump({"model": model, "th": best_th}, open("tree_model.pkl", "wb"))
