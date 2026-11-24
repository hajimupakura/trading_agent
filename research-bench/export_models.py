# Export both HistGBT models to JSON for the TypeScript predictor.
# Format per model: {version, feats, baseline, threshold, trees, checks}
#   trees: list of trees; each tree = list of nodes [featureIdx, threshold, left, right, value, isLeaf, missingLeft]
#   checks: 40 feature vectors + python predict_proba, asserted by TS tests to 1e-6.
import json, pickle, csv, datetime
import numpy as np
from collections import defaultdict
from sklearn.ensemble import HistGradientBoostingClassifier

def export_histgbt(model, feats, threshold, X_check):
    trees = []
    for predictors in model._predictors:
        nodes = predictors[0].nodes
        tree = [[int(n["feature_idx"]), float(n["num_threshold"]), int(n["left"]), int(n["right"]),
                 float(n["value"]), int(n["is_leaf"]), int(n["missing_go_to_left"])] for n in nodes]
        trees.append(tree)
    baseline = float(np.ravel(model._baseline_prediction)[0])
    probs = model.predict_proba(X_check)[:, 1]
    checks = [{"x": [float(v) for v in row], "p": float(p)} for row, p in zip(X_check, probs)]
    return {"version": 1, "feats": feats, "baseline": baseline, "threshold": float(threshold),
            "trees": trees, "checks": checks}

# ---- 1. exit advisor (tree_model.pkl from the tournament) ----
bundle = pickle.load(open("tree_model.pkl", "rb"))
model, th = bundle["model"], bundle["th"]
rng = np.random.default_rng(7)
# plausible feature ranges: gain, peakGain, drawdown, minutesHeld, minuteOfDay, entryPrem, dir
Xc = np.column_stack([
    rng.uniform(-0.8, 3.0, 40), rng.uniform(0.0, 4.0, 40), rng.uniform(0.0, 0.9, 40),
    rng.integers(1, 300, 40), rng.integers(575, 955, 40), rng.uniform(0.05, 8.0, 40),
    rng.choice([-1.0, 1.0], 40),
]).astype(np.float32)
exit_json = export_histgbt(model, ["gain", "peakGain", "drawdownFromPeak", "minutesHeld", "minuteOfDay", "entryPrem", "dir"], th, Xc)
out1 = "/Users/hajimupakura/git_repos/trading_agent/apps/position-worker/src/models/exit-advisor-v1.json"
json.dump(exit_json, open(out1, "w"))
print(f"exit advisor: {len(exit_json['trees'])} trees, th={th}, -> {out1}")

# ---- 2. lottery detector by11_v2 (retrain exactly as lottery_detector_v2.py) ----
MEGACAPS = {"NVDA", "AAPL", "TSLA", "MSFT", "META", "GOOGL"}
best = defaultdict(float); paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        paths[(r["day"], r["occ"], r["fireMin"], r["entryPrint"])].append(float(r["price"]))
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e > 0: best[day] = max(best[day], max(prices) / e)
rows = []
with open("day_features.csv") as f:
    for r in csv.DictReader(f):
        if r["day"] in best: rows.append(r)
rows.sort(key=lambda r: r["day"])
day_set = sorted({r["day"] for r in rows})
next_td = {d: day_set[i + 1] for i, d in enumerate(day_set[:-1])}
events = defaultdict(set); react = defaultdict(set)
with open("events.csv") as f:
    for r in csv.DictReader(f):
        d, et, detail = r["date"], r["event_type"], (r.get("detail") or "").split("|")[0].strip()
        if et in ("cpi", "jobs", "fomc"): events[d].add(et)
        elif et in ("earnings_amc", "earnings_bmo") and detail in MEGACAPS:
            rd = d if et == "earnings_bmo" else next_td.get(d) or next((x for x in day_set if x > d), None)
            if rd: react[rd].add(detail)
def ev_vec(d):
    i = day_set.index(d); prev = day_set[i - 1] if i > 0 else None
    return [1.0 if "cpi" in events[d] else 0.0, 1.0 if "jobs" in events[d] else 0.0,
            1.0 if "fomc" in events[d] else 0.0, 1.0 if (prev and "fomc" in events[prev]) else 0.0,
            1.0 if react[d] else 0.0, 1.0 if (prev and react[prev]) else 0.0,
            1.0 if "NVDA" in react[d] else 0.0]
X, y, days = [], [], []
for r in rows:
    d = r["day"]; dow = datetime.date.fromisoformat(d).weekday()
    X.append([float(r["n_by11"]), float(r["maxleg_by11"]), float(r["syms_by11"]), float(r["first_fire"]), dow] + ev_vec(d))
    y.append(1 if best[d] >= 10 else 0); days.append(d)
X = np.array(X, dtype=np.float32); y = np.array(y); days = np.array(days)
tr = days < "2026-01-01"
det = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, min_samples_leaf=25, random_state=7)
det.fit(X[tr], y[tr])
arm_th = float(np.quantile(det.predict_proba(X[tr])[:, 1], 0.80))  # arm top-20% of days
idx = rng.choice(len(X), 40, replace=False)
det_json = export_histgbt(det, ["n_by11", "maxleg_by11", "syms_by11", "first_fire", "dow",
                                "cpi", "jobs", "fomc", "fomc_prev", "megacap_react", "react_prev", "nvda_react"], arm_th, X[idx])
out2 = "/Users/hajimupakura/git_repos/trading_agent/apps/trading/lib/ml/lottery-detector-v2.json"
json.dump(det_json, open(out2, "w"))
print(f"detector by11_v2: {len(det_json['trees'])} trees, arm_th={arm_th:.4f}, -> {out2}")
