# PLAY SELECTOR (the user's capstone ask): given a fire, which ARM pays best —
# ITM(-2%) / near(+1%) / OTM(+4%) / far-OTM(+8%) swing, same-day 0DTE, or SKIP?
# Arms use each moneyness level's best exit from the swarm study (trail50 for
# ITM/near, day+2 close for +4/+8); 0DTE holds to the same-day close. Label = the
# arm with the best return per $1 risked ('skip' when every arm loses).
# Two feature sets: FIRE-TIME (knowable the second the fire prints: leg, time,
# direction, symbol class, weekday) and +PULLBACK (adds heldVwap/volumeFading/
# retracePct — known ~30-90 min later; an upper bound for a later-stamp variant).
# Walk-forward: train < 2026-06-01, judge on >= 2026-06-01 (never touched).
import csv, glob, datetime
import numpy as np
from collections import defaultdict
from sklearn.ensemble import HistGradientBoostingClassifier

HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)
INDEXY = {"SPY", "QQQ", "GLD", "SPX"}

# ---- scan features ----
scan = {}
for fn in glob.glob("scanfeat/*.psv"):
    for line in open(fn):
        parts = line.strip().split("|")
        if len(parts) != 9: continue
        day, sym, dir_, leg, fire, held, fading, retr, _ = parts
        key = (day, sym, int(dir_), int(fire))
        scan[key] = (float(leg), int(held), int(fading), float(retr) if retr else np.nan)
scan_by_dsd = defaultdict(list)
for (day, sym, dir_, fire), v in scan.items(): scan_by_dsd[(day, sym, dir_)].append((fire, v))

# ---- swing tapes -> per-event arms ----
paths = defaultdict(list)
with open("swing.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["sym"], int(r["dir"]), int(r["lvl"]), int(r["fireMin"]), float(r["entryPrint"]))
        paths[key].append((int(r["min"]), float(r["price"])))

def exit_trail50(entry, tape):
    peak, armed = tape[0][1], False
    for m, p in tape:
        peak = max(peak, p)
        if peak >= entry * 2: armed = True
        if armed and p <= peak * 0.5: return hair(p)
    return hair(tape[-1][1])
def exit_d2close(entry, tape):
    d2 = [p for m, p in tape if m <= 2 * 1440 + 965]
    return hair(d2[-1]) if d2 else hair(tape[-1][1])

events = defaultdict(dict)  # (day,sym,dir,fireMin) -> {armname: ret per $1}
for (day, sym, dir_, lvl, fire, entry), tape in paths.items():
    if entry <= 0 or lvl == 0: continue  # lvl 0 = legacy single-strike (pre-ladder), redundant with otm4
    tape.sort(); tape = [(m, p) for m, p in tape if m >= fire]
    if len(tape) < 10: continue
    ex = exit_trail50(entry, tape) if lvl in (-2, 1) else exit_d2close(entry, tape)
    name = {-2: "itm", 1: "near", 4: "otm4", 8: "otm8"}[lvl]
    events[(day, sym, dir_, fire)][name] = (ex - entry) / entry

# ---- 0DTE arm from corpus (lvl=0 same-day) ----
corpus = defaultdict(list)
with open("corpus.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["sym"], int(r["dir"]), int(r["fireMin"]), float(r["entryPrint"]))
        corpus[key].append((int(r["min"]), float(r["price"])))
c_by_dsd = defaultdict(list)
for (day, sym, dir_, fire, entry), tape in corpus.items():
    tape.sort(); tape = [(m, p) for m, p in tape if m >= fire]
    if len(tape) < 5 or entry <= 0: continue
    ret = (hair(tape[-1][1]) - entry) / entry
    c_by_dsd[(day, sym, dir_)].append((fire, ret))

ARMS = ["itm", "near", "otm4", "otm8", "dte0"]
rows = []
for (day, sym, dir_, fire), arms in events.items():
    cands = c_by_dsd.get((day, sym, dir_), [])
    near0 = min(cands, key=lambda x: abs(x[0] - fire), default=None)
    if near0 and abs(near0[0] - fire) <= 10: arms["dte0"] = near0[1]
    if len(arms) < 3: continue
    scands = scan_by_dsd.get((day, sym, dir_), [])
    nearest = min(scands, key=lambda x: abs(x[0] - fire), default=None)
    if not nearest or abs(nearest[0] - fire) > 15: continue
    leg, held, fading, retr = nearest[1]
    rets = {a: arms.get(a, np.nan) for a in ARMS}
    avail = {a: v for a, v in rets.items() if not np.isnan(v)}
    best_arm = max(avail, key=avail.get)
    label = "skip" if avail[best_arm] <= 0 else best_arm
    dow = datetime.date.fromisoformat(day).weekday()
    rows.append({
        "day": day, "sym": sym, "label": label, "rets": rets,
        "fire": [leg, fire, dir_, 1.0 if sym in INDEXY else 0.0, dow],
        "pull": [leg, fire, dir_, 1.0 if sym in INDEXY else 0.0, dow, held, fading, retr],
    })
rows.sort(key=lambda r: r["day"])
days = np.array([r["day"] for r in rows])
tr = days < "2026-06-01"; te = ~tr
labels = sorted({r["label"] for r in rows})
y = np.array([labels.index(r["label"]) for r in rows])
print(f"events {len(rows)} | train {tr.sum()} test {te.sum()} | label mix: " +
      ", ".join(f"{l} {100*np.mean([r['label']==l for r in rows]):.0f}%" for l in labels))

def ret_of(r, arm):
    v = r["rets"].get(arm, np.nan)
    return 0.0 if arm == "skip" or np.isnan(v) else v

test_rows = [r for r, t in zip(rows, te) if t]
print(f"\n=== fixed policies on UNSEEN >= 2026-06 ({len(test_rows)} events, return per $1 risked, x$500 total) ===")
for arm in ["itm", "near", "otm4", "otm8", "dte0"]:
    rs = [ret_of(r, arm) for r in test_rows]
    print(f"always-{arm:5s}: mean {np.mean(rs):+7.3f} | total ${500*sum(rs):+12,.0f} | win {100*np.mean([x>0 for x in rs]):.0f}%")
oracle = [max(0.0, max((v for v in r["rets"].values() if not np.isnan(v)), default=0.0)) for r in test_rows]
print(f"ORACLE (upper bound): mean {np.mean(oracle):+7.3f} | total ${500*sum(oracle):+12,.0f}")

for name in ["fire", "pull"]:
    X = np.array([r[name] for r in rows], dtype=np.float32)
    m = HistGradientBoostingClassifier(max_iter=250, max_depth=4, learning_rate=0.06, min_samples_leaf=40, random_state=7)
    m.fit(X[tr], y[tr])
    pred = m.predict(X[te])
    picks = [labels[p] for p in pred]
    rs = [ret_of(r, a) for r, a in zip(test_rows, picks)]
    traded = [x for x, a in zip(rs, picks) if a != "skip"]
    from collections import Counter
    print(f"\n[SELECTOR-{name.upper()}] mean {np.mean(rs):+7.3f}/event | total ${500*sum(rs):+12,.0f} | "
          f"traded {len(traded)}/{len(rs)} | win(traded) {100*np.mean([x>0 for x in traded]) if traded else 0:.0f}%")
    print(f"  picks: {dict(Counter(picks))}")
    hit = np.mean([a == r['label'] for r, a in zip(test_rows, picks)])
    print(f"  exact-best-arm hit rate {100*hit:.0f}% (chance ~{100/len(labels):.0f}%)")
