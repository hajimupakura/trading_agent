# Phase A (sklearn only): build sequence windows + tree probabilities, save to npz.
# torch and sklearn segfault when loaded in one process on this machine, so the
# net training runs in a separate torch-only process (run_nets.py).
# (session-local pickles, self-generated)
import numpy as np
from train_tree import positions, build, model as tree_model

WIN = 30
def windows(ps):
    X, y, owners = [], [], []
    for k, pos in enumerate(ps):
        bids, mins, entry = pos["bids"], pos["mins"], pos["entry"]
        n = len(bids)
        sufmax = np.empty(n, dtype=np.float32); run = 0.0
        for i in range(n - 1, -1, -1): sufmax[i] = run; run = max(run, bids[i])
        rel = (bids / entry).astype(np.float32)
        for i in range(1, n - 1):
            if bids[i] <= 0: continue
            lo = max(0, i - WIN + 1)
            w = rel[lo:i + 1]
            if len(w) < WIN: w = np.concatenate([np.full(WIN - len(w), w[0], dtype=np.float32), w])
            X.append(np.concatenate([w, [mins[i] / 960.0]]).astype(np.float32))
            y.append(1 if sufmax[i] >= bids[i] * 1.15 else 0)
            owners.append((k, i))
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32), np.array(owners, dtype=np.int32)

train = [p for p in positions if p["day"] < "2026-03-01"]
val   = [p for p in positions if "2026-03-01" <= p["day"] < "2026-06-01"]
test  = [p for p in positions if p["day"] >= "2026-06-01"]

Xtr, ytr, _ = windows(train)
rng = np.random.default_rng(7)
idx = rng.permutation(len(ytr))[:140_000]
Xva, yva, owners_va = windows(val)
Xte, yte, owners_te = windows(test)

# tree probabilities on identical rows (build() iterates positions in the same order)
Xva_t, _, ova_t = build(val); Xte_t, _, ote_t = build(test)
assert [tuple(o) for o in owners_va] == ova_t and [tuple(o) for o in owners_te] == ote_t, "row alignment mismatch"
np.savez_compressed("nets_data.npz",
    Xtr=Xtr[idx], ytr=ytr[idx], Xva=Xva, yva=yva, Xte=Xte, yte=yte,
    owners_va=owners_va, owners_te=owners_te,
    tree_va=tree_model.predict_proba(Xva_t)[:, 1].astype(np.float32),
    tree_te=tree_model.predict_proba(Xte_t)[:, 1].astype(np.float32))

# per-position arrays for the capture backtest, torch side (ragged → object-free dump)
def pack(ps):
    return {"entry": np.array([p["entry"] for p in ps], dtype=np.float32),
            "fire": np.array([p["fireMin"] for p in ps], dtype=np.int32),
            "lens": np.array([len(p["bids"]) for p in ps], dtype=np.int32),
            "bids": np.concatenate([p["bids"] for p in ps]).astype(np.float32),
            "mins": np.concatenate([p["mins"] for p in ps]).astype(np.int32)}
pv, pt = pack(val), pack(test)
np.savez_compressed("nets_positions.npz", **{f"val_{k}": v for k, v in pv.items()}, **{f"test_{k}": v for k, v in pt.items()})
print(f"saved: train {len(idx)} windows | val {len(yva)} | test {len(yte)}")
