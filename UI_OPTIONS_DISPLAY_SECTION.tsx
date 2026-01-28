// Add this section to display live options data in DashboardEnhanced.tsx
// Replace the existing options strategy display section (around line 579-614)

{hasOptionsStrategy && (
  <div className="mt-4 p-4 border rounded-lg bg-muted/30">
    <h4 className="font-bold text-md mb-3 flex items-center gap-2">
      <Sparkles className="h-4 w-4 text-primary" />
      AI-Generated Options Strategy
      {pred.optionsDataFetchedAt && (
        <span className="text-xs text-muted-foreground font-normal">
          (Updated: {new Date(pred.optionsDataFetchedAt).toLocaleString()})
        </span>
      )}
    </h4>

    {/* Live Market Data Section */}
    {pred.currentStockPrice && (
      <div className="mb-4 p-3 bg-primary/10 border border-primary/30 rounded-lg">
        <div className="font-semibold text-sm mb-2 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Live Market Data (via Tradier API)
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Stock Price</div>
            <div className="font-bold text-foreground">{pred.currentStockPrice}</div>
          </div>
          {pred.optionPremium && (
            <div>
              <div className="text-muted-foreground">Option Premium</div>
              <div className="font-bold text-foreground">{pred.optionPremium}</div>
              <div className="text-muted-foreground text-xs">
                (${(parseFloat(pred.optionPremium.replace('$', '')) * 100).toFixed(0)} per contract)
              </div>
            </div>
          )}
          {pred.breakEvenPrice && (
            <div>
              <div className="text-muted-foreground">Break-Even</div>
              <div className="font-bold text-foreground">{pred.breakEvenPrice}</div>
            </div>
          )}
          {pred.probabilityOfProfit !== null && pred.probabilityOfProfit !== undefined && (
            <div>
              <div className="text-muted-foreground">Prob. of Profit</div>
              <div className="font-bold text-green-600 dark:text-green-400">~{pred.probabilityOfProfit}%</div>
            </div>
          )}
          {pred.openInterest && (
            <div>
              <div className="text-muted-foreground">Open Interest</div>
              <div className="font-bold text-foreground">{pred.openInterest.toLocaleString()}</div>
            </div>
          )}
          {pred.impliedVolatility && (
            <div>
              <div className="text-muted-foreground">Implied Vol</div>
              <div className="font-bold text-foreground">{pred.impliedVolatility}</div>
            </div>
          )}
        </div>
        {pred.optionGreeks && pred.optionGreeks !== '{}' && (
          <div className="mt-3 pt-3 border-t border-primary/20">
            <div className="font-semibold text-xs mb-2">Greeks:</div>
            <div className="grid grid-cols-5 gap-2 text-xs">
              {(() => {
                try {
                  const greeks = JSON.parse(pred.optionGreeks);
                  return (
                    <>
                      {greeks.delta !== null && greeks.delta !== undefined && (
                        <div>
                          <div className="text-muted-foreground">Delta</div>
                          <div className="font-mono">{greeks.delta.toFixed(3)}</div>
                        </div>
                      )}
                      {greeks.theta !== null && greeks.theta !== undefined && (
                        <div>
                          <div className="text-muted-foreground">Theta</div>
                          <div className="font-mono">{greeks.theta.toFixed(3)}</div>
                        </div>
                      )}
                      {greeks.vega !== null && greeks.vega !== undefined && (
                        <div>
                          <div className="text-muted-foreground">Vega</div>
                          <div className="font-mono">{greeks.vega.toFixed(3)}</div>
                        </div>
                      )}
                      {greeks.gamma !== null && greeks.gamma !== undefined && (
                        <div>
                          <div className="text-muted-foreground">Gamma</div>
                          <div className="font-mono">{greeks.gamma.toFixed(4)}</div>
                        </div>
                      )}
                      {greeks.rho !== null && greeks.rho !== undefined && (
                        <div>
                          <div className="text-muted-foreground">Rho</div>
                          <div className="font-mono">{greeks.rho.toFixed(3)}</div>
                        </div>
                      )}
                    </>
                  );
                } catch (e) {
                  return null;
                }
              })()}
            </div>
          </div>
        )}
      </div>
    )}

    <div className="space-y-3 text-sm">
      <div>
        <div className="font-semibold text-muted-foreground">Strategy:</div>
        <p className="font-mono text-xs p-2 bg-background rounded">{pred.optionsStrategy}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="font-semibold text-muted-foreground">Strike Price:</div>
          <p className="font-mono text-xs p-2 bg-background rounded">{pred.suggestedStrike}</p>
        </div>
        <div>
          <div className="font-semibold text-muted-foreground">Expiration:</div>
          <p className="font-mono text-xs p-2 bg-background rounded">{pred.suggestedExpiration}</p>
        </div>
      </div>
      <div>
        <div className="font-semibold text-muted-foreground">Entry Plan:</div>
        <p className="font-mono text-xs p-2 bg-background rounded">{pred.entryStrategy}</p>
      </div>
      <div>
        <div className="font-semibold text-muted-foreground">Exit Plan:</div>
        <p className="font-mono text-xs p-2 bg-background rounded">{pred.exitStrategy}</p>
      </div>
      <div>
        <div className="font-semibold text-muted-foreground">Risk Assessment:</div>
        <p className="font-mono text-xs p-2 bg-background rounded">{pred.riskAssessment}</p>
      </div>
    </div>
  </div>
)}
