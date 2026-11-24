# Lottery-day detector v2: v1 day-shape features + EVENT CALENDAR features.
# Criterion-first: must beat v1 AUC (~0.58) on the SAME unseen 2026 days.
# Event features (all known BEFORE the open, so they strengthen the deployable BY-11 variant):
#   cpi / jobs / fomc day flags, day-after-fomc,
#   megacap earnings REACTION day (AMC report -> next trading day), day-after-reaction,
#   NVDA-specific reaction flag (the monster-maker).
import csv, datetime, json
import numpy as np
from collections import defaultdict
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

MEGACAPS = {"NVDA", "AAPL", "TSLA", "MSFT", "META", "GOOGL"}

# ---- labels from census (identical to v1) ----
best = defaultdict(float)
paths = defaultdict(list)
with open("lottery.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["occ"], r["fireMin"], r["entryPrint"])
        paths[key].append(float(r["price"]))
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e > 0: best[day] = max(best[day], max(prices) / e)

# ---- day-shape features (identical to v1) ----
rows = []
with open("day_features.csv") as f:
    for r in csv.DictReader(f):
        if r["day"] not in best: continue
        rows.append(r)
rows.sort(key=lambda r: r["day"])
days = [r["day"] for r in rows]
day_set = sorted(set(days))
next_td = {d: day_set[i + 1] for i, d in enumerate(day_set[:-1])}  # trading-day successor

# ---- event calendar ----
events = defaultdict(set)      # date -> {cpi, jobs, fomc}
react = defaultdict(set)       # trading day -> set of tickers whose earnings reaction lands that day
with open("events.csv") as f:
    for r in csv.DictReader(f):
        d, et, detail = r["date"], r["event_type"], (r.get("detail") or "").split("|")[0].strip()
        if et in ("cpi", "jobs", "fomc"):
            events[d].add(et)
        elif et in ("earnings_amc", "earnings_bmo") and detail in MEGACAPS:
            if et == "earnings_bmo":
                rd = d
            else:  # AMC: reaction is the NEXT trading day
                rd = next_td.get(d)
                if rd is None:  # report date not a scan day: find first scan day strictly after
                    later = [x for x in day_set if x > d]
                    rd = later[0] if later else None
            if rd: react[rd].add(detail)

def ev_vec(d):
    prev = None
    i = day_set.index(d)
    if i > 0: prev = day_set[i - 1]
    return [
        1.0 if "cpi" in events[d] else 0.0,
        1.0 if "jobs" in events[d] else 0.0,
        1.0 if "fomc" in events[d] else 0.0,
        1.0 if (prev and "fomc" in events[prev]) else 0.0,
        1.0 if react[d] else 0.0,
        1.0 if (prev and react[prev]) else 0.0,
        1.0 if "NVDA" in react[d] else 0.0,
    ]

EV_NAMES = ["cpi", "jobs", "fomc", "fomc_prev", "megacap_react", "react_prev", "nvda_react"]

feats = []
for r in rows:
    d = r["day"]
    dow = datetime.date.fromisoformat(d).weekday()
    base_eod = [float(r[k]) for k in ["n15","n2","n3","max_leg","avg_leg","n_syms","n_calls","n_puts","first_fire"]] + [dow]
    base_11 = [float(r["n_by11"]), float(r["maxleg_by11"]), float(r["syms_by11"]), float(r["first_fire"]), dow]
    ev = ev_vec(d)
    feats.append({"day": d, "label": 1 if best[d] >= 10 else 0,
                  "eod_v1": base_eod, "by11_v1": base_11,
                  "eod_v2": base_eod + ev, "by11_v2": base_11 + ev,
                  "ev_only": ev})

y = np.array([x["label"] for x in feats])
darr = np.array([x["day"] for x in feats])
tr = darr < "2026-01-01"; te = ~tr
n_ev_days = sum(1 for x in feats if any(x["ev_only"]))
print(f"days {len(feats)} | lottery days {y.sum()} | event-flagged days {n_ev_days}")
print(f"split: train {tr.sum()} (+{y[tr].sum()}) / test {te.sum()} (+{y[te].sum()})")

results = {}
for name in ["eod_v1", "eod_v2", "by11_v1", "by11_v2", "ev_only"]:
    X = np.array([x[name] for x in feats], dtype=np.float32)
    m = HistGradientBoostingClassifier(max_iter=200, max_depth=3, learning_rate=0.06, min_samples_leaf=25, random_state=7)
    m.fit(X[tr], y[tr])
    p = m.predict_proba(X[te])[:, 1]
    auc = roc_auc_score(y[te], p)
    results[name] = (m, X, p, auc)
    print(f"\n[{name}] AUC {auc:.3f} on unseen 2026")
    for th_q in [0.70, 0.80, 0.90]:
        th = np.quantile(m.predict_proba(X[tr])[:, 1], th_q)
        pred = p >= th
        tp = int((pred & (y[te] == 1)).sum()); fp = int((pred & (y[te] == 0)).sum()); fn = int((~pred & (y[te] == 1)).sum())
        prec = tp / max(tp + fp, 1); rec = tp / max(tp + fn, 1)
        print(f"  arm top {100*(1-th_q):.0f}%: armed {int(pred.sum())}/{int(te.sum())} | precision {100*prec:.0f}% | recall {100*rec:.0f}%")

# ---- swarm EV comparison on unseen 2026, v1 vs v2 BY-11 ----
pnl_by_day = defaultdict(float)
HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)
for (day, occ, fire, entry), prices in paths.items():
    e = float(entry)
    if e <= 0 or e > 0.25: continue
    pnl_by_day[day] += (hair(prices[-1]) - e) * 100 * (500 / (e * 100))
test_days = [d for d, t in zip(darr, te) if t]
all_pnl = sum(pnl_by_day.get(d, 0) for d in test_days)
print(f"\n=== SWARM EV unseen 2026 (pennies <=0.25, $500 each, hold to expiry) ===")
print(f"swarm EVERY day: ${all_pnl:+12,.0f} ({len(test_days)} days)")
for name in ["by11_v1", "by11_v2"]:
    m, X, p, auc = results[name]
    p_by_day = dict(zip(test_days, p))
    for th_q in [0.80, 0.90]:
        th = np.quantile(m.predict_proba(X[tr])[:, 1], th_q)
        armed = [d for d in test_days if p_by_day[d] >= th]
        pnl = sum(pnl_by_day.get(d, 0) for d in armed)
        print(f"{name} top {100*(1-th_q):>2.0f}%: ${pnl:+12,.0f} ({len(armed)} days) -> {100*pnl/all_pnl if all_pnl else 0:.0f}% of profit on {100*len(armed)/max(len(test_days),1):.0f}% of days")

# ---- descriptive: do event days themselves concentrate lottery profit? ----
print(f"\n=== EVENT DAYS vs LOTTERY DAYS (all {len(feats)} census days) ===")
for i, nm in enumerate(EV_NAMES):
    flag = np.array([x["ev_only"][i] for x in feats]) > 0
    if flag.sum() == 0: continue
    rate_on = y[flag].mean(); rate_off = y[~flag].mean()
    pnl_on = sum(pnl_by_day.get(d, 0) for d, fl in zip(darr, flag) if fl)
    print(f"{nm:>14}: {int(flag.sum()):>3} days | lottery rate {100*rate_on:4.0f}% vs {100*rate_off:4.0f}% baseline | swarm pnl ${pnl_on:+10,.0f}")
