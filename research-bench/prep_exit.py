# Build the exit-advisor dataset from the full 22-month corpus (ml-corpus export).
# One record per open-position minute; positions kept whole for walk-forward splits
# and policy backtests. Bid proxy = trade print minus 1.5% (min 5c) haircut.
import csv, pickle
import numpy as np
from collections import defaultdict

HAIR_PCT, HAIR_MIN = 0.015, 0.05
def hair(p): return max(p - max(HAIR_MIN, p * HAIR_PCT), 0.0)

paths = defaultdict(list)   # (day, occ, fireMin, entry) -> [(min, price)]
meta = {}
with open("corpus.csv") as f:
    for r in csv.DictReader(f):
        key = (r["day"], r["occ"], int(r["fireMin"]), float(r["entryPrint"]))
        paths[key].append((int(r["min"]), float(r["price"])))
        if key not in meta: meta[key] = (r["sym"], int(r["dir"]))

positions = []
for (day, occ, fire_min, entry), tape in paths.items():
    tape.sort()
    tape = [(m, p) for m, p in tape if m >= fire_min and m <= 915]
    if len(tape) < 15 or entry <= 0: continue
    mins = np.array([m for m, _ in tape], dtype=np.int32)
    bids = np.array([hair(p) for _, p in tape], dtype=np.float32)
    sym, dir_ = meta[(day, occ, fire_min, entry)]
    positions.append({"day": day, "sym": sym, "dir": dir_, "occ": occ,
                      "entry": entry, "fireMin": fire_min, "mins": mins, "bids": bids})

positions.sort(key=lambda p: (p["day"], p["occ"], p["fireMin"]))
with open("positions.pkl", "wb") as f: pickle.dump(positions, f)
days = sorted({p["day"] for p in positions})
print(f"positions {len(positions)} | days {len(days)} | {days[0]}..{days[-1]}")
print(f"train(<2026-06-01): {sum(1 for p in positions if p['day'] < '2026-06-01')} | test(>=2026-06-01): {sum(1 for p in positions if p['day'] >= '2026-06-01')}")
