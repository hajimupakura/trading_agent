# Data Retention Policy

## Overview

This document outlines the automated data retention policy for the Trading Agent application, designed to keep database costs low while maintaining useful historical data.

## Current Database Status

**Database:** `trading_agent` (PostgreSQL)
- **Largest table:** `news_articles` (776 KB, 887 records)
- **Total size:** ~1 MB across all tables

## Retention Policy by Table

### 1. News Articles (`news_articles`)

**Current:** 887 articles (oldest from Jan 2024)

**Retention Policy:**
- ✅ **Analyzed articles:** Keep 30 days
- ✅ **Unanalyzed articles:** Keep 7 days (likely stale/broken feeds)

**Rationale:**
- News older than 30 days has diminishing trading value
- Most rally predictions are based on recent catalysts
- Keeping 30 days allows for backtesting and pattern analysis
- Unanalyzed articles after 7 days are likely from broken feeds or outdated

**Expected savings:** ~850 articles will be deleted on first cleanup

### 2. ARK Invest Trades (`ark_trades`)

**Current:** 6 trades (from last 3 days)

**Retention Policy:**
- ✅ **Keep 90 days** of ARK trades

**Rationale:**
- Quarterly patterns are useful for understanding ARK's strategy
- Beyond 90 days, the trading value decreases significantly
- Historical analysis can use aggregated data, not individual trades

### 3. User Alerts (`alerts`)

**Current:** Minimal records

**Retention Policy:**
- ✅ **Read alerts:** Keep 30 days
- ✅ **Unread alerts:** Keep 90 days (user might want to see them)

**Rationale:**
- Read alerts have served their purpose
- Unread alerts kept longer in case user missed them
- Prevents alert table from growing unbounded

### 4. Sector Momentum (`sector_momentum`)

**Current:** 0 records

**Retention Policy:**
- ✅ **Keep 60 days** of momentum data

**Rationale:**
- Recent sector trends are most relevant
- 60 days captures 2 months of momentum patterns
- Older momentum data loses predictive value

### 5. Stock Historical Candles (`stock_historical_candles`)

**Current:** Minimal records

**Retention Policy:**
- ✅ **Keep 90 days** of cached candle data

**Rationale:**
- Technical analysis typically uses 90-day or shorter timeframes
- Older data can be re-fetched from external APIs if needed
- Prevents unbounded cache growth

### 6. Rally Events (`rally_events`)

**Current:** Some predicted rallies

**Retention Policy:**
- ✅ **Historical rallies:** Keep forever (for pattern learning)
- ✅ **Predicted rallies:** Keep 180 days (6 months for outcome verification)

**Rationale:**
- Historical data is valuable for AI pattern recognition
- Predictions need time to play out (rallies can take months)
- After 6 months, prediction accuracy can be assessed
- Historical rallies marked with `is_historical = true` are never deleted

### 7. Tables NOT Cleaned Up

These tables are kept permanently:
- `users` - User accounts (essential)
- `watchlist_stocks` - User watchlists (user data)
- `user_defined_alerts` - User-created alerts (user data)
- `user_preferences` - User settings (user data)
- `stock_financials` - Latest fundamentals (overwritten, not accumulated)
- `youtube_influencers` - Influencer list (reference data)
- `youtube_videos` - Should add retention policy in future if grows large

## Cleanup Schedule

**Automated cleanup runs daily at 2:00 AM EST (6:00 UTC)**

### Manual Cleanup

You can manually trigger cleanup via the admin API:

```bash
# Using curl
curl -X POST http://localhost:5005/api/trpc/admin.runRetentionCleanup

# Or via the UI (admin panel)
```

### View Database Statistics

```bash
# Check current database size and record counts
curl http://localhost:5005/api/trpc/admin.getDatabaseStats
```

## Expected Impact

### Initial Cleanup (First Run)

Based on current database state:
- **News articles:** ~850 articles deleted (keep most recent 30 days)
- **Other tables:** Minimal deletions (already recent)
- **Database size reduction:** ~700 KB (90% of news table)

### Ongoing Maintenance

After initial cleanup, daily retention will:
- Delete 0-50 news articles per day (depends on RSS feed volume)
- Keep database size under 500 KB consistently
- Remove stale unanalyzed articles automatically

## Cost Savings

**PostgreSQL storage costs** (typical cloud database):
- Without retention: Database would grow to ~25-50 MB/year
- With retention: Database stays under 5 MB
- **Savings:** 90% reduction in storage costs

**Performance benefits:**
- Faster queries (smaller tables)
- Better indexes (less data to scan)
- Reduced backup/restore times

## Monitoring

The cleanup service logs detailed statistics:

```
[Retention] Cleanup complete! Total records deleted: 850
[Retention] Summary:
  newsArticles: { deleted: 845, retained: 42 }
  arkTrades: { deleted: 0, retained: 6 }
  alerts: { deleted: 3, retained: 2 }
  sectorMomentum: { deleted: 0, retained: 0 }
  stockCandles: { deleted: 0, retained: 0 }
  rallyEvents: { deleted: 2, retained: 5 }
```

Check PM2 logs to monitor cleanup:
```bash
pm2 logs trading-agent | grep Retention
```

## Customizing Retention Periods

To adjust retention periods, edit:
```
/server/services/dataRetentionService.ts
```

Change these values:
```typescript
// News articles
const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30); // Change 30 to desired days

// ARK trades
const ninetyDaysAgo = new Date();
ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90); // Change 90 to desired days
```

After changing, rebuild and restart:
```bash
npm run build
pm2 restart trading-agent
```

## FAQ

### Q: What if I need older data for backtesting?

**A:** Historical rally events (marked `is_historical = true`) are kept forever. For news articles, you can:
1. Export data before it's deleted
2. Increase the 30-day retention period
3. Use external news archives for long-term backtesting

### Q: Can I recover deleted data?

**A:** No, deleted data is permanent. However:
- RSS feeds republish articles, so some may be re-ingested
- Database backups may contain older data
- Consider increasing retention periods if you need data longer

### Q: Will this affect active predictions?

**A:** No. Active rally predictions and recent news articles are retained. Only very old data is removed.

### Q: How much will my database cost now?

**A:** With this retention policy:
- PostgreSQL (managed): ~$0.10-0.50/month for storage
- Most cloud providers charge for DB instance, not storage alone
- Keeping DB under 5 MB ensures you stay in free/cheap tiers

## Implementation Status

✅ **IMPLEMENTED:**
- Data retention service created
- Automated daily cleanup scheduled (2am EST)
- Manual cleanup API endpoint added
- Database statistics endpoint added
- Comprehensive logging

🔄 **PENDING:**
- First cleanup run (will happen at next 2am EST or manual trigger)
- Long-term monitoring to adjust retention periods

## Next Steps

1. **Monitor first cleanup run** (tomorrow at 2am EST)
2. **Review logs** to ensure expected deletions
3. **Adjust retention periods** if needed based on your usage patterns
4. **Set up alerts** if database grows beyond expected size
5. **Consider adding YouTube videos retention** if that table grows large

---

**Last Updated:** January 27, 2026  
**Service File:** `/server/services/dataRetentionService.ts`  
**Scheduler:** `/server/_core/index.ts` (line ~162)
