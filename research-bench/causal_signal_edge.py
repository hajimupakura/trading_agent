# One entry per name/side/day (what a trader actually gets), with error bars, by direction,
# by year, and a replay-vs-live fidelity check. usage: python3 drive_test2.py <ohlc dirs...> -- <fires csvs...>
import sys, glob, numpy as np, pandas as pd
args = sys.argv[1:]; cut = args.index("--"); dirs, fire_files = args[:cut], args[cut + 1:]
fires = pd.concat([pd.read_csv(f) for f in fire_files]).drop_duplicates(["day", "sym", "min", "dir"])
bars = pd.concat([pd.read_csv(f, usecols=["day", "sym", "min", "high", "low", "close"]) for d in dirs for f in sorted(glob.glob(d + "/part-*.csv"))])
bars = bars[(bars["min"] >= 570) & (bars["min"] < 960)].drop_duplicates(["day", "sym", "min"])
book = {k: g.sort_values("min")[["min", "high", "low", "close"]].to_numpy() for k, g in bars.groupby(["sym", "day"])}
print(f"bars: {len(bars):,} rows, {bars.day.min()} -> {bars.day.max()}, {bars.sym.nunique()} symbols, {len(book):,} sessions | fire-minutes {len(fires):,}")

def fwd(row):
    a = book.get((row.sym, row.day)); n = 5
    if a is None: return [np.nan] * n
    i = int(np.searchsorted(a[:, 0], row["min"]))
    if i >= len(a) or a[i, 0] != row["min"]: return [np.nan] * n
    p, d = row.price, row.dir; out = []
    for h in (10, 20, 30, 60):
        j = int(np.searchsorted(a[:, 0], row["min"] + h, side="right")) - 1
        out.append(d * (a[j, 3] / p - 1) * 100 if j > i else np.nan)
    out.append(d * (a[-1, 3] / p - 1) * 100)
    return out

def first_of(g): return g.sort_values("min").groupby(["sym", "day", "dir"]).head(1).copy()
def line(label, g):
    g = g.dropna(subset=["f20"])
    if len(g) < 5: print(f"{label:>52}: n {len(g)}"); return
    se = g.f20.std() / np.sqrt(len(g))
    print(f"{label:>52}: n {len(g):>5} | +10m {g.f10.mean():+.3f}% | +20m {g.f20.mean():+.3f}% ±{1.96*se:.3f} ({100*(g.f20>0).mean():3.0f}% right) | +30m {g.f30.mean():+.3f}% | +60m {g.f60.mean():+.3f}% | to close {g.fclose.mean():+.3f}%")

IDX = ["SPY", "QQQ", "IWM", "GLD", "SLV", "DIA"]
sets = {"opening_drive, first fire (9:31+)": first_of(fires[fires.setup == "opening_drive"]),
        "opening_drive, first fire at/after 9:45 (lane today)": first_of(fires[(fires.setup == "opening_drive") & (fires["min"] >= 585)]),
        "opening_range, first fire": first_of(fires[fires.setup == "opening_range"]),
        "trend_continuation, first fire": first_of(fires[fires.setup == "trend_continuation"]),
        "ANY setup, first fire at/after 9:45 (lane today)": first_of(fires[fires["min"] >= 585])}
for name, g in sets.items():
    g[["f10", "f20", "f30", "f60", "fclose"]] = g.apply(fwd, axis=1, result_type="expand")
    g["yr"] = g.day.str[:4]
    print(f"\n=== {name} ===")
    line("ALL", g); line("PUTS", g[g.dir < 0]); line("CALLS", g[g.dir > 0])
    line("index/ETF", g[g.sym.isin(IDX)]); line("single names", g[~g.sym.isin(IDX)])
    for yr, gg in g.groupby("yr"):
        line(f"{yr} puts", gg[gg.dir < 0]); line(f"{yr} calls", gg[gg.dir > 0])
    if "drive" in name:
        line("fresh: fired ON a new extreme", g[g.minsSinceExtreme == 0])
        line("extreme 1-5 min old", g[g.minsSinceExtreme.between(1, 5)])
        line("stale: extreme >5 min old", g[g.minsSinceExtreme > 5])
        line("within 0.3% of extreme", g[g.offExtremePct <= 0.3]); line("more than 0.3% off extreme", g[g.offExtremePct > 0.3])
        for yr, gg in g.groupby("yr"):
            line(f"{yr} fresh (0 min)", gg[gg.minsSinceExtreme == 0]); line(f"{yr} stale (>5 min)", gg[gg.minsSinceExtreme > 5])
    sets[name] = g

# fidelity: replay first fires vs the live engine's actual first fires 11/19-11/24
try:
    live = pd.read_csv("live_fires_nov2.csv", names=["day", "sym", "min", "dir", "setup"])
    rep = first_of(fires[fires.day.isin(live.day.unique())])
    m = live.merge(rep[["day", "sym", "dir", "min", "setup"]], on=["day", "sym", "dir"], how="outer", suffixes=("_live", "_replay"), indicator=True)
    print("\n=== FIDELITY: live engine first fires vs replay, same days ==="); print(m.sort_values(["day", "sym"]).to_string(index=False))
except Exception as e: print("fidelity skipped:", e)
