# Research bench — the 2026-11-24 program, reproducible

The analysis code behind everything validated (and rejected) on 2026-11-24. The big
corpus CSVs are NOT here — they are regenerable from the cloud, which is the point:

1. Raw tapes live permanently in Supabase `research_requests` (jsonb results).
2. Queue an `ml-export` request (params `{"sourceKind": "ml-corpus" | "ml-swing" | "ml-lottery"}`,
   with `dayGte`/`dayLt` windows for oversized corpora) — the cron writes CSVs to the
   public `research` storage bucket. ALWAYS reconcile exported position counts against
   `sum(jsonb_array_length(result))` before trusting an export.
3. `curl` them next to these scripts as `corpus.csv`, `swing.csv` (concatenate windowed
   parts with a `printf '\n'` between files — exports lack trailing newlines), `lottery.csv`.
4. Scan features: see `play_selector.py` header — pullback-scan rows exported as
   `scanfeat/*.psv` (`day|sym|dir|legPct|fireMin|heldVwap|volumeFading|retracePct|secondLeg`).

Pipeline per model: train in sklearn here → `export_models.py` dumps JSON tree arrays
plus 40 sklearn check probabilities → the TS predictor (`histgbt.ts` in both apps)
must reproduce them to 1e-6 (asserted in worker tests; the detector module refuses to
score on drift). Deployment is just `git push` — models ride the repo.

| Script | What it is | Verdict it produced |
|---|---|---|
| prep_exit / train_tree / check_tree / check_hybrid | exit-advisor tournament | HYBRID shipped (30-35% capture vs V0 19.3%) |
| prep_nets / run_nets | LSTM/TCN contenders (two-process: torch+sklearn segfault together on this Mac) | rejected, revisit at 5-10x data |
| swarm_analysis | 22-month far-OTM ladder study | convexity sleeve parameters |
| lottery_census | penny-contract census | 129 >=10x / 45 >=25x / 21 >=50x on 63 days |
| lottery_detector(_v2) | day-level armed-day detector | by11-v2 shipped (advisory + swarm budget) |
| surge_detector | per-surge 10x detector | REJECTED (AUC 0.558, non-monotone EV) |
| play_selector | best-arm selector (capstone) | REJECTED (loses to always-near-money) |
| news_shock_study | overnight shock vs lottery days | "government-on-a-name" puts asymmetry |
| export_models | sklearn -> JSON for production | — |
| make_* | reportlab PDFs + architecture diagram | research-reports/ (local-only) |

Small inputs committed here: `events.csv` (verified macro/earnings calendar, also in
the `market_events` table), `news_scores_*.json` (LLM-scored 2026 mornings),
`day_features.csv` (per-day fire shape). Python deps: numpy, scikit-learn 1.5,
reportlab, matplotlib; torch CPU only for the nets scripts.
