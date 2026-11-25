# Why do call signals fade and put signals follow through by the same ~0.07%? Check
# (1) the timing profile of the drift after engine fires, (2) whether a NAIVE new-session-
# high / new-session-low event (no engine) shows the same thing, (3) by symbol.
import glob, numpy as np, pandas as pd
dirs = ["ohlc", "ohlc_rest", "ohlc_rest_b"]
bars = pd.concat([pd.read_csv(f, usecols=["day","sym","min","high","low","close"]) for d in dirs for f in sorted(glob.glob(d+"/part-*.csv"))])
bars = bars[(bars["min"]>=570)&(bars["min"]<960)].drop_duplicates(["day","sym","min"]).sort_values(["sym","day","min"])
book = {k: g[["min","high","low","close"]].to_numpy() for k, g in bars.groupby(["sym","day"])}
fires = pd.concat([pd.read_csv(f) for f in ["fires_6q.csv","fires_rest_a.csv","fires_rest_b.csv"]])
ff = fires[fires["min"]>=585].sort_values("min").groupby(["sym","day","dir"]).head(1)
H = [1,2,3,5,10,20,30]
def prof(rows):
    out = {h: [] for h in H}; mism = 0
    for sym, day, m, p in rows:
        a = book.get((sym, day))
        if a is None: continue
        i = int(np.searchsorted(a[:,0], m))
        if i >= len(a) or a[i,0] != m: continue
        if abs(a[i,3]/p-1) > 1e-6: mism += 1
        for h in H:
            j = int(np.searchsorted(a[:,0], m+h, side="right"))-1
            if j > i: out[h].append((a[j,3]/p-1)*100)
    return {h: np.mean(v) for h, v in out.items()}, len(out[1]), mism
for nm, g in [("engine CALL fires", ff[ff.dir>0]), ("engine PUT fires", ff[ff.dir<0])]:
    p, n, mism = prof(g[["sym","day","min","price"]].to_numpy())
    print(f"{nm:>28} n {n:>5} price-mismatch {mism} | RAW stock move after: " + " ".join(f"+{h}m {v:+.3f}%" for h, v in p.items()))
# naive events: first minute after 9:45 whose close is a new session high / low by >=0.15% beyond the 9:30-9:45 range
hi_rows, lo_rows = [], []
for (sym, day), a in book.items():
    if len(a) < 200: continue
    pre = a[a[:,0] < 585]
    if len(pre) < 10: continue
    orh, orl = pre[:,1].max(), pre[:,2].min()
    post = a[(a[:,0] >= 585) & (a[:,0] <= 885)]
    up = post[post[:,3] > orh*1.0015]; dn = post[post[:,3] < orl*0.9985]
    if len(up): hi_rows.append((sym, day, up[0,0], up[0,3]))
    if len(dn): lo_rows.append((sym, day, dn[0,0], dn[0,3]))
for nm, rows in [("NAIVE break above 15-min range", hi_rows), ("NAIVE break below 15-min range", lo_rows)]:
    p, n, _ = prof(rows)
    print(f"{nm:>32} n {n:>5} | RAW stock move after: " + " ".join(f"+{h}m {v:+.3f}%" for h, v in p.items()))
print("\nby symbol — engine fires, signed +20m (right way = positive):")
def f20(r):
    a = book.get((r.sym, r.day)); i = int(np.searchsorted(a[:,0], r["min"])); j = int(np.searchsorted(a[:,0], r["min"]+20, side="right"))-1
    return r.dir*(a[j,3]/r.price-1)*100 if j > i else np.nan
ff = ff.assign(f20=ff.apply(f20, axis=1)).dropna(subset=["f20"])
t = ff.groupby(["sym","dir"]).f20.agg(["count","mean",lambda x: 100*(x>0).mean()]).round(3); t.columns=["n","mean20","pct_right"]; print(t.unstack().to_string())
# day-clustered error bars: average per day first, then across days
for d, nm in [(1,"CALLS"),(-1,"PUTS")]:
    per_day = ff[ff.dir==d].groupby("day").f20.mean()
    print(f"{nm}: {len(per_day)} days, day-averaged +20m {per_day.mean():+.3f}% ± {1.96*per_day.std()/np.sqrt(len(per_day)):.3f}, days positive {100*(per_day>0).mean():.0f}%")
