# Phase B (torch only — no sklearn in this process): train LSTM + TCN, score
# alone and in ensembles against the tree probs from phase A.
import numpy as np, torch, torch.nn as nn

torch.manual_seed(7)
D = np.load("nets_data.npz"); P = np.load("nets_positions.npz")
WIN = 30

def auc(y, p):  # rank-based AUC, no sklearn
    order = np.argsort(p)
    ranks = np.empty(len(p)); ranks[order] = np.arange(1, len(p) + 1)
    pos = y > 0.5; npos, nneg = pos.sum(), (~pos).sum()
    return (ranks[pos].sum() - npos * (npos + 1) / 2) / (npos * nneg)

class LSTMNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.lstm = nn.LSTM(1, 32, batch_first=True)
        self.head = nn.Sequential(nn.Linear(33, 32), nn.ReLU(), nn.Linear(32, 1))
    def forward(self, x):
        out, _ = self.lstm(x[:, :WIN].unsqueeze(-1))
        return self.head(torch.cat([out[:, -1], x[:, WIN:]], dim=1)).squeeze(-1)

class TCN(nn.Module):
    def __init__(self):
        super().__init__()
        def blk(ci, co, d): return nn.Sequential(nn.Conv1d(ci, co, 3, padding=d, dilation=d), nn.ReLU())
        self.net = nn.Sequential(blk(1, 24, 1), blk(24, 24, 2), blk(24, 24, 4))
        self.head = nn.Sequential(nn.Linear(25, 32), nn.ReLU(), nn.Linear(32, 1))
    def forward(self, x):
        h = self.net(x[:, :WIN].unsqueeze(1))[:, :, -1]
        return self.head(torch.cat([h, x[:, WIN:]], dim=1)).squeeze(-1)

def fit(net, X, y, epochs=3, bs=1024):
    opt = torch.optim.Adam(net.parameters(), lr=1e-3); lossf = nn.BCEWithLogitsLoss()
    Xt, yt = torch.from_numpy(X), torch.from_numpy(y)
    for ep in range(epochs):
        perm = torch.randperm(len(yt)); tot = 0.0
        for s in range(0, len(yt), bs):
            b = perm[s:s + bs]; opt.zero_grad()
            loss = lossf(net(Xt[b]), yt[b]); loss.backward(); opt.step()
            tot += float(loss) * len(b)
        print(f"  epoch {ep + 1} loss {tot / len(yt):.4f}", flush=True)
    return net

def predict(net, X, bs=4096):
    net.eval(); out = []
    with torch.no_grad():
        for s in range(0, len(X), bs):
            out.append(torch.sigmoid(net(torch.from_numpy(X[s:s + bs]))).numpy())
    return np.concatenate(out)

def unpack(prefix):
    lens = P[f"{prefix}_lens"]; off = np.concatenate([[0], np.cumsum(lens)])
    return [{"entry": float(P[f"{prefix}_entry"][k]), "fire": int(P[f"{prefix}_fire"][k]),
             "bids": P[f"{prefix}_bids"][off[k]:off[k + 1]], "mins": P[f"{prefix}_mins"][off[k]:off[k + 1]]}
            for k in range(len(lens))]
VAL, TEST = unpack("val"), unpack("test")

def capture(ps, owners, probs, th, floor=True):
    pmap = {}
    for (k, i), pr in zip(owners, probs): pmap[(k, i)] = pr
    tot_x = tot_pk = 0.0
    for k, pos in enumerate(ps):
        bids, mins, entry = pos["bids"], pos["mins"], pos["entry"]
        tot_pk += float(bids.max()) / entry - 1
        peak = bids[0]; done = False
        for i in range(len(bids)):
            b = bids[i]; peak = max(peak, b)
            held = int(mins[i] - pos["fire"])
            stop = (mins[i] >= 910 or b <= entry * 0.70 or (floor and held >= 10 and peak < entry * 1.10))
            p = pmap.get((k, i))
            if stop or (p is not None and p < th):
                tot_x += b / entry - 1; done = True; break
        if not done: tot_x += float(bids[-1]) / entry - 1
    return tot_x / tot_pk

owners_va = [tuple(o) for o in D["owners_va"]]; owners_te = [tuple(o) for o in D["owners_te"]]
results = {"TREE": (D["tree_va"], D["tree_te"])}
for name, cls in [("LSTM", LSTMNet), ("TCN", TCN)]:
    print(f"training {name}…", flush=True)
    net = fit(cls(), D["Xtr"], D["ytr"])
    results[name] = (predict(net, D["Xva"]), predict(net, D["Xte"]))
results["SOFT-AVG"] = (sum(results[n][0] for n in ["TREE", "LSTM", "TCN"]) / 3,
                       sum(results[n][1] for n in ["TREE", "LSTM", "TCN"]) / 3)

THS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]
report, tuned = [], {}
for name, (pv, pt) in results.items():
    best_th = max(THS, key=lambda th: capture(VAL, owners_va, pv, th))
    tuned[name] = best_th
    report.append(f"{name:9s} AUC {auc(D['yte'], pt):.3f} | th {best_th} | hybrid {100*capture(TEST, owners_te, pt, best_th):.1f}% | stop30-only {100*capture(TEST, owners_te, pt, best_th, floor=False):.1f}%")

votes = sum((results[n][1] < tuned[n]).astype(np.int32) for n in ["TREE", "LSTM", "TCN"])
vote_prob = 1.0 - (votes >= 2).astype(np.float32)
report.append(f"VOTE-2of3 | hybrid {100*capture(TEST, owners_te, vote_prob, 0.5):.1f}% | stop30-only {100*capture(TEST, owners_te, vote_prob, 0.5, floor=False):.1f}%")
out = "\n".join(report)
print("\n" + out, flush=True)
open("nets_result.txt", "w").write(out + "\n")
