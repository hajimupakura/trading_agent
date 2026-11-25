# OPENING-DRIVE "STILL FALLING" TEST (2026-11-25) — stock-side only, causal.
# Input: fires csv from research-bench/replay_engine.cts (every minute the live engine
# would have fired) + the OHLC minute bars. For each fire: what did the STOCK do over the
# next 10/20/30 minutes, signed in the trade's direction. Split by how stale the session
# extreme was when the engine fired (minsSinceExtreme, offExtremePct).
# usage: python3 drive_test.py <fires.csv> <ohlc dir>
import sys, glob, numpy as np, pandas as pd

fires = pd.read_csv(sys.argv[1])
bars = pd.concat([pd.read_csv(f, usecols=["day", "sym", "min", "high", "low", "close"]) for f in sorted(glob.glob(sys.argv[2] + "/part-*.csv"))])
bars = bars[(bars["min"] >= 570) & (bars["min"] < 960)].drop_duplicates(["day", "sym", "min"])
book = {k: g.sort_values("min")[["min", "high", "low", "close"]].to_numpy() for k, g in bars.groupby(["sym", "day"])}

def fwd(row):
    a = book.get((row.sym, row.day))
    if a is None: return [np.nan] * 6
    i = int(np.searchsorted(a[:, 0], row["min"]))
    if i >= len(a) or a[i, 0] != row["min"]: return [np.nan] * 6
    p, d = row.price, row.dir
    out = []
    for h in (10, 20, 30):
        j = int(np.searchsorted(a[:, 0], row["min"] + h, side="right")) - 1
        out.append(d * (a[j, 3] / p - 1) * 100 if j > i else np.nan)
    w = a[i + 1:i + 31]
    if len(w) == 0: return out + [np.nan] * 3
    fav = (w[:, 1].max() / p - 1) * 100 if d > 0 else (1 - w[:, 2].min() / p) * 100   # best excursion our way
    adv = (1 - w[:, 2].min() / p) * 100 if d > 0 else (w[:, 1].max() / p - 1) * 100   # worst excursion against
    # which came first: +0.3% our way or -0.3% against (a crude "did it work" race)
    if d > 0: up = np.argmax(w[:, 1] >= p * 1.003) if (w[:, 1] >= p * 1.003).any() else 99; dn = np.argmax(w[:, 2] <= p * 0.997) if (w[:, 2] <= p * 0.997).any() else 99
    else: up = np.argmax(w[:, 2] <= p * 0.997) if (w[:, 2] <= p * 0.997).any() else 99; dn = np.argmax(w[:, 1] >= p * 1.003) if (w[:, 1] >= p * 1.003).any() else 99
    race = 1.0 if up < dn else (0.0 if dn < up else np.nan)
    return out + [fav, adv, race]

fires[["f10", "f20", "f30", "fav", "adv", "race"]] = fires.apply(fwd, axis=1, result_type="expand")
fires = fires.dropna(subset=["f20"])
fires["era"] = fires["day"].str[:4]

def line(label, g):
    if len(g) == 0: print(f"{label:>46}: n 0"); return
    race = g["race"].dropna()
    print(f"{label:>46}: n {len(g):>5} | +10m {g.f10.mean():+.3f}% | +20m {g.f20.mean():+.3f}% ({100*(g.f20>0).mean():3.0f}% right) | +30m {g.f30.mean():+.3f}% "
          f"| best {g.fav.mean():.2f}% worst {g.adv.mean():.2f}% | wins race {100*race.mean():3.0f}%")

def stale_split(g, title):
    print(f"\n--- {title} ---")
    line("ALL", g)
    line("fired ON a new extreme (0 min old)", g[g.minsSinceExtreme == 0])
    line("extreme 1-2 min old", g[g.minsSinceExtreme.between(1, 2)])
    line("extreme 3-5 min old", g[g.minsSinceExtreme.between(3, 5)])
    line("extreme 6-10 min old", g[g.minsSinceExtreme.between(6, 10)])
    line("extreme >10 min old", g[g.minsSinceExtreme > 10])
    line("price within 0.10% of extreme", g[g.offExtremePct <= 0.10])
    line("price 0.10-0.30% off extreme", g[(g.offExtremePct > 0.10) & (g.offExtremePct <= 0.30)])
    line("price 0.30-0.60% off extreme", g[(g.offExtremePct > 0.30) & (g.offExtremePct <= 0.60)])
    line("price >0.60% off extreme", g[g.offExtremePct > 0.60])

drive = fires[fires.setup == "opening_drive"]
print(f"fires total {len(fires)} | drive fire-minutes {len(drive)} | drive sym-day-sides {drive.groupby(['sym','day','dir']).ngroups}")
stale_split(drive, "OPENING DRIVE — every minute the rule is true")
stale_split(drive[drive.dir < 0], "OPENING DRIVE — PUTS only")
stale_split(drive[drive.dir > 0], "OPENING DRIVE — CALLS only")

# What the paper lane actually buys under the 9:45 hold: the first drive fire-minute >= 9:45
def first_of(g): return g.sort_values("min").groupby(["sym", "day", "dir"]).head(1)
live = first_of(drive[drive["min"] >= 585])
stale_split(live, "WHAT THE LANE BUYS NOW: first drive fire at/after 9:45")
first_any = first_of(drive)
stale_split(first_any, "first drive fire of the day (no 9:45 hold)")

print("\n--- CANDIDATE FIXES on 'first drive fire at/after 9:45' (the entry the lane takes) ---")
base = drive[drive["min"] >= 585]
line("today's rule", first_of(base))
for nm, mask in [("fix A: only ON a new extreme", base.minsSinceExtreme == 0),
                 ("fix B: extreme <=2 min old", base.minsSinceExtreme <= 2),
                 ("fix C: extreme <=5 min old", base.minsSinceExtreme <= 5),
                 ("fix D: within 0.15% of extreme", base.offExtremePct <= 0.15),
                 ("fix E: within 0.30% of extreme", base.offExtremePct <= 0.30),
                 ("fix F: <=5 min AND within 0.30%", (base.minsSinceExtreme <= 5) & (base.offExtremePct <= 0.30))]:
    kept = first_of(base[mask]); line(nm, kept)
    rej_keys = set(map(tuple, first_of(base)[["sym", "day", "dir"]].to_numpy())) - set(map(tuple, kept[["sym", "day", "dir"]].to_numpy()))
    rej = first_of(base); rej = rej[[tuple(x) in rej_keys for x in rej[["sym", "day", "dir"]].to_numpy()]]
    line("    ...trades this fix SKIPS entirely", rej)

print("\n--- does it hold across time? (first drive fire >= 9:45; fresh = extreme <=2 min old) ---")
for era, g in live.groupby("era"):
    line(f"{era} fresh", g[g.minsSinceExtreme <= 2]); line(f"{era} stale (>2 min)", g[g.minsSinceExtreme > 2])

print("\n--- index vs single names (first drive fire >= 9:45) ---")
idx = live.sym.isin(["SPY", "QQQ", "IWM", "GLD", "SLV", "DIA"])
line("index fresh", live[idx & (live.minsSinceExtreme <= 2)]); line("index stale", live[idx & (live.minsSinceExtreme > 2)])
line("singles fresh", live[~idx & (live.minsSinceExtreme <= 2)]); line("singles stale", live[~idx & (live.minsSinceExtreme > 2)])

for setup in ("opening_range", "trend_continuation"):
    g = first_of(fires[fires.setup == setup])
    stale_split(g, f"{setup.upper()} — first fire per name/side/day (does staleness matter here too?)")

print("\n--- by fire time, first fire per name/side/day, all setups ---")
ff = first_of(fires)
for lo, hi, nm in [(570, 585, "9:30-9:44"), (585, 600, "9:45-9:59"), (600, 630, "10:00-10:29"), (630, 690, "10:30-11:29"), (690, 780, "11:30-12:59"), (780, 886, "13:00-14:45")]:
    line(nm, ff[(ff["min"] >= lo) & (ff["min"] < hi)])
