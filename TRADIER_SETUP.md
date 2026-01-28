# Tradier Options Integration - Setup Guide

## What Was Implemented

### 1. Tradier Service (server/services/tradierService.ts)
- Real-time stock quotes
- Options chains with Greeks
- Liquidity filtering
- Probability calculations

### 2. Enhanced AI Recommendations
- Uses LIVE Tradier data
- Validates strikes/expirations
- Smart contract selection

### 3. Database Schema Updates
Added 8 new fields:
- option_premium
- option_greeks
- current_stock_price
- break_even_price
- probability_of_profit
- open_interest
- implied_volatility
- options_data_fetched_at

## Setup Steps

### 1. Get Tradier API Key
- Sign up at https://tradier.com
- Get API key from dashboard
- Choose sandbox (free) or production ($10/month)

### 2. Configure .env
```bash
TRADIER_API_KEY="your_key_here"
TRADIER_API_URL="https://sandbox.tradier.com/v1/markets"
```

### 3. Run Migration
```bash
psql -h localhost -p 5434 -U buildzim_user -d trading_agent -f drizzle/0004_add_live_options_data.sql
```

### 4. Rebuild & Restart
```bash
pnpm run build
pm2 restart trading-agent
```

## How It Works

When you click "Generate Options Strategy":
1. Fetches live data from Tradier
2. Selects best contract based on confidence
3. Calculates all metrics (premium, Greeks, probability)
4. AI generates strategy with REAL numbers
5. Saves everything to database

## You're Done!
