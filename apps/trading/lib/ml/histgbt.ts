// Minimal predictor for sklearn HistGradientBoostingClassifier models exported to
// JSON (scratchpad ml/export_models.py). Node layout per tree node:
//   [featureIdx, numThreshold, left, right, value, isLeaf, missingGoesLeft]
// raw score = baseline + sum of leaf values; probability = sigmoid(raw). The JSON
// carries `checks` (feature vectors + sklearn's predict_proba) that the test suite
// asserts to 1e-6, so a port drift fails loudly instead of mis-scoring silently.
export type HistGbtModel = {
  version: number;
  feats: string[];
  baseline: number;
  threshold: number;
  trees: number[][][];
  checks?: Array<{ x: number[]; p: number }>;
};

export function predictProba(model: HistGbtModel, x: number[]): number {
  let raw = model.baseline;
  for (const tree of model.trees) {
    let idx = 0;
    while (!tree[idx][5]) {
      const node = tree[idx];
      const value = x[node[0]];
      idx = Number.isNaN(value) ? (node[6] ? node[2] : node[3]) : value <= node[1] ? node[2] : node[3];
    }
    raw += tree[idx][4];
  }
  return 1 / (1 + Math.exp(-raw));
}
